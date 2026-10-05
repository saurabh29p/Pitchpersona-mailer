// Google sign-in: one service-account key signs in to every Workspace inbox. Sending goes through
// the Gmail API, so a host that blocks email ports (Railway below Pro) doesn't matter, and reading
// uses IMAP with the same token. Each setup mistake gets its own fix, a refused sign-in is tried
// again by itself, and the Message-ID Gmail gives each email is the one replies are matched on.
// Needs `openssl` for the mock mail servers' certificate; the engine parts skip without it.
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { startEngine, client, checker, sleep, freePort } from "./helpers.mjs";
import { startMocks } from "./mocks.mjs";
import { explainMailError } from "../src/explain.mjs";
import { parseServiceAccount } from "../src/google.mjs";

const { ok, done } = checker("google");

// ── What each Google refusal reads as ──
const gin = { email: "one@trypitchpersona.test", provider: "google", signin: "google", smtp_host: "smtp.gmail.com", smtp_port: 465, imap_host: "imap.gmail.com", imap_port: 993 };
const acct = { clientId: "1234567890", projectId: "mailer-test" };
const ex = (kind, raw, o = {}) => explainMailError(kind, raw, gin, { google: acct, ...o }) || {};
let x = ex("smtp", "Google sign-in refused: unauthorized_client: Client is unauthorized to retrieve access tokens using this method, or client not authorized for any of the scopes requested.");
ok(x.code === "google_delegation" && /Client ID 1234567890/.test(x.fix) && /https:\/\/mail\.google\.com\//.test(x.fix) && /Domain Wide Delegation/.test(x.fix) && /trypitchpersona\.test/.test(x.fix),
  "a missing delegation says where in Google Admin to allow it, with the client ID and scope", JSON.stringify(x));
x = ex("smtp", "Gmail API 403 accessNotConfigured: Gmail API has not been used in project 1234567890 before or it is disabled.");
ok(x.code === "api_off" && /gmail\.googleapis\.com\?project=mailer-test/.test(x.fix), "the Gmail API switched off links straight to its Enable page", JSON.stringify(x));
ok(ex("smtp", "Google sign-in refused: invalid_grant: Invalid email or User ID").code === "google_user", "an address that isn't a Workspace user says so");
ok(ex("smtp", "Google sign-in refused: invalid_grant: Invalid JWT Signature.").code === "google_key", "a deleted key says to make a new one");
ok(ex("smtp", "Gmail API 400 failedPrecondition: Precondition check failed.").code === "gmail_off", "a mailbox without Gmail says to check its licence");
x = ex("smtp", "connect ECONNREFUSED gmail.googleapis.com:443 (ECONNREFUSED)", { onRailway: true });
ok(x.code === "api_blocked" && !/Railway/.test(x.why + x.fix), "an unreachable Gmail API isn't blamed on Railway's email block", JSON.stringify(x));
ok(ex("imap", "[AUTHENTICATIONFAILED] Invalid credentials (Failure)").code === "google_imap", "a refused IMAP sign-in points at IMAP access, not at an app password");
ok(ex("smtp", "Gmail API 429 rateLimitExceeded: User-rate limit exceeded.").code === "throttled", "Google's sending limit says to wait");
x = explainMailError("smtp", "Connection timeout (ETIMEDOUT)", { ...gin, signin: "password" }, { onRailway: true });
ok(x.code === "smtp_blocked" && /Google sign-in/.test(x.fix) && /Pro plan/.test(x.fix), "Railway's SMTP block now offers Google sign-in first for a Google inbox", x.fix);

// ── Reading the key file ──
const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const sa = { type: "service_account", project_id: "mailer-test", private_key_id: "k1", private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
  client_email: "mailer@mailer-test.iam.gserviceaccount.com", client_id: "1234567890" };
