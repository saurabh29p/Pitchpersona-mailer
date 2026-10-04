// Reply, bounce and opt-out detection, with a fake IMAP client that behaves like imapflow
// (fetchAll returns an array, download returns a stream, no commands during a fetch).
import { DatabaseSync } from "node:sqlite"; import http from "node:http"; import { Readable } from "node:stream";
import { createCampaigns } from "../src/campaigns.mjs";
import { checker } from "./helpers.mjs";
const db = new DatabaseSync(":memory:");
db.exec(`CREATE TABLE inboxes (id INTEGER PRIMARY KEY, email TEXT, name TEXT, role TEXT, paused INTEGER DEFAULT 0, pause_reason TEXT);
  INSERT INTO inboxes (id, email, name, role) VALUES (1, 'a@getpitchpersona.com', 'Saurabh Singh', 'sender'), (2, 'b@trypitchpersona.com', 'Saurabh S', 'sender');`);
const { ok, done } = checker("scanner");
const hooks = []; const srv = http.createServer((q, r) => { let b = ""; q.on("data", (c) => (b += c)); q.on("end", () => { hooks.push(JSON.parse(b)); r.end("ok"); }); }).listen(0);
await new Promise((r) => srv.once("listening", r));
const settings = { timezone: "America/New_York", replyWebhookUrl: `http://127.0.0.1:${srv.address().port}/hook`, publicUrl: "https://m.example.com", coldMinWarmDays: 14, coldMinPlacement: 90, coldDailyCap: 30 };
const events = [];
const camp = createCampaigns({ db, DRY: true, event: (l, i, m) => events.push(`${l} ${i} ${m}`), getSettings: () => settings,
  listInboxes: () => db.prepare("SELECT * FROM inboxes").all(), getInbox: (id) => db.prepare("SELECT * FROM inboxes WHERE id=?").get(id),
  blockedReason: async () => null, dailyTarget: () => ({ dayN: 20 }), placement: () => ({ checked: 50, pct: 95 }),
  localParts: () => ({ day: "2026-10-05", hour: 10, weekday: "Mon" }), daysAgo: () => "2026-09-28", smtpSend: async () => {},
  domainOf: (e) => e.split("@")[1], EMAIL_RE: /^[^\s@]+@[^\s@]+\.[^\s@]+$/, readJson: async () => ({}), first: (n) => n.split(" ")[0], pickOne: (a) => a[0], rand: (a) => a });
db.prepare("INSERT INTO campaigns (id, name, status, ingest_token, stop_on_reply) VALUES (1, 'Main', 'active', 'main-token-xxxxxxxxxxxxx', 1), (2, 'Other', 'active', 'other-token-xxxxxxxxxxxx', 1), (3, 'Keep going', 'active', 'keep-token-xxxxxxxxxxxxx', 0)").run();
let n = 0;
const lead = (email, cid = 1, sender = "a@getpitchpersona.com") => {
  const id = Number(db.prepare("INSERT INTO leads (campaign_id,email,name,first_name,status,step,next_at,sender_id,token,created_at,updated_at) VALUES (?,?,?,?,'queued',1,datetime('now','+3 days'),1,?,datetime(),datetime())")
    .run(cid, email, email, email, "t" + (++n) + "xxxxxxxxxxxxxxxxxxxxxx").lastInsertRowid);
  db.prepare("INSERT INTO messages (lead_id,campaign_id,step,sender,recipient,message_id,subject,body,sent_at,day,token) VALUES (?,?,1,?,?,?,'hi','hi',datetime(),'2026-10-04',?)")
    .run(id, cid, sender, email, `<m${id}@getpitchpersona.com>`, "k" + n + "yyyyyyyyyyyyyyyyyyyyyy");
  return id;
};
const jane = lead("jane@acme.io"), ghost = lead("ghost@nowhere.io"), slow = lead("slow@later.io"), stop = lead("stop@corp.com"), boss = lead("cto@delta.io"), keep = lead("keep@going.io", 3);
db.prepare("INSERT INTO leads (campaign_id,email,status,step,token,created_at,updated_at) VALUES (2,'jane@acme.io','queued',0,'zzzzzzzzzzzzzzzzzzzzzzzz',datetime(),datetime())").run();

