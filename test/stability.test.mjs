// Staying up and staying honest: a clean stop on deploy, no double email after a restart
// mid-send, DNS hiccups that don't block sending, a mail server that stops answering,
// big mailboxes read in batches, and lead search.
// Needs `openssl` for the mock mail servers' certificate; those parts skip without it.
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import dgram from "node:dgram";
import tls from "node:tls";
import net from "node:net";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { startEngine, client, checker, sleep } from "./helpers.mjs";
import { startMocks } from "./mocks.mjs";

const { ok, done } = checker("stability");
const day = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

// ── A clean stop, and leads caught mid-send go to review instead of being sent twice ──
{
  const e1 = await startEngine({ DRY_RUN: "1", PANEL_PASSWORD: "pw" });
  const { api } = client(e1.url);
  await api("/api/login", "POST", { password: "pw" });
  const camp = (await api("/api/campaigns", "POST", { name: "Restart", preset: "blank" })).body.id;
  await api(`/api/campaigns/${camp}/leads`, "POST", { leads: [{ email: "lena@example.com", first_name: "Lena" }, { email: "omar@example.com", first_name: "Omar" }] });

  // Lead search joins the sender inbox, which also has email and name columns.
  const found = await api(`/api/campaigns/${camp}/leads?q=lena`);
  ok(found.status === 200 && found.body.total === 1 && found.body.rows[0].email === "lena@example.com", "lead search finds a lead by email", JSON.stringify(found.body).slice(0, 160));
  const byStatus = await api(`/api/campaigns/${camp}/leads?q=omar&status=review`);
  ok(byStatus.status === 200 && byStatus.body.total === 1, "lead search works together with a status filter", JSON.stringify(byStatus.body).slice(0, 160));

  // More than one batch: nothing is dropped without saying so.
  const many = Array.from({ length: 1003 }, (_, k) => ({ email: `bulk${k}@example.com`, first_name: "B" }));
  const big = await api(`/api/campaigns/${camp}/leads`, "POST", { leads: many });
  ok(big.body.added === 1000 && big.body.notRead === 3 && /another batch/.test(big.body.note), "a batch over 1000 leads says how many were left out", JSON.stringify({ ...big.body, skipped: big.body.skipped?.length }));

  const t = Date.now();
  const code = await e1.exit();
  ok(code === 0 && Date.now() - t < 5000, "SIGTERM (what Railway sends on deploy) stops the mailer cleanly", `exit ${code} after ${Date.now() - t}ms`);

  // Simulate a stop in the middle of sending Lena's first email.
  const db = new DatabaseSync(e1.dbPath);
  db.prepare("UPDATE leads SET status = 'sending', error = 'Sending step 1 from a@getpitchpersona.com' WHERE email = 'lena@example.com'").run();
  db.close();
  const e2 = await startEngine({ DRY_RUN: "1", PANEL_PASSWORD: "pw" }, { dataDir: e1.dataDir });
  try {
    const c2 = client(e2.url); await c2.api("/api/login", "POST", { password: "pw" });
    const lead = (await c2.api(`/api/campaigns/${camp}/leads?q=lena`)).body.rows[0];
    ok(lead.status === "review" && /stopped while sending step 1 from a@getpitchpersona.com/.test(lead.error) && /Sent folder/.test(lead.error),
      "a lead interrupted mid-send waits in review with a note to check the Sent folder", JSON.stringify(lead));
    const ev = (await c2.api("/api/state")).body.events.map((x) => x.message).join("\n");
    ok(/moved to review: the mailer stopped while emailing it/.test(ev), "...and Activity says so");
  } finally { e2.stop(); }
}

