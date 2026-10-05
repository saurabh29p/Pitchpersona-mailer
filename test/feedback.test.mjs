// The panel tells you what's happening: each failed login gets a reason and a fix, a mail
// server this host can't reach (Railway blocks SMTP below its Pro plan) is named once and
// blocks Start with that reason, logins are re-tested by themselves once it connects, and
// every cycle leaves a summary that says what it did or why it sent nothing.
// Needs `openssl` for the mock mail servers' certificate; the engine parts skip without it.
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import net from "node:net";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { startEngine, client, checker, sleep, freePort } from "./helpers.mjs";
import { startMocks } from "./mocks.mjs";
import { explainMailError } from "../src/explain.mjs";

const { ok, done } = checker("feedback");

// ── What real Gmail and Railway failures read as ──
const gmail = { email: "sender@example.com", provider: "google", smtp_host: "smtp.gmail.com", smtp_port: 465, imap_host: "imap.gmail.com", imap_port: 993 };
const ex = (kind, raw, opts) => explainMailError(kind, raw, gmail, opts) || {};
let x = ex("smtp", "Connection timeout (ETIMEDOUT)", { onRailway: true });
ok(x.code === "smtp_blocked" && /Railway/.test(x.why) && /Pro plan/.test(x.fix), "a sending timeout on Railway is explained as Railway blocking SMTP, with the upgrade as the fix", JSON.stringify(x));
x = ex("smtp", "Connection timeout (ETIMEDOUT)");
ok(x.code === "smtp_blocked" && !/Railway/.test(x.why + x.fix) && /port 465/.test(x.why), "...and elsewhere as a blocked connection, without blaming Railway", JSON.stringify(x));
ok(ex("smtp", "Greeting never received (ETIMEDOUT)", { onRailway: true }).code === "smtp_blocked" && ex("smtp", "Greeting never received (ETIMEDOUT)").code === "no_greeting",
  "a missing greeting counts as blocked on Railway, and as the wrong port elsewhere");
x = ex("smtp", "Invalid login: 535-5.7.8 Username and Password not accepted. For more information, go to 535 5.7.8 https://support.google.com/mail/?p=BadCredentials (EAUTH)");
ok(x.code === "bad_password" && /apppasswords/.test(x.fix) && /sender@example\.com/.test(x.fix), "Google's 535 says to make a new app password while signed in as that inbox", JSON.stringify(x));
ok(ex("imap", "[AUTHENTICATIONFAILED] Invalid credentials (Failure)").code === "bad_password", "a rejected IMAP login is a wrong app password too");
ok(ex("smtp", "Invalid login: 534-5.7.9 Application-specific password required. (EAUTH)").code === "app_password_required", "534 5.7.9 asks for an app password instead of the normal one");
ok(ex("smtp", "Invalid login: 534-5.7.14 <https://accounts.google.com/signin/continue> Please log in via your web browser and then try again.").code === "web_login", "5.7.14 asks for a browser sign-in");
x = ex("imap", "[ALERT] Your account is not enabled for IMAP use. Please visit your Gmail settings page and enable your account for IMAP access. (Failure)");
ok(x.code === "imap_off" && /End User Access/.test(x.fix), "IMAP switched off says where to turn it on in Google Admin", JSON.stringify(x));
ok(ex("smtp", "getaddrinfo ENOTFOUND smtp.gmial.com (EDNS)").code === "host", "a misspelt server name says the name wasn't found");
ok(ex("smtp", "Invalid login: 454 4.7.0 Too many login attempts, please try again later.").code === "throttled", "too many attempts says to wait");
ok(ex("imap", "the mail server didn't finish within 60 seconds, so this cycle skipped it").code === "slow", "a stalled server is called temporary");
ok(ex("smtp", "self signed certificate in certificate chain (SELF_SIGNED_CERT_IN_CHAIN)").code === "tls", "a certificate error points at the port and provider");
ok(explainMailError("smtp", "ok", gmail) === null && explainMailError("smtp", null, gmail) === null, "a passing or untested side has nothing to explain");

// ── On "Railway", with its sending port blocked ──
const certDir = fs.mkdtempSync(path.join(os.tmpdir(), "mailer-cert-"));
let haveCert = true;
try {
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", `${certDir}/key.pem`, "-out", `${certDir}/cert.pem`, "-days", "1", "-subj", "/CN=localhost"], { stdio: "ignore" });
} catch { haveCert = false; console.log("SKIP engine checks: openssl is not installed"); }