function client(msgs, uidNext) {
  let inFetch = false;
  const guard = () => { if (inFetch) throw new Error("command during fetch (would deadlock)"); };
  const shape = (m) => ({ uid: m.uid, envelope: { from: [{ address: m.from, name: m.name || "" }], subject: m.subject, messageId: m.mid || `<r${m.uid}@ext>` }, headers: Buffer.from(m.headers || "") });
  return { mailbox: { uidValidity: 7n, uidNext },
    async fetchAll(range) { guard(); inFetch = true; const from = Number(range.split(":")[0]); const out = msgs.filter((m) => m.uid >= from).map(shape);
      // IMAP "N:*" always returns at least the last message, even if it is older than N.
      if (!out.length && msgs.length) out.push(shape(msgs.at(-1))); inFetch = false; return out; },
    async download(uid) { guard(); const m = msgs.find((x) => String(x.uid) === String(uid)); return { content: Readable.from([Buffer.from(m.raw)]) }; },
    async messageMove(uid, to) { guard(); events.push(`moved ${uid} to ${to}`); } };
}
const A = db.prepare("SELECT * FROM inboxes WHERE id=1").get();
await camp.scanFolder(client([], 101), A, "[Gmail]/All Mail", false);
ok(db.prepare("SELECT last_uid FROM imap_cursor").get().last_uid === 100, "first look sets the cursor without replaying history");
const msgs = [
  { uid: 99, from: "jane@acme.io", subject: "old", raw: "Subject: old\r\n\r\nold" },
  { uid: 101, from: "jane@acme.io", name: "Jane Doe", subject: "Re: hi", raw: "Subject: Re\r\nContent-Type: text/plain\r\n\r\nYes, let's talk Tuesday.\r\n\r\nOn Mon, Oct 5 Saurabh wrote:\r\n> Hi Jane" },
  { uid: 102, from: "mailer-daemon@googlemail.com", name: "Mail Delivery Subsystem", subject: "Delivery Status Notification (Delay)", raw: "Subject: x\r\n\r\nDelivery to slow@later.io has been delayed. Gmail will keep trying.\r\nAction: delayed\r\nFinal-Recipient: rfc822; slow@later.io" },
  { uid: 103, from: "mailer-daemon@googlemail.com", name: "Mail Delivery Subsystem", subject: "Delivery Status Notification (Failure)", raw: "Subject: x\r\n\r\nAddress not found.\r\nFinal-Recipient: rfc822; ghost@nowhere.io\r\nAction: failed\r\nStatus: 5.1.1\r\n\r\n----- Original message -----\r\nFrom: a@getpitchpersona.com\r\nTo: ghost@nowhere.io\r\nCc: jane@acme.io" },
  { uid: 104, from: "stop@corp.com", subject: "Re: hi", raw: "Subject: Re\r\n\r\nPlease remove me from your list." },
  { uid: 105, from: "assistant@delta.io", subject: "Re: hi", headers: "In-Reply-To: <m5@getpitchpersona.com>\r\nReferences: <m5@getpitchpersona.com>\r\n", raw: "Subject: Re\r\n\r\nForwarding to our CTO, he will reach out." },
  { uid: 106, from: "keep@going.io", subject: "Re: hi", raw: "Subject: Re\r\n\r\nInteresting, tell me more later." },
  { uid: 107, from: "random@spam.com", subject: "Buy now", raw: "Subject: x\r\n\r\nspam" },
  { uid: 108, from: "b@trypitchpersona.com", subject: "warmup", raw: "x" },
  { uid: 109, from: "raj@beta.dev", subject: "Automatic reply: hi", headers: "Auto-Submitted: auto-replied\r\n", raw: "Subject: x\r\n\r\nI'm out of office." },
];
await camp.scanFolder(client(msgs, 110), A, "[Gmail]/All Mail", false);
await camp.scanFolder(client(msgs, 110), A, "[Gmail]/All Mail", false);   // nothing new: no duplicates
const st = (id) => db.prepare("SELECT status FROM leads WHERE id=?").get(id).status;
ok(st(jane) === "replied", "reply stops the lead");
ok(db.prepare("SELECT status FROM leads WHERE campaign_id=2 AND email='jane@acme.io'").get().status === "skipped", "reply also stops that person in other campaigns");
ok(st(ghost) === "bounced" && !!db.prepare("SELECT 1 FROM suppression WHERE email='ghost@nowhere.io'").get(), "hard bounce marks the lead bounced and suppresses it");
ok(!db.prepare("SELECT 1 FROM suppression WHERE email='jane@acme.io' AND reason='bounced'").get(), "bounce uses Final-Recipient, not every address in the report");
ok(st(slow) === "queued", "delayed-delivery notice is not a bounce");
ok(st(stop) === "unsubscribed", "\"remove me\" reply unsubscribes");
ok(st(boss) === "replied", "reply from a colleague's address matched by In-Reply-To");
ok(st(keep) === "queued", "campaign with stop-on-reply off keeps the sequence going");
ok(db.prepare("SELECT COUNT(*) c FROM replies").get().c === 5, "5 events recorded once each (3 replies, 1 bounce, 1 opt-out; strangers and auto-replies from non-leads ignored)", String(db.prepare("SELECT COUNT(*) c FROM replies").get().c));
ok(db.prepare("SELECT last_uid FROM imap_cursor").get().last_uid === 109, "cursor advanced past every message");
const snip = db.prepare("SELECT snippet FROM replies WHERE lead_id=?").get(jane).snippet;
ok(snip === "Yes, let's talk Tuesday.", "snippet drops the quoted text", snip);
await new Promise((r) => setTimeout(r, 200));
ok(hooks.length === 3 && hooks.every((h) => h.event_type === "reply_received") && hooks.some((h) => h.lead_email === "jane@acme.io"), "PitchPersona reply webhook sent for each real reply", String(hooks.length));