const refuses = (v, re) => { try { parseServiceAccount(v); return false; } catch (e) { return re.test(e.message); } };
ok(refuses("not json", /isn't a key file/), "text that isn't JSON is refused in words");
ok(refuses(JSON.stringify({ type: "authorized_user", client_id: "x" }), /isn't a service-account key/), "an OAuth client or user file is refused, with where to get the right one");
ok(refuses(JSON.stringify({ ...sa, private_key: "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n" }), /damaged/), "a damaged private key is caught on save");
ok(parseServiceAccount(JSON.stringify(sa)).client_id === "1234567890", "a real key file is accepted");

// ── Against mock Google and mail servers, on "Railway" with SMTP blocked ──
const certDir = fs.mkdtempSync(path.join(os.tmpdir(), "mailer-cert-"));
let haveCert = true;
try {
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", `${certDir}/key.pem`, "-out", `${certDir}/cert.pem`, "-days", "1", "-subj", "/CN=localhost"], { stdio: "ignore" });
} catch { haveCert = false; console.log("SKIP engine checks: openssl is not installed"); }

if (haveCert) {
  const mocks = await startMocks({ key: fs.readFileSync(`${certDir}/key.pem`), cert: fs.readFileSync(`${certDir}/cert.pem`), googlePublicKey: publicKey });
  const G = mocks.google;
  const BLOCKED = await freePort();      // nothing listens here: SMTP is blocked, as on Railway's Hobby plan
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mailer-test-"));
  const e = await startEngine({ PANEL_PASSWORD: "pw", NODE_TLS_REJECT_UNAUTHORIZED: "0", RAILWAY_ENVIRONMENT: "production", RAILWAY_VOLUME_MOUNT_PATH: dataDir,
    GOOGLE_TOKEN_URL: `${G.url}/token`, GMAIL_API_BASE: G.url, GOOGLE_RETEST_MINUTES: "0" }, { dataDir });
  const db = new DatabaseSync(e.dbPath);
  const day = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
  try {
    const { api, waitIdle, runNow } = client(e.url); await api("/api/login", "POST", { password: "pw" });
    await api("/api/settings", "PUT", { requireDns: false, startHour: 0, endHour: 24, timezone: "UTC", linkUrl: "https://go.trypitchpersona.test" });
    const mk = (email, extra = {}) => api("/api/inboxes", "POST", { email, role: "sender", provider: "google", start_date: day(30),
      smtp_host: "127.0.0.1", smtp_port: BLOCKED, imap_host: "127.0.0.1", imap_port: mocks.imapPort, ...extra });
    const inbox = async (id) => (await api("/api/state")).body.inboxes.find((i) => i.id === id);

    // Google sign-in chosen before a key is saved.
    const A = (await mk("one@trypitchpersona.test", { signin: "google", name: "Alex Rivera" })).body.id;
    let st = (await api("/api/state")).body;
    ok(/no service-account key is saved/.test(st.inboxes[0].blocked || "") && !st.inboxes[0].canSignIn, "without a key, a Google sign-in inbox says the key is missing", st.inboxes[0].blocked);
    const t0 = await api(`/api/inboxes/${A}/test`, "POST", {});
    ok(t0.status === 400 && /Settings, Google sign-in/.test(t0.body.error), "...and Test login says where to add it", JSON.stringify(t0.body));

    // Saving the key.
    let r = await api("/api/settings", "PUT", { googleKey: "{ not json" });
    ok(r.status === 400 && /isn't a key file/.test(r.body.error), "a broken key file is refused on save", JSON.stringify(r.body));
    r = await api("/api/settings", "PUT", { googleKey: JSON.stringify(sa) });
    st = (await api("/api/state")).body;
    ok(r.status === 200 && st.google?.clientId === "1234567890" && st.google.clientEmail === sa.client_email && st.google.projectId === "mailer-test",
      "the saved key shows its client ID and service account", JSON.stringify(st.google));
    ok(!/PRIVATE KEY|googleKeyEnc/.test(JSON.stringify(st)), "the private key never comes back to the panel");

    const B = (await mk("two@getpitchpersona.test", { name: "Hannah Lee" })).body.id;
    ok((await inbox(B)).signin === "google", "a Google inbox added without a password uses Google sign-in once a key is saved");
    r = await mk("someone@gmail.com", { role: "seed", signin: "google" });
    ok(r.status === 400 && /personal Gmail/.test(r.body.error), "personal Gmail can't use Google sign-in, and is told to use an app password", JSON.stringify(r.body));
    r = await mk("x@zoho.test", { provider: "custom", signin: "google" });
    ok(r.status === 400 && /only for Google Workspace/.test(r.body.error), "a non-Google inbox can't choose Google sign-in", JSON.stringify(r.body));

    // Before the Workspace admin allows the client.
    const before = mocks.commands.length;
    let t = (await api(`/api/inboxes/${A}/test`, "POST", {})).body;
    ok(!t.ok && t.detail.smtp.code === "google_delegation" && t.detail.imap.code === "google_delegation" && /1234567890/.test(t.detail.smtp.fix),
      "Test login before delegation names the missing step on both sides", JSON.stringify(t.detail).slice(0, 300));
    ok(!mocks.commands.slice(before).some((c) => /AUTHENTICATE|LOGIN/.test(c)), "...without also trying the mail server with a sign-in Google refused");
    await api(`/api/inboxes/${B}/test`, "POST", {});
    st = (await api("/api/state")).body;
    ok(/can sign in yet/.test(st.readiness.startBlock || "") && /Google hasn't allowed/.test(st.readiness.startBlock), "Start says no inbox can sign in, and why", st.readiness.startBlock);

    // Delegated, but the Gmail API is off in the Cloud project.
    G.delegated.add("trypitchpersona.test"); G.apiOn = false;
    t = (await api(`/api/inboxes/${A}/test`, "POST", {})).body;
    ok(!t.ok && t.detail.smtp.code === "api_off", "with the Gmail API off, Test login says to enable it", JSON.stringify(t.detail.smtp));
    G.apiOn = true;
    t = (await api(`/api/inboxes/${A}/test`, "POST", {})).body;
    ok(t.ok && t.detail.smtp.ok && t.detail.imap.ok, "once allowed and enabled, sending and reading both pass", JSON.stringify(t));
    ok(mocks.commands.includes("AUTHENTICATE XOAUTH2 ***") && !mocks.commands.some((c) => /^LOGIN/.test(c)), "reading signs in to IMAP with the Google token, not a password");
    st = (await api("/api/state")).body;
    ok(st.network.results.some((x) => x.kind === "api" && x.ok) && !st.network.results.some((x) => x.kind === "smtp"),
      "the connection check looks at Google's API, and the blocked SMTP port doesn't matter", JSON.stringify(st.network.results));
    ok(!st.readiness.startBlock && !(await inbox(A)).blocked, "the inbox is ready to send while SMTP stays blocked", JSON.stringify(st.readiness));

    // One button switches the other Google inboxes over. Personal Gmail keeps its app password.
    const C = (await mk("three@trypitchpersona.test", { signin: "password", password: "good-pass" })).body.id;
    const P = (await mk("seed.me@gmail.com", { role: "seed", password: "good-pass" })).body.id;
    await api(`/api/inboxes/${C}/test`, "POST", {});
    ok((await api("/api/state")).body.network.results.some((x) => x.kind === "smtp" && !x.ok), "an app-password inbox still shows the blocked SMTP port");
    r = (await api("/api/inboxes/use-google", "POST", {})).body;
    ok(r.switched.includes(C) && !r.switched.includes(P) && r.skipped.some((s) => s.email === "seed.me@gmail.com"), "Use it for all switches Workspace inboxes and skips personal Gmail", JSON.stringify(r));
    const c = await inbox(C);
    ok(c.signin === "google" && c.login === null, "a switched inbox starts as not tested", JSON.stringify({ signin: c.signin, login: c.login }));
    await api(`/api/inboxes/${C}`, "DELETE"); await api(`/api/inboxes/${P}`, "DELETE");
    ok(!(await api("/api/state")).body.network.results.some((x) => x.kind === "smtp"), "...and once nothing uses SMTP, the blocked port stops showing as a problem");

    // The admin allows the second domain later. It starts working with nobody pressing anything.
    G.delegated.add("getpitchpersona.test");
    r = await api("/api/pause", "POST", { paused: false });
    ok(r.status === 200, "Start works with one inbox signed in", JSON.stringify(r.body));
    let lb = null;
    for (let k = 0; k < 50 && lb !== "ok"; k++) { await sleep(200); lb = (await inbox(B)).login; }
    ok(lb === "ok", "a refused Google sign-in passes by itself once the admin allows it", String(lb));

    // Warm-up through the Gmail API.
    await waitIdle();
    const tokensBefore = G.tokenRequests.length;
    await runNow();
    ok(G.sent.length >= 2 && G.sent.every((m) => [gin.email, "two@getpitchpersona.test"].includes(m.from)) && mocks.received.every((m) => m.via === "gmail-api"),
      "warm-up emails go out through the Gmail API, none over SMTP", JSON.stringify(G.sent.map((m) => [m.from, m.to])));
    ok(G.sent.every((m) => m.fromHeader.includes(m.from)), "each one is From its own inbox", G.sent.map((m) => m.fromHeader).join(" | "));
    let mail = (await api("/api/mail")).body;
    ok(mail.length >= 2 && mail.every((m) => G.sent.some((s) => s.messageId === m.id)), "the Message-ID Gmail gave each email is the one recorded", JSON.stringify(mail.map((m) => m.id)));
    await runNow();
    mail = (await api("/api/mail")).body;
    ok(mail.some((m) => m.folder === "inbox"), "warm-up mail sent through the API is found on arrival over IMAP, so placement counts it", JSON.stringify(mail.map((m) => m.folder)));
    db.prepare("INSERT OR REPLACE INTO reply_queue (message_id, due_at, done) SELECT message_id, ?, 0 FROM seen").run(new Date(Date.now() - 60000).toISOString());
    await runNow();
    const reply = G.sent.find((m) => m.inReplyTo);
    ok(reply && reply.threadId && G.sent.some((m) => m.messageId === reply.inReplyTo), "a reply answers the real Message-ID and joins its thread in Gmail", JSON.stringify(reply && { inReplyTo: reply.inReplyTo, threadId: reply.threadId }));
    ok(G.tokenRequests.length - tokensBefore <= 2, "tokens are reused across cycles instead of signing in for every email", `${G.tokenRequests.length - tokensBefore} new tokens`);

    // A campaign follow-up threads on the Message-ID Gmail assigned, and the prospect's reply is matched to it.
    for (let k = 0; k < 20; k++) {
      db.prepare("INSERT INTO sent VALUES (?,?,?,?,?,?,?,?,?)").run(`<w${k}@x>`, gin.email, "two@getpitchpersona.test", "s", "b", `<w${k}@x>`, 0, new Date(Date.now() - 2 * 86400000).toISOString(), day(2));
      db.prepare("INSERT INTO seen VALUES (?,?,?,?,?,?)").run(`<w${k}@x>`, "two@getpitchpersona.test", "inbox", 0, new Date().toISOString(), day(1));
    }
    const camp = (await api("/api/campaigns", "POST", { name: "Google test", preset: "blank" })).body.id;
    await api(`/api/campaigns/${camp}`, "PUT", { review: false, start_hour: 0, end_hour: 24, days: "1234567", sender_ids: [A],
      steps: [{ subject: "Quick question, {{first_name}}", body: "Hi {{first_name}},\n\nTesting the engine." }, { delay_days: 3, same_thread: true, body: "Bumping this, {{first_name}}." }] });
    await api(`/api/campaigns/${camp}/leads`, "POST", { leads: [{ email: "lead@prospect.test", first_name: "Pat", name: "Pat Doe" }] });
    await api(`/api/campaigns/${camp}/status`, "POST", { status: "active" });
    await runNow();
    const step1 = G.sent.find((m) => m.to.includes("lead@prospect.test"));
    const m1 = db.prepare("SELECT message_id FROM messages WHERE recipient = 'lead@prospect.test' AND step = 1").get();
    ok(step1 && m1?.message_id === step1.messageId, "a campaign email sent through the API records Gmail's Message-ID", JSON.stringify({ m1, gmail: step1?.messageId }));
    // Due now, and the gap campaigns keep between one inbox's emails has passed.
    db.prepare("UPDATE leads SET next_at = ? WHERE email = 'lead@prospect.test'").run(new Date(Date.now() - 1000).toISOString());
    db.prepare("UPDATE messages SET sent_at = ?").run(new Date(Date.now() - 86400000).toISOString());
    await runNow();
    const step2 = G.sent.filter((m) => m.to.includes("lead@prospect.test"))[1];
    ok(step2 && step2.inReplyTo === step1?.messageId && step2.threadId, "the follow-up replies in the same thread", JSON.stringify(step2 && { inReplyTo: step2.inReplyTo, threadId: step2.threadId }));
    const last = db.prepare("SELECT message_id FROM messages WHERE recipient = 'lead@prospect.test' AND step = 2").get()?.message_id;
    mocks.deliver(gin.email, `From: Pat Doe <lead@prospect.test>\r\nTo: ${gin.email}\r\nSubject: Re: Quick question, Pat\r\nMessage-ID: <reply-pat@prospect.test>\r\nIn-Reply-To: ${last}\r\nReferences: ${step1?.messageId} ${last}\r\nDate: Mon, 05 Oct 2026 12:00:00 +0000\r\nContent-Type: text/plain\r\n\r\nYes, let's talk.\r\n`);
    await runNow();
    ok(db.prepare("SELECT status FROM leads WHERE email = 'lead@prospect.test'").get().status === "replied", "the prospect's reply is matched and stops the sequence");

    // Google withdraws the sign-in for one domain: that inbox waits with the fix, it isn't paused.
    G.delegated.delete("getpitchpersona.test");
    for (const [tok, u] of G.tokens) if (u.endsWith("@getpitchpersona.test")) G.tokens.delete(tok);
    r = await api(`/api/inboxes/${B}/send-test`, "POST", {});
    const b = await inbox(B);
    ok(r.status === 400 && !b.paused && b.login === "failed" && b.loginDetail.smtp.code === "google_delegation" && /last login test failed/.test(b.blocked || ""),
      "a sign-in Google withdraws blocks that inbox with the fix, without pausing it", JSON.stringify({ status: r.status, paused: b.paused, blocked: b.blocked }));

    // Google's sending limit pauses the inbox, like an SMTP refusal does.
    G.limited = true;
    r = await api(`/api/inboxes/${A}/send-test`, "POST", {});
    const a = await inbox(A);
    ok(r.status === 400 && a.paused && /limit exceeded/.test(a.pause_reason || ""), "Google's rate limit pauses the inbox with Google's words", JSON.stringify({ paused: a.paused, why: a.pause_reason }));
    G.limited = false;

    // Removing the key.
    await api("/api/settings", "PUT", { googleKey: "" });
    st = (await api("/api/state")).body;
    ok(st.google === null && /no service-account key is saved/.test(st.readiness.startBlock || ""), "removing the key blocks Google inboxes with the reason", st.readiness.startBlock);

    const errs = db.prepare("SELECT message FROM events WHERE level = 'error'").all().map((x) => x.message);
    ok(!errs.some((m) => /Unexpected|Cycle failed|scan .* failed/i.test(m)), "no unexpected errors", JSON.stringify(errs.filter((m) => /Unexpected|Cycle failed|scan .* failed/i.test(m))));
  } catch (err) { ok(false, "test crashed: " + err.stack); console.log(e.log().slice(-3000)); }
  finally { db.close(); e.stop(); mocks.close(); }
}
fs.rmSync(certDir, { recursive: true, force: true });

process.exit(done() ? 1 : 0);