// ── DNS that can't be asked right now doesn't read as "records missing" ──
{
  // A tiny DNS server: names with "missing" don't exist (NXDOMAIN), everything else fails (SERVFAIL).
  const dns = dgram.createSocket("udp4");
  dns.on("message", (q, from) => {
    let i = 12; while (q[i]) i += q[i] + 1; i += 5;
    const name = q.subarray(12, i).toString("latin1");
    const r = Buffer.concat([q.subarray(0, 12), q.subarray(12, i)]);
    r.writeUInt16BE(0x8180 | (/missing/.test(name) ? 3 : 2), 2); r.writeUInt16BE(1, 4); r.writeUInt16BE(0, 6); r.writeUInt16BE(0, 8); r.writeUInt16BE(0, 10);
    dns.send(r, from.port, from.address);
  });
  await new Promise((r) => dns.bind(0, "127.0.0.1", r));
  const e = await startEngine({ PANEL_PASSWORD: "pw", DNS_SERVERS: `127.0.0.1:${dns.address().port}`, NET_CHECK: "off" });
  const db = new DatabaseSync(e.dbPath);
  try {
    const { api } = client(e.url); await api("/api/login", "POST", { password: "pw" });
    // An earlier passing check for this domain, older than the 6-hour cache.
    db.prepare("INSERT INTO dns_checks VALUES (?,?,?)").run("known.test", JSON.stringify({ domain: "known.test", spf: "v=spf1 include:_spf.google.com ~all", dkim: "google: v=DKIM1...", dmarc: "v=DMARC1; p=none", ok: true }), new Date(Date.now() - 8 * 3600000).toISOString());
    const add = (email) => api("/api/inboxes", "POST", { email, role: "sender", provider: "google", password: "abcdefghijklmnop" });
    await add("a@known.test"); await add("b@newdomain.test"); await add("c@missing.test");
    await sleep(300);
    const st = (await api("/api/state")).body;
    const by = Object.fromEntries(st.inboxes.map((i) => [i.email, i.blocked]));
    ok(by["a@known.test"] === null, "a DNS server failure keeps the last passing check, so sending isn't blocked", String(by["a@known.test"]));
    ok(/Couldn't look up DNS for newdomain.test/.test(by["b@newdomain.test"] || ""), "with no earlier answer, the inbox waits and says DNS couldn't be asked", String(by["b@newdomain.test"]));
    const nd = st.domains.find((d) => d.domain === "newdomain.test");
    ok(nd && !nd.ok && nd.error && !nd.checkedAt, "...and the domain card doesn't claim the records are missing", JSON.stringify(nd));
    ok(/DNS not ready: missing SPF, DKIM, DMARC/.test(by["c@missing.test"] || ""), "a domain that really has no records is still blocked as missing", String(by["c@missing.test"]));
  } finally { db.close(); e.stop(); dns.close(); }
}

// ── Mail servers that stall, and mailboxes with lots of new mail ──
const certDir = fs.mkdtempSync(path.join(os.tmpdir(), "mailer-cert-"));
let haveCert = true;
try {
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", `${certDir}/key.pem`, "-out", `${certDir}/cert.pem`, "-days", "1", "-subj", "/CN=localhost"], { stdio: "ignore" });
} catch { haveCert = false; console.log("SKIP mail server checks: openssl is not installed"); }

if (haveCert) {
  const key = fs.readFileSync(`${certDir}/key.pem`), cert = fs.readFileSync(`${certDir}/cert.pem`);
  // An IMAP server that accepts the login and then never answers LIST.
  const stall = tls.createServer({ key, cert }, (s) => {
    s.write("* OK [CAPABILITY IMAP4rev1] ready\r\n");
    let buf = "";
    s.on("data", (d) => {
      buf += d; const lines = buf.split("\r\n"); buf = lines.pop();
      for (const l of lines) {
        const [tag, cmd = ""] = l.split(" ");
        if (/^LIST/i.test(cmd)) continue;
        s.write(/^CAPABILITY/i.test(cmd) ? `* CAPABILITY IMAP4rev1\r\n${tag} OK\r\n` : `${tag} OK\r\n`);
      }
    });
    s.on("error", () => {});
  });
  await new Promise((r) => stall.listen(0, "127.0.0.1", r));
  // A sending server that answers at once and turns everything away.
  const refuse = net.createServer((s) => { s.on("error", () => {}); s.end("554 5.3.2 Not accepting mail\r\n"); });
  await new Promise((r) => refuse.listen(0, "127.0.0.1", r));
  const e = await startEngine({ PANEL_PASSWORD: "pw", NODE_TLS_REJECT_UNAUTHORIZED: "0", IMAP_DEADLINE_MS: "1500" });
  try {
    const { api, waitIdle } = client(e.url); await api("/api/login", "POST", { password: "pw" });
    await api("/api/settings", "PUT", { requireDns: false });
    const mk = (email) => api("/api/inboxes", "POST", { email, role: "sender", provider: "custom", password: "good-pass", paused: true,
      smtp_host: "127.0.0.1", smtp_port: refuse.address().port, imap_host: "127.0.0.1", imap_port: stall.address().port, start_date: day(1) });
    const A = (await mk("slow1@stall.test")).body.id; await mk("slow2@stall.test");
    const t0 = Date.now();
    const test = await api(`/api/inboxes/${A}/test`, "POST", {});
    ok(/didn't finish within 2 seconds/.test(test.body.imap) && Date.now() - t0 < 10000, "Test login on a mail server that stops answering gives up and says so", JSON.stringify(test.body));
    await api("/api/pause", "POST", { paused: false });
    await sleep(300);
    const live = (await api("/api/status")).body.scheduler;
    ok(live.running && live.phase === "reading" && live.runningSince, "while a cycle waits on a mail server, the status says it's reading the inboxes", JSON.stringify(live));
    const t1 = Date.now(); await waitIdle();
    ok(Date.now() - t1 < 10000, "a cycle doesn't hang on a mail server that stops answering", `${Date.now() - t1}ms`);
    const ev = (await api("/api/state")).body.events.map((x) => x.message).join("\n");
    ok(/Reading the inbox failed: the mail server didn't finish within 2 seconds/.test(ev), "...and Activity says that inbox was skipped this cycle", ev.slice(0, 300));
  } finally { e.stop(); stall.close(); refuse.close(); }

  // A mailbox with more new mail than one batch is read over several cycles.
  const mocks = await startMocks({ key, cert });
  const e2 = await startEngine({ PANEL_PASSWORD: "pw", NODE_TLS_REJECT_UNAUTHORIZED: "0", SCAN_BATCH: "2" });
  const db = new DatabaseSync(e2.dbPath);
  try {
    const { api, runNow } = client(e2.url); await api("/api/login", "POST", { password: "pw" });
    await api("/api/settings", "PUT", { requireDns: false });
    const mk = (email, role) => api("/api/inboxes", "POST", { email, role, provider: "custom", password: "good-pass", paused: true,
      smtp_host: "127.0.0.1", smtp_port: mocks.smtpPort, imap_host: "127.0.0.1", imap_port: mocks.imapPort, start_date: day(1) });
    await mk("busy@getpitchpersona.test", "sender"); await mk("seed@seedmail.test", "seed");
    await api("/api/pause", "POST", { paused: false }); await sleep(300);
    await runNow();                                      // first look: the cursor starts at "now"
    for (let k = 0; k < 5; k++) mocks.deliver("busy@getpitchpersona.test", `From: News ${k} <news${k}@letters.test>\r\nTo: busy@getpitchpersona.test\r\nSubject: Issue ${k}\r\nMessage-ID: <n${k}@letters.test>\r\n\r\nHello`);
    const cursor = () => db.prepare("SELECT last_uid FROM imap_cursor WHERE inbox = ? AND folder = 'INBOX'").get("busy@getpitchpersona.test")?.last_uid;
    const seen = [];
    for (let k = 0; k < 3; k++) { await runNow(); seen.push(cursor()); }
    ok(JSON.stringify(seen) === "[2,4,5]", "5 new messages are read 2 at a time over three cycles", JSON.stringify(seen));
    ok(mocks.commands.some((c) => /^UID FETCH 1:2 /i.test(c)), "...fetching only one batch per cycle", mocks.commands.filter((c) => /UID FETCH/i.test(c)).join(" | ").slice(0, 200));
  } finally { db.close(); e2.stop(); mocks.close(); }
}
fs.rmSync(certDir, { recursive: true, force: true });

process.exit(done() ? 1 : 0);