if (haveCert) {
  const mocks = await startMocks({ key: fs.readFileSync(`${certDir}/key.pem`), cert: fs.readFileSync(`${certDir}/cert.pem`) });
  const BLOCKED = await freePort();      // nothing listens here until the "upgrade"
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mailer-test-"));
  const env = { PANEL_PASSWORD: "pw", NODE_TLS_REJECT_UNAUTHORIZED: "0", RAILWAY_ENVIRONMENT: "production", RAILWAY_VOLUME_MOUNT_PATH: dataDir };
  const e = await startEngine(env, { dataDir });
  let proxy = null, e2 = null;
  try {
    const { api, waitIdle, runNow } = client(e.url); await api("/api/login", "POST", { password: "pw" });
    await api("/api/settings", "PUT", { requireDns: false, startHour: 0, endHour: 24, timezone: "UTC" });
    const mk = (email, role, smtpPort, password = "good-pass") => api("/api/inboxes", "POST", { email, role, provider: "custom", password,
      smtp_host: "127.0.0.1", smtp_port: smtpPort, imap_host: "127.0.0.1", imap_port: mocks.imapPort });
    const A = (await mk("one@trypitchpersona.test", "sender", BLOCKED)).body.id;
    const H = (await mk("two@getpitchpersona.test", "sender", BLOCKED)).body.id;
    const W = (await mk("seed@seedmail.test", "seed", mocks.smtpPort, "wrong-password")).body.id;

    const t0 = Date.now();
    const t = (await api(`/api/inboxes/${A}/test`, "POST", {})).body;
    ok(!t.ok && t.detail.smtp.code === "smtp_blocked" && /Railway/.test(t.detail.smtp.why) && t.detail.imap.ok && Date.now() - t0 < 8000,
      "Test login names the blocked sending port at once, and reading still passes", JSON.stringify(t).slice(0, 300));
    await api(`/api/inboxes/${H}/test`, "POST", {});
    const w = (await api(`/api/inboxes/${W}/test`, "POST", {})).body;
    ok(w.detail.smtp.code === "bad_password" && w.detail.imap.code === "bad_password", "a wrong password is explained as one on both sides", JSON.stringify(w.detail).slice(0, 200));

    let st = (await api("/api/state")).body;
    const a = st.inboxes.find((i) => i.id === A);
    ok(a.login === "failed" && a.loginDetail.smtp.code === "smtp_blocked" && /Can't connect to 127\.0\.0\.1/.test(a.blocked) && /Railway/.test(a.blocked),
      "the inbox shows as blocked, saying it can't connect and why", JSON.stringify({ blocked: a.blocked, d: a.loginDetail }).slice(0, 300));
    ok(st.network.onRailway && st.network.results.some((r) => r.kind === "smtp" && !r.ok && r.port === BLOCKED), "the panel gets the failed connection check", JSON.stringify(st.network));
    ok(/Railway is blocking outgoing email/.test(st.readiness.startBlock || ""), "Start says Railway is blocking email instead of claiming to run", st.readiness.startBlock);
    const start = await api("/api/pause", "POST", { paused: false });
    ok(start.status === 400 && /Pro plan/.test(start.body.error), "...and pressing Start is refused with the fix", JSON.stringify(start.body));

    // The plan is upgraded: the port now connects.
    proxy = net.createServer((c) => { const u = net.connect(mocks.smtpPort, "127.0.0.1"); c.pipe(u).pipe(c); c.on("error", () => {}); u.on("error", () => {}); });
    await new Promise((r) => proxy.listen(BLOCKED, "127.0.0.1", r));
    const nc = (await api("/api/net-check", "POST", {})).body;
    ok(nc.results.every((r) => r.ok), "Re-check connection sees every mail server connect", JSON.stringify(nc));
    let logins = {};
    for (let k = 0; k < 50; k++) {
      st = (await api("/api/state")).body; logins = Object.fromEntries(st.inboxes.map((i) => [i.id, i.login]));
      if (logins[A] === "ok" && logins[H] === "ok") break; await sleep(200);
    }
    ok(logins[A] === "ok" && logins[H] === "ok", "logins that failed only on the connection are tested again by themselves", JSON.stringify(logins));
    ok(logins[W] === "failed", "...but a wrong password is left for you to fix, so the account isn't locked by retries", JSON.stringify(logins));
    ok(!st.readiness.startBlock && (await api("/api/pause", "POST", { paused: false })).status === 200, "Start works once it connects");

    // Every cycle leaves a summary.
    await sleep(300); await waitIdle();
    await runNow();
    const s1 = (await api("/api/status")).body.scheduler;
    ok(s1.lastCycle && s1.lastCycle.sent >= 1 && s1.lastCycle.finishedAt >= s1.lastCycle.startedAt && s1.lastCycle.note === null,
      "after Run a cycle now, the status says how many emails it sent", JSON.stringify(s1.lastCycle));
    ok(!s1.running && s1.phase === null && s1.nextTickAt, "...and that nothing runs now, with the next cycle's time", JSON.stringify(s1));
    const h = new Date().getUTCHours();
    await api("/api/settings", "PUT", h < 22 ? { startHour: h + 1, endHour: h + 2 } : { startHour: 0, endHour: 1 });
    await api("/api/pause", "POST", { paused: true }); await api("/api/pause", "POST", { paused: false });
    await sleep(300); await waitIdle();
    const s2 = (await api("/api/status")).body.scheduler.lastCycle;
    ok(s2.sent === 0 && /outside sending hours/.test(s2.note || ""), "a cycle outside working hours says that's why it sent nothing", JSON.stringify(s2));

    // Railway opens the email ports on the next deploy after an upgrade. A login that failed on
    // the connection is tested again when the mailer starts, with nobody pressing anything.
    await e.exit();
    const db = new DatabaseSync(e.dbPath);
    db.prepare("UPDATE inboxes SET login_ok = 0, login_smtp = ? WHERE id = ?").run("Connection timeout (ETIMEDOUT)", A);
    db.close();
    e2 = await startEngine(env, { dataDir });
    const c2 = client(e2.url); await c2.api("/api/login", "POST", { password: "pw" });
    let la = null;
    for (let k = 0; k < 50 && la !== "ok"; k++) { await sleep(200); la = (await c2.api("/api/state")).body.inboxes.find((i) => i.id === A).login; }
    ok(la === "ok", "after a redeploy, a login that failed on the connection passes again by itself", String(la));
  } finally { e.stop(); e2?.stop(); proxy?.close(); mocks.close(); }
}
fs.rmSync(certDir, { recursive: true, force: true });

process.exit(done() ? 1 : 0);
