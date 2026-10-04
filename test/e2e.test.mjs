// End-to-end checks in dry-run mode (DRY_RUN=1: nothing is sent): sign-in, inboxes,
// PitchPersona webhook ingest, review, sequences and threading, pauses, inbox removal,
// unsubscribe, click tracking and malformed requests.
import { DatabaseSync } from "node:sqlite";
import net from "node:net";
import { startEngine, client, checker, sleep } from "./helpers.mjs";

const engine = await startEngine({ DRY_RUN: "1", PANEL_PASSWORD: "testpass" });
const B = engine.url;
const db = new DatabaseSync(engine.dbPath);
const { api, waitIdle, runNow } = client(B);
const { ok, done } = checker("dry run");
try {
// ── Sign-in and rate limit ──
for (let k = 0; k < 9; k++) await api("/api/login", "POST", { password: "nope" }, { "x-forwarded-for": "1.1.1.1, 9.9.9.9" });
ok((await api("/api/login", "POST", { password: "nope" }, { "x-forwarded-for": "9.9.9.9" })).status === 401, "10th wrong password still answered 401");
ok((await api("/api/login", "POST", { password: "testpass" }, { "x-forwarded-for": "9.9.9.9" })).status === 429, "11th try from the same address is rate limited");
const login = await api("/api/login", "POST", { password: "testpass" }, { "x-forwarded-for": "5.5.5.5", "x-forwarded-host": "mailer.example.com", "x-forwarded-proto": "https" });
ok(login.status === 200, "correct password from another address signs in");
ok((await api("/api/state")).status === 200, "session cookie works");
const cookie = login.headers.get("set-cookie").split(";")[0];
ok((await fetch(B + "/api/settings", { method: "PUT", headers: { cookie, "content-type": "text/plain" }, body: "{}" })).status === 415, "non-JSON write refused (CSRF guard)");

// ── Inboxes ──
const add = async (b) => api("/api/inboxes", "POST", { provider: "google", role: "sender", ...b });
const a = (await add({ email: "a@getpitchpersona.com", password: "abcd efgh ijkl mnop", name: "Saurabh Singh" })).body.id;
const b = (await add({ email: "b@trypitchpersona.com", password: "abcdefghijklmnop", name: "Saurabh S" })).body.id;
await add({ email: "seed.me@gmail.com", password: "x", name: "Seed", role: "seed" });
ok((await add({ email: "a@getpitchpersona.com", password: "x" })).status === 400, "duplicate inbox refused");
ok((await add({ email: "not an email", password: "x" })).status === 400, "bad inbox address refused");
ok((await api(`/api/inboxes/${a}`, "PUT", { email: "other@getpitchpersona.com" })).status === 400, "inbox address can't be changed in place");
const bulk = await api("/api/inboxes/bulk", "POST", { lines: "c@getpitchpersona.com, pw1234, Cee\nbroken line\n", provider: "google", role: "sender" });
ok(bulk.body.results.length === 2 && bulk.body.results[0].ok && !bulk.body.results[1].ok, "bulk add: good line added, bad line reported");
const cId = db.prepare("SELECT id FROM inboxes WHERE email='c@getpitchpersona.com'").get().id;
ok((await api(`/api/inboxes/${cId}`, "DELETE")).status === 200, "inbox removed");

// ── Campaign + PitchPersona webhook ingest ──
const camp = (await api("/api/campaigns", "POST", { name: "PP test", preset: "pitchpersona" })).body.id;
let C = (await api(`/api/campaigns/${camp}`)).body;
ok(C.ingestUrl.startsWith("https://mailer.example.com/i/"), "ingest link uses the public address", C.ingestUrl);
ok(JSON.stringify(C.sender_ids) === JSON.stringify([a, b]), "campaign defaults to the live sender inboxes", JSON.stringify(C.sender_ids));
const tok = C.ingest_token;
await api("/api/suppression", "POST", { emails: "@blocked.io" });
const pp = (email, extra = {}) => ({ prospect_email: email, prospect_first_name: "Jane", prospect_name: "Jane Doe", prospect_company: "Acme",
  email_subject: "scoring at Acme", email_body: "Hi Jane,\n\nSaw Acme is hiring SDRs. See https://pitchpersona.app/demo for a 2 min look.",
  email_2_subject: "", email_2_body: "Jane, one more thought on this.", email_3_subject: "", email_3_body: "", ...extra });
const ing = await fetch(`${B}/i/${tok}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify([
  pp("jane@acme.io"), pp("Raj <RAJ@Beta.dev>", { prospect_first_name: "Raj" }), pp("x@blocked.io"), pp("a@b.com, c@d.com"),
  pp("bad@dead.io", { prospect_email_status: "invalid" }), pp("nobody@empty.io", { email_body: "" }), pp("jane@acme.io"),
]) }).then((r) => r.json());
ok(ing.added === 3, "ingest added 3 leads", JSON.stringify(ing));
const reasons = Object.fromEntries(ing.skipped.map((s) => [s.email, s.reason]));
ok(/do-not-email/.test(reasons["x@blocked.io"]), "whole-domain suppression applied on ingest");
ok(/no valid email/.test(reasons["a@b.com, c@d.com"] || ""), "two addresses in one field refused");
ok(/marked invalid/.test(reasons["bad@dead.io"] || ""), "address marked invalid skipped");
ok(/already in this campaign/.test(reasons["jane@acme.io"] || ""), "duplicate skipped");
ok(!!db.prepare("SELECT 1 FROM leads WHERE email='raj@beta.dev'").get(), "\"Raj <RAJ@Beta.dev>\" unwrapped and lowercased");
ok((await fetch(`${B}/i/${tok}`, { method: "POST", body: "{nope" })).status === 400, "bad JSON answered 400");
ok((await fetch(`${B}/i/unknowntokenunknowntoken`, { method: "POST", body: "{}" })).status === 404, "unknown ingest link answered 404");

const camp2 = (await api("/api/campaigns", "POST", { name: "Other", preset: "blank" })).body.id;
const add2 = await api(`/api/campaigns/${camp2}/leads`, "POST", { leads: [{ email: "jane@acme.io", first_name: "Jane" }] });
ok(add2.body.added === 0 && /already being emailed/.test(add2.body.skipped[0]?.reason), "same person refused by a second campaign");

// ── Review, start, send ──
ok((await api(`/api/campaigns/${camp}/leads?status=review`)).body.total === 3, "3 leads waiting for review");
await api(`/api/campaigns/${camp}/leads/action`, "POST", { action: "approve", status: "review" });
ok((await api(`/api/campaigns/${camp}/status`, "POST", { status: "active" })).status === 200, "campaign started");
ok((await api("/api/run-now", "POST", {})).status === 400, "run-now refused while everything is paused");
await api("/api/pause", "POST", { paused: false });
await sleep(500); await waitIdle();
await runNow(); await runNow();
let L = Object.fromEntries(db.prepare("SELECT email, status, step, error, sender_id, last_subject, last_message_id FROM leads WHERE campaign_id=?").all(camp).map((r) => [r.email, r]));
ok(L["jane@acme.io"].step === 1 && L["raj@beta.dev"].step === 1, "step 1 sent to both good leads", `${L["jane@acme.io"].step}/${L["raj@beta.dev"].step}`);
ok(L["nobody@empty.io"].status === "failed" && /email_body|body/.test(L["nobody@empty.io"].error), "lead with no written email held back", L["nobody@empty.io"].error);
const perCycle = db.prepare("SELECT sender, COUNT(*) c FROM messages GROUP BY sender").all();
ok(perCycle.every((r) => r.c <= 2), "at most one campaign email per inbox per cycle", JSON.stringify(perCycle));
const m1 = db.prepare("SELECT * FROM messages WHERE recipient='jane@acme.io'").get();
ok(m1.subject === "scoring at Acme" && /Saurabh/.test(m1.body) && /reply "no"/.test(m1.body), "step 1 rendered with signature and opt-out line");

// ── Follow-up threading ──
db.prepare("UPDATE leads SET next_at=? WHERE email IN ('jane@acme.io','raj@beta.dev')").run(new Date(Date.now() - 1000).toISOString());
await runNow();
const m2 = db.prepare("SELECT * FROM messages WHERE recipient='jane@acme.io' AND step=2").get();
ok(m2 && m2.subject === "Re: scoring at Acme" && m2.sender === m1.sender, "step 2 sent as a reply in the same thread from the same inbox", m2?.subject);
L = Object.fromEntries(db.prepare("SELECT email, status, step, last_message_id FROM leads WHERE campaign_id=?").all(camp).map((r) => [r.email, r]));
ok(L["jane@acme.io"].last_message_id === m2.message_id, "thread pointer moved to step 2");
db.prepare("UPDATE leads SET next_at=? WHERE email='jane@acme.io'").run(new Date(Date.now() - 1000).toISOString());
await runNow();
L = Object.fromEntries(db.prepare("SELECT email, status, step FROM leads WHERE campaign_id=?").all(camp).map((r) => [r.email, r]));
ok(L["jane@acme.io"].status === "completed" && L["jane@acme.io"].step === 3, "empty step 3 skipped, lead completed", JSON.stringify(L["jane@acme.io"]));

// ── Pause stops campaign sends ──
await api("/api/campaigns/" + camp + "/leads", "POST", { leads: [{ email: "late@gamma.io", first_name: "Lee", email_subject: "hi Lee", email_body: "Hello Lee", email_2_body: "Following up, Lee." }] });
await api(`/api/campaigns/${camp}/leads/action`, "POST", { action: "approve", status: "review" });
await api(`/api/inboxes/${a}`, "PUT", { paused: true }); await api(`/api/inboxes/${b}`, "PUT", { paused: true });
await runNow();
ok(db.prepare("SELECT status, step FROM leads WHERE email='late@gamma.io'").get().step === 0, "paused inboxes send nothing; lead stays queued");
await api(`/api/inboxes/${a}`, "PUT", { paused: false }); await api(`/api/inboxes/${b}`, "PUT", { paused: false });
await runNow();
const late = db.prepare("SELECT step, sender_id FROM leads WHERE email='late@gamma.io'").get();
ok(late.step === 1, "lead goes out after resume");

// ── Removing an inbox hands its in-progress leads to review ──
const raj = db.prepare("SELECT sender_id FROM leads WHERE email='raj@beta.dev'").get();
const lateLead = db.prepare("SELECT id, sender_id FROM leads WHERE email='late@gamma.io'").get();
const victim = lateLead.sender_id;
await api(`/api/inboxes/${victim}`, "DELETE");
const after = db.prepare("SELECT status, sender_id, error, last_subject FROM leads WHERE id=?").get(lateLead.id);
ok(after.status === "review" && after.sender_id === null && /removed/.test(after.error), "lead mid-sequence moved to review when its inbox is removed", after.status);
ok(!(await api(`/api/campaigns/${camp}`)).body.sender_ids.includes(victim), "removed inbox dropped from the campaign");
await api(`/api/campaigns/${camp}/leads/action`, "POST", { action: "approve", ids: [lateLead.id] });
db.prepare("UPDATE leads SET next_at=? WHERE id=?").run(new Date(Date.now() - 1000).toISOString(), lateLead.id);
await runNow();
const cont = db.prepare("SELECT * FROM messages WHERE lead_id=? AND step=2").get(lateLead.id);
ok(cont && cont.subject === "hi Lee" && cont.sender !== db.prepare("SELECT email FROM inboxes WHERE id=?").get(victim)?.email, "continues from another inbox as a new thread, same subject without Re:", cont?.subject);

// ── Public routes ──
const lead = db.prepare("SELECT token FROM leads WHERE email='raj@beta.dev'").get();
const u1 = await fetch(`${B}/u/${lead.token}`).then((r) => r.text());
ok(/<button/.test(u1) && db.prepare("SELECT status FROM leads WHERE email='raj@beta.dev'").get().status !== "unsubscribed", "unsubscribe GET shows a button and changes nothing");
await fetch(`${B}/u/${lead.token}`, { method: "POST" });
ok(db.prepare("SELECT status FROM leads WHERE email='raj@beta.dev'").get().status === "unsubscribed" && !!db.prepare("SELECT 1 FROM suppression WHERE email='raj@beta.dev'").get(), "unsubscribe POST stops the lead and suppresses");
const mt = db.prepare("SELECT token FROM messages WHERE recipient='jane@acme.io' AND step=1").get().token;
const good = await fetch(`${B}/c/${mt}?u=${encodeURIComponent("https://pitchpersona.app/demo")}`, { redirect: "manual" });
ok(good.status === 302 && good.headers.get("location") === "https://pitchpersona.app/demo", "click link redirects to the link in the email");
const evil = await fetch(`${B}/c/${mt}?u=${encodeURIComponent("https://pitchpersona.app/demo.evil.com")}`, { redirect: "manual" });
ok(evil.status === 404, "click link refuses anything that isn't exactly in the email (no open redirect)");
const gif = await fetch(`${B}/o/${mt}.gif`);
ok(gif.headers.get("content-type") === "image/gif", "open pixel serves a gif");

// ── Malformed requests don't crash the server ──
for (const raw of ["GET //[ HTTP/1.1\r\nHost: x\r\n\r\n", "GET /api/%zz HTTP/1.1\r\nHost: x\r\n\r\n"]) {
  await new Promise((res) => { const s = net.connect(engine.port, "127.0.0.1", () => s.write(raw)); s.on("data", () => { s.destroy(); res(); }); s.on("error", res); setTimeout(res, 1000); });
}
ok((await fetch(`${B}/health`).then((r) => r.text())) === "ok", "server still up after malformed URLs");

// ── Campaign test send goes only to an own inbox ──
ok((await api(`/api/campaigns/${camp}/test`, "POST", { to: "stranger@else.com" })).status === 400, "test send to a non-owned address refused");
ok((await api(`/api/campaigns/${camp}/test`, "POST", { to: "seed.me@gmail.com" })).status === 200, "test send to an own inbox works");

} catch (e) { ok(false, "test crashed: " + e.stack); console.log(engine.log().slice(-2000)); }
finally { engine.stop(); }
process.exit(done() ? 1 : 0);
