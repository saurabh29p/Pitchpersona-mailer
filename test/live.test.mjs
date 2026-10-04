// A real (not dry-run) pass against local mock mail servers and a mock OpenRouter, so the
// nodemailer and imapflow code paths run for real: sending, STARTTLS, recipient and spam
// rejections, auto-pause, reading a reply over IMAP, and a rejected password.
// Needs `openssl` to make a throwaway certificate; skips without it.
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { startEngine, client, checker, sleep } from "./helpers.mjs";
import { startMocks } from "./mocks.mjs";

const certDir = fs.mkdtempSync(path.join(os.tmpdir(), "mailer-cert-"));
try {
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", `${certDir}/key.pem`, "-out", `${certDir}/cert.pem`, "-days", "1", "-subj", "/CN=localhost"], { stdio: "ignore" });
} catch { console.log("SKIP live test: openssl is not installed"); process.exit(0); }
const mocks = await startMocks({ key: fs.readFileSync(`${certDir}/key.pem`), cert: fs.readFileSync(`${certDir}/cert.pem`) });
// The mock servers use a self-signed certificate, so this test engine skips certificate checks.
const engine = await startEngine({ PANEL_PASSWORD: "livepass", NODE_TLS_REJECT_UNAUTHORIZED: "0", OPENROUTER_BASE_URL: mocks.aiUrl });
const db = new DatabaseSync(engine.dbPath);
const { api, waitIdle, runNow } = client(engine.url);
const { ok, done } = checker("real send");
const received = async () => mocks.received;
const commands = async () => mocks.commands;
const backdate = () => db.prepare("UPDATE messages SET sent_at = ?").run(new Date(Date.now() - 86400000).toISOString());
const day = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
try {
const login = await api("/api/login", "POST", { password: "livepass" }, { "x-forwarded-host": "mailer.test", "x-forwarded-proto": "https" });
// The panel is opened on mailer.test, but links in campaign emails must use the link address on a sending domain.
ok((await api("/api/settings", "PUT", { requireDns: false, aiEnabled: true, openrouterKey: "sk-or-test", timezone: "UTC", linkUrl: "https://go.getpitchpersona.test/" })).status === 200, "settings saved");
const mk = (email, role, password = "good-pass", name = "Saurabh Singh") => api("/api/inboxes", "POST", { email, role, password, name, provider: "custom",
  smtp_host: "127.0.0.1", smtp_port: mocks.smtpPort, imap_host: "127.0.0.1", imap_port: mocks.imapPort, start_date: day(30) });
const A = (await mk("a@getpitchpersona.test", "sender")).body.id;
const S = (await mk("seed@seedmail.test", "seed", "good-pass", "Seed Box")).body.id;
const t1 = await api(`/api/inboxes/${A}/test`, "POST", {});
ok(t1.body.smtp === "ok" && t1.body.imap === "ok", "Test login passes for a good inbox", JSON.stringify(t1.body));
const W = (await mk("w@getpitchpersona.test", "sender", "wrong-password")).body.id;
const t2 = await api(`/api/inboxes/${W}/test`, "POST", {});
ok(t2.body.smtp !== "ok" && t2.body.imap !== "ok", "Test login reports a wrong password on both", JSON.stringify(t2.body).slice(0, 160));
const logins = Object.fromEntries((await api("/api/state")).body.inboxes.map((i) => [i.id, i.login]));
ok(logins[A] === "ok" && logins[W] === "failed" && logins[S] === null, "the panel shows each login as works, failed or not tested", JSON.stringify(logins));
await api(`/api/inboxes/${W}`, "DELETE");

const ai = await api("/api/ai-test", "POST", {});
ok(ai.status === 200 && !/https?:|www\.|—/.test(ai.body.body), "AI test email comes back with links and em dashes stripped", JSON.stringify(ai.body).slice(0, 140));

// 20 warm-up emails landed in the inbox over the last days, so this inbox qualifies for cold email.
for (let k = 0; k < 20; k++) {
  db.prepare("INSERT INTO sent VALUES (?,?,?,?,?,?,?,?,?)").run(`<w${k}@x>`, "a@getpitchpersona.test", "seed@seedmail.test", "s", "b", `<w${k}@x>`, 0, new Date(Date.now() - 2 * 86400000).toISOString(), day(2));
  db.prepare("INSERT INTO seen VALUES (?,?,?,?,?,?)").run(`<w${k}@x>`, "seed@seedmail.test", "inbox", 0, new Date().toISOString(), day(1));
}
const camp = (await api("/api/campaigns", "POST", { name: "Live test", preset: "blank" })).body.id;
ok((await api(`/api/campaigns/${camp}`, "PUT", { review: false, start_hour: 0, end_hour: 24, days: "1234567", track_clicks: true, sender_ids: [A],
  steps: [{ subject: "Quick question, {{first_name}}", body: "Hi {{first_name}},\n\nTesting the engine. More at https://example.com/page" }, { delay_days: 3, body: "Bumping this, {{first_name}}." }] })).status === 200, "campaign configured");
for (const [email, first_name] of [["ok@example.com", "Okay"], ["ghost@example.com", "Gus"], ["spamtrap@example.com", "Sam"]]) {
  await api(`/api/campaigns/${camp}/leads`, "POST", { leads: [{ email, first_name, name: first_name + " Person" }] }); await sleep(30);
}
const elig = (await api("/api/campaigns")).body.eligibility.find((e) => e.id === A);
ok(elig.ok, "inbox is eligible for cold email (day 31, placement 100%)", JSON.stringify(elig));
await api(`/api/campaigns/${camp}/status`, "POST", { status: "active" });
await api("/api/pause", "POST", { paused: false });
await sleep(300); await waitIdle();
await runNow();

let mail = (await received()).find((m) => m.to.includes("ok@example.com"));
ok(!!mail, "campaign email delivered over SMTP");
if (mail) mail.raw = mail.raw.replace(/\r?\n[ \t]+/g, " ").replace(/=\r?\n/g, "").replace(/=3D/g, "=");   // unfold headers, decode quoted-printable
if (mail) {
  ok(/^From: "?Saurabh Singh"? <a@getpitchpersona\.test>/m.test(mail.raw), "From shows the sender name");
  ok(/^Subject: Quick question, Okay/m.test(mail.raw), "subject rendered");
  ok(/^List-Unsubscribe: <https:\/\/go\.getpitchpersona\.test\/u\/[A-Za-z0-9_-]+>, <mailto:a@getpitchpersona\.test\?subject=unsubscribe>/m.test(mail.raw), "List-Unsubscribe uses the link address, not the panel's, plus a mailto");
  ok(/^List-Unsubscribe-Post: List-Unsubscribe=One-Click/m.test(mail.raw), "one-click unsubscribe header");
  ok(/https:\/\/go\.getpitchpersona\.test\/c\/[A-Za-z0-9_-]+\?u=https%3A%2F%2Fexample\.com%2Fpage/.test(mail.raw) && !/mailer\.test/.test(mail.raw), "link rewritten for click tracking on the link address");
  ok(!/text\/html/i.test(mail.raw), "plain text only (open tracking off)");
}
const warm = (await received()).find((m) => m.to.includes("seed@seedmail.test"));
ok(!!warm && /Q4 planning doc/.test(warm.raw) && !/www\.example\.com/.test(warm.raw), "warm-up email written by the AI, sent, links stripped");

backdate(); await runNow();
const dom = (await api("/api/state")).body.domains.find((d) => d.domain === "getpitchpersona.test");
ok(dom?.signing?.result === "pass", "DKIM signing is read from the headers of a received warm-up email", JSON.stringify(dom?.signing));
let L = Object.fromEntries(db.prepare("SELECT email, status, attempts, error FROM leads").all().map((r) => [r.email, r]));
ok(L["ghost@example.com"].status === "bounced", "address rejected at send time marked bounced", JSON.stringify(L["ghost@example.com"]));
ok(!!db.prepare("SELECT 1 FROM suppression WHERE email='ghost@example.com'").get(), "rejected address suppressed");
ok(db.prepare("SELECT paused FROM inboxes WHERE id=?").get(A).paused === 0, "a bad address does not pause the inbox");

backdate(); await runNow();
const inbox = db.prepare("SELECT paused, pause_reason FROM inboxes WHERE id=?").get(A);
ok(inbox.paused === 1 && /refused/.test(inbox.pause_reason), "spam rejection pauses the inbox", inbox.pause_reason);
L = Object.fromEntries(db.prepare("SELECT email, status, attempts, error FROM leads").all().map((r) => [r.email, r]));
ok(L["spamtrap@example.com"].status === "queued" && L["spamtrap@example.com"].attempts === 1, "that lead stays queued for a retry", JSON.stringify(L["spamtrap@example.com"]));

// The prospect replies; the paused inbox still reads it.
const sentMid = db.prepare("SELECT message_id FROM messages WHERE recipient='ok@example.com'").get().message_id;
mocks.deliver("a@getpitchpersona.test",
  `From: Okay Person <ok@example.com>\r\nTo: a@getpitchpersona.test\r\nSubject: Re: Quick question, Okay\r\nMessage-ID: <reply1@example.com>\r\nIn-Reply-To: ${sentMid}\r\nReferences: ${sentMid}\r\nDate: Sun, 04 Oct 2026 12:00:00 +0000\r\nContent-Type: text/plain\r\n\r\nSounds good, call me Tuesday.\r\n\r\nOn Sun, Oct 4 Saurabh wrote:\r\n> Hi Okay\r\n`);
await runNow();
L = Object.fromEntries(db.prepare("SELECT email, status FROM leads").all().map((r) => [r.email, r]));
ok(L["ok@example.com"].status === "replied", "reply read over IMAP stops the lead (paused inboxes still read)");
const rep = (await api("/api/replies")).body.find((r) => r.from_email === "ok@example.com");
ok(rep?.kind === "reply" && rep.snippet === "Sounds good, call me Tuesday.", "reply listed with a clean snippet", rep?.snippet);

// A rejected password pauses reading, and isn't retried until a new one is saved.
await api(`/api/inboxes/${S}`, "PUT", { password: "wrong-password" });
await runNow();
ok(/rejected the app password/.test(db.prepare("SELECT pause_reason FROM inboxes WHERE id=?").get(S).pause_reason || ""), "rejected IMAP password pauses the inbox");
ok((await api("/api/state")).body.inboxes.find((i) => i.id === S).login === "failed", "...and marks its login as failed");
const before = (await commands()).filter((c) => /^LOGIN/.test(c)).length;
await runNow();
const afterN = (await commands()).filter((c) => /^LOGIN/.test(c)).length;
const others = db.prepare("SELECT COUNT(*) c FROM inboxes WHERE password_enc != '' AND NOT (paused = 1 AND pause_reason LIKE 'the mailbox rejected%')").get().c;
ok(afterN - before === others, "no further login attempts with the rejected password", `${afterN - before} logins, ${others} other inboxes`);
await api(`/api/inboxes/${S}`, "PUT", { password: "good-pass" });
ok(/New app password saved/.test(db.prepare("SELECT pause_reason FROM inboxes WHERE id=?").get(S).pause_reason), "saving a new password lets it try again");
ok((await api("/api/state")).body.inboxes.find((i) => i.id === S).login === null, "a new password resets the login to not tested");

const errs = db.prepare("SELECT at, inbox, message FROM events WHERE level='error'").all();
console.log("error events:", errs.map((e) => `${e.inbox}: ${e.message}`));
ok(!errs.some((e) => /Unexpected|Cycle failed|scan .* failed|deadlock/i.test(e.message)), "no unexpected errors or failed scans");
} catch (e) { ok(false, "test crashed: " + e.stack); console.log(engine.log().slice(-2000)); }
finally { engine.stop(); mocks.close(); fs.rmSync(certDir, { recursive: true, force: true }); }
process.exit(done() ? 1 : 0);