// Spam folder: a lead's reply there is recorded and moved to the inbox
const sp = lead("spammy@epsilon.io");
await camp.scanFolder(client([], 21), A, "[Gmail]/Spam", true);
await camp.scanFolder(client([{ uid: 21, from: "spammy@epsilon.io", subject: "Re: hi", raw: "Subject: Re\r\n\r\nSure, send details." }], 22), A, "[Gmail]/Spam", true);
ok(st(sp) === "replied" && events.some((e) => e === "moved 21 to INBOX"), "reply found in spam is recorded and moved to the inbox");

// A rebuilt folder (new UIDVALIDITY) starts fresh instead of skipping or replaying
const c2 = client([], 5); c2.mailbox.uidValidity = 8n;
await camp.scanFolder(c2, A, "[Gmail]/All Mail", false);
ok(db.prepare("SELECT last_uid, uidvalidity FROM imap_cursor WHERE folder='[Gmail]/All Mail'").get().uidvalidity === "8", "UIDVALIDITY change resets the cursor");

// Bounce guard: >5% of the last 40 sends bounced pauses the inbox
for (let k = 0; k < 25; k++) lead(`bulk${k}@list.io`);
const bounces = [0, 1].map((k) => ({ uid: 200 + k, from: "mailer-daemon@googlemail.com", subject: "Delivery Status Notification (Failure)", raw: `Subject: x\r\n\r\nFinal-Recipient: rfc822; bulk${k}@list.io\r\nAction: failed\r\nStatus: 5.1.1` }));
await camp.scanFolder(client([], 200), A, "INBOX", false);
await camp.scanFolder(client(bounces, 202), A, "INBOX", false);
ok(db.prepare("SELECT paused FROM inboxes WHERE id=1").get().paused === 1, "inbox pauses itself when bounces pass 5%", db.prepare("SELECT pause_reason FROM inboxes WHERE id=1").get().pause_reason);

srv.close();
process.exit(done() ? 1 : 0);
