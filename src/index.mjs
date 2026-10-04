// PitchPersona warm-up: a small, self-hosted inbox warm-up with a browser control panel.
//
// Every few minutes it (1) opens every pool inbox over IMAP, rescues warm-up mail from
// spam, marks it read / important / starred and queues some replies, (2) sends the replies
// that are due, and (3) sends a few new plain-text emails between the pool inboxes on a
// slow ramp. Inboxes, passwords and settings live in SQLite on the data volume and are
// edited in the control panel; nothing needs a redeploy.
//
// Safety: it starts paused, refuses to send from a domain without SPF, DKIM and DMARC,
// clamps every volume setting to a hard maximum, slows an inbox down when its spam rate
// rises and pauses it when placement drops or the provider pushes back.
//
// Run:  npm start            (scheduler + control panel on $PORT)
//       npm run dry          (one cycle, nothing sent, templates instead of AI)

import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import dns from "node:dns/promises";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import nodemailer from "nodemailer";
import { ImapFlow } from "imapflow";
import { createCampaigns } from "./campaigns.mjs";
import { dkimVerdict } from "./dkim.mjs";

const DRY = process.env.DRY_RUN === "1";
const ONCE = process.argv.includes("--once");
const DATA_DIR = process.env.DATA_DIR || "./data";
fs.mkdirSync(DATA_DIR, { recursive: true });
// On Railway, data survives a redeploy only on a mounted volume.
const ON_RAILWAY = !!(process.env.RAILWAY_ENVIRONMENT_NAME || process.env.RAILWAY_ENVIRONMENT);
const VOLUME = process.env.RAILWAY_VOLUME_MOUNT_PATH;
const PERSISTENT = !ON_RAILWAY || (!!VOLUME && path.resolve(DATA_DIR).startsWith(path.resolve(VOLUME)));
if (!PERSISTENT) console.warn(`No Railway volume is mounted at ${DATA_DIR}: inboxes and history will be erased on the next deploy.`);
const db = new DatabaseSync(path.join(DATA_DIR, "warmup.db"));
let camp = null;   // the campaign sender, wired up once every helper below exists
const PANEL_HTML = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "panel.html"), "utf8");

db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
db.exec(`
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS inboxes (
  id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE, name TEXT, role TEXT DEFAULT 'sender',
  provider TEXT DEFAULT 'google', smtp_host TEXT, smtp_port INTEGER, imap_host TEXT, imap_port INTEGER,
  dkim_selector TEXT, password_enc TEXT, start_date TEXT, cap INTEGER, paused INTEGER DEFAULT 0,
  pause_reason TEXT, error_streak INTEGER DEFAULT 0, created_at TEXT);
CREATE TABLE IF NOT EXISTS sent (
  message_id TEXT PRIMARY KEY, sender TEXT, recipient TEXT, subject TEXT, body TEXT,
  thread_root TEXT, depth INTEGER, sent_at TEXT, day TEXT);
CREATE TABLE IF NOT EXISTS seen (
  message_id TEXT PRIMARY KEY, recipient TEXT, folder TEXT, rescued INTEGER, seen_at TEXT, day TEXT);
CREATE TABLE IF NOT EXISTS reply_queue (message_id TEXT PRIMARY KEY, due_at TEXT, done INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS events (at TEXT, level TEXT, inbox TEXT, message TEXT);
CREATE TABLE IF NOT EXISTS dns_checks (domain TEXT PRIMARY KEY, result TEXT, checked_at TEXT);
CREATE TABLE IF NOT EXISTS dkim_seen (domain TEXT PRIMARY KEY, result TEXT, via TEXT, at TEXT);
CREATE INDEX IF NOT EXISTS sent_sender_day ON sent(sender, day);
CREATE INDEX IF NOT EXISTS events_at ON events(at);
`);
// The last Test login result: 1 passed, 0 failed, NULL not tested since the password was saved.
for (const col of ["login_ok INTEGER", "login_at TEXT"]) { try { db.exec(`ALTER TABLE inboxes ADD COLUMN ${col}`); } catch { /* already there */ } }

// ── Settings ────────────────────────────────────────────────────────────────────
// Every number has a hard range. Values outside it are clamped on save, so a typo can't
// send 500 emails from a fresh domain.
const SETTINGS = {
  paused:            { def: true },
  timezone:          { def: "America/New_York" },
  startHour:         { def: 8,    min: 0,   max: 23 },
  endHour:           { def: 18,   min: 1,   max: 24 },
  tickMinutes:       { def: 10,   min: 5,   max: 60 },
  rampStart:         { def: 3,    min: 1,   max: 10 },
  rampPerDay:        { def: 2,    min: 1,   max: 5 },
  rampCap:           { def: 40,   min: 5,   max: 50 },
  weekendFactor:     { def: 0.5,  min: 0,   max: 1 },
  replyRate:         { def: 0.35, min: 0,   max: 0.6 },
  starRate:          { def: 0.2,  min: 0,   max: 0.5 },
  maxThreadDepth:    { def: 3,    min: 1,   max: 5 },
  replyDelayMin:     { def: 20,   min: 5,   max: 600 },
  replyDelayMax:     { def: 150,  min: 10,  max: 1440 },
  seedShare:         { def: 0.33, min: 0,   max: 1 },
  slowdownBelow:     { def: 85,   min: 50,  max: 100 },   // placement %: halve volume below this
  autoPauseBelow:    { def: 70,   min: 30,  max: 95 },    // placement %: pause the inbox below this
  requireDns:        { def: true },
  dkimConfirmed:     { def: false },   // the user says they clicked Start authentication in Google Admin
  coldMinWarmDays:   { def: 14,   min: 7,   max: 60 },    // an inbox sends cold email only after this many warm-up days
  coldMinPlacement:  { def: 90,   min: 75,  max: 100 },   // ...and only while 7-day placement is at least this
  coldDailyCap:      { def: 30,   min: 1,   max: 50 },    // cold emails per inbox per day, across all campaigns
  publicUrl:         { def: "" },
  replyWebhookUrl:   { def: "" },
  aiEnabled:         { def: true },
  aiModel:           { def: "anthropic/claude-haiku-4.5" },
  openrouterKeyEnc:  { def: "" },
  topics: { def: [
    "moving the weekly sync to Thursday", "notes from yesterday's customer call", "the Q4 planning doc",
    "a vendor quote that came in high", "hiring a contractor for design work", "feedback on the onboarding checklist",
    "the conference in November", "renewing the analytics tool", "a draft blog post", "pricing page wording",
    "the invoice from last month", "a podcast episode worth hearing", "reworking the demo script",
    "travel plans for the client visit", "the spreadsheet with lead sources", "a bug a customer reported",
    "lunch next week", "the partner intro from last week", "updating the case study", "trial users who went quiet"] },
};

function getSettings() {
  const out = Object.fromEntries(Object.entries(SETTINGS).map(([k, v]) => [k, v.def]));
  for (const r of db.prepare("SELECT key, value FROM settings").all()) if (r.key in SETTINGS) out[r.key] = JSON.parse(r.value);
  return out;
}

export function cleanSetting(key, value) {
  const spec = SETTINGS[key];
  if (!spec) throw new Error(`Unknown setting ${key}`);
  if (typeof spec.def === "number") {
    const n = Number(value);
    if (!Number.isFinite(n)) throw new Error(`${key} must be a number`);
    return Math.min(spec.max, Math.max(spec.min, n));
  }
  if (typeof spec.def === "boolean") return Boolean(value);
  if (Array.isArray(spec.def)) {
    const list = (Array.isArray(value) ? value : String(value).split("\n")).map((s) => String(s).trim()).filter(Boolean).slice(0, 200);
    if (!list.length) throw new Error("Add at least one topic");
    return list;
  }
  if (key === "timezone") { new Intl.DateTimeFormat("en", { timeZone: String(value) }); }  // throws on a bad zone
  if (key === "replyWebhookUrl" && value && !/^https:\/\/[^\s/]+\/\S*$/.test(String(value))) throw new Error("The reply webhook must be an https:// URL");
  return String(value).trim().slice(0, 500);
}

function saveSettings(patch) {
  const changed = {};
  for (const [k, v] of Object.entries(patch)) {
    if (k === "openrouterKey") { changed.openrouterKeyEnc = v ? encrypt(String(v).trim()) : ""; continue; }
    if (k === "openrouterKeyEnc") continue;
    changed[k] = cleanSetting(k, v);
  }
  const s = { ...getSettings(), ...changed };
  if (s.endHour <= s.startHour) throw new Error("End hour must be after start hour");
  if (s.replyDelayMax <= s.replyDelayMin) throw new Error("Max reply delay must be above the min");
  const stmt = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  for (const [k, v] of Object.entries(changed)) stmt.run(k, JSON.stringify(v));
  return s;
}

// ── Secrets: app passwords and the AI key are encrypted with a key kept on the volume ──
const KEY_FILE = path.join(DATA_DIR, "secret.key");
if (!fs.existsSync(KEY_FILE)) fs.writeFileSync(KEY_FILE, crypto.randomBytes(32).toString("hex"), { mode: 0o600 });
const KEY = Buffer.from(fs.readFileSync(KEY_FILE, "utf8").trim(), "hex");
function encrypt(text) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const ct = Buffer.concat([c.update(text, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
}
function decrypt(blob) {
  if (!blob) return "";
  const b = Buffer.from(blob, "base64"), d = crypto.createDecipheriv("aes-256-gcm", KEY, b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8");
}

// ── Inboxes ─────────────────────────────────────────────────────────────────────
const PROVIDERS = {
  google:    { smtp_host: "smtp.gmail.com",      smtp_port: 465, imap_host: "imap.gmail.com",        imap_port: 993, dkim_selector: "google" },
  microsoft: { smtp_host: "smtp.office365.com",  smtp_port: 587, imap_host: "outlook.office365.com", imap_port: 993, dkim_selector: "selector1" },
  zoho:      { smtp_host: "smtp.zoho.com",       smtp_port: 465, imap_host: "imap.zoho.com",         imap_port: 993, dkim_selector: "zmail" },
  custom:    { smtp_host: "", smtp_port: 465, imap_host: "", imap_port: 993, dkim_selector: "default" },
};
const EMAIL_RE = /^[a-z0-9._%+'-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/i;
const domainOf = (e) => e.split("@")[1].toLowerCase();
const listInboxes = () => db.prepare("SELECT * FROM inboxes ORDER BY role DESC, email").all();
const getInbox = (id) => db.prepare("SELECT * FROM inboxes WHERE id = ?").get(id);
const passwordOf = (i) => { try { return decrypt(i.password_enc); } catch { return ""; } };

function saveInbox(input, id) {
  const cur = id ? getInbox(id) : null;
  if (id && !cur) throw new Error("Inbox not found");
  const email = String(input.email ?? cur?.email ?? "").trim().toLowerCase();
  if (!EMAIL_RE.test(email)) throw new Error("Enter a valid email address");
  // History (sends, placement, replies) is keyed on the address, so it can't change in place.
  if (cur && email !== cur.email) throw new Error("The address can't be changed. Add it as a new inbox instead.");
  const provider = PROVIDERS[input.provider] ? input.provider : cur?.provider || "google";
  const p = PROVIDERS[provider];
  const pick = (k) => (input[k] !== undefined && input[k] !== "" ? input[k] : cur && cur.provider === provider ? cur[k] : p[k]);
  const capRaw = input.cap === undefined ? cur?.cap : input.cap;
  const row = {
    email, name: String(input.name ?? cur?.name ?? "").trim().slice(0, 80) || email.split("@")[0],
    role: (input.role ?? cur?.role) === "seed" ? "seed" : "sender", provider,
    smtp_host: String(pick("smtp_host")), smtp_port: Number(pick("smtp_port")),
    imap_host: String(pick("imap_host")), imap_port: Number(pick("imap_port")),
    dkim_selector: String(pick("dkim_selector") || "default"),
    start_date: /^\d{4}-\d{2}-\d{2}$/.test(input.start_date || "") ? input.start_date : cur?.start_date || localParts(new Date(), getSettings().timezone).day,
    cap: capRaw === null || capRaw === "" || capRaw === undefined ? null : Math.min(SETTINGS.rampCap.max, Math.max(1, Number(capRaw) || 1)),
    paused: input.paused === undefined ? cur?.paused ?? 0 : input.paused ? 1 : 0,
  };
  if (!row.smtp_host || !row.imap_host) throw new Error("SMTP and IMAP hosts are required for a custom provider");
  const password_enc = input.password ? encrypt(String(input.password).replace(/\s+/g, "")) : cur?.password_enc || "";
  if (cur && input.password) db.prepare("UPDATE inboxes SET login_ok = NULL, login_at = NULL WHERE id = ?").run(cur.id);
  if (cur && input.password && String(cur.pause_reason || "").startsWith(AUTH_PAUSE))
    db.prepare("UPDATE inboxes SET pause_reason = ? WHERE id = ?").run("New app password saved. Press Resume to start again.", cur.id);
  if (cur) {
    db.prepare(`UPDATE inboxes SET email=?, name=?, role=?, provider=?, smtp_host=?, smtp_port=?, imap_host=?, imap_port=?,
      dkim_selector=?, start_date=?, cap=?, paused=?, password_enc=?, pause_reason=CASE WHEN ? = 0 THEN NULL ELSE pause_reason END,
      error_streak=CASE WHEN ? = 0 THEN 0 ELSE error_streak END WHERE id=?`)
      .run(row.email, row.name, row.role, row.provider, row.smtp_host, row.smtp_port, row.imap_host, row.imap_port,
        row.dkim_selector, row.start_date, row.cap, row.paused, password_enc, row.paused, row.paused, id);
  } else {
    if (db.prepare("SELECT 1 FROM inboxes WHERE email = ?").get(email)) throw new Error("That inbox is already added");
    id = Number(db.prepare(`INSERT INTO inboxes (email, name, role, provider, smtp_host, smtp_port, imap_host, imap_port, dkim_selector,
      start_date, cap, paused, password_enc, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(row.email, row.name, row.role, row.provider, row.smtp_host, row.smtp_port, row.imap_host, row.imap_port, row.dkim_selector,
        row.start_date, row.cap, row.paused, password_enc, new Date().toISOString()).lastInsertRowid);
    if (row.role === "sender") checkDomain(domainOf(email), true).catch(() => {});
  }
  transports.delete(email); if (cur) transports.delete(cur.email);
  event("info", email, cur ? "Inbox settings updated" : `Inbox added (${row.role})`);
  return getInbox(id);
}

const AUTH_PAUSE = "the mailbox rejected the app password";
function pauseInbox(inbox, reason) {
  db.prepare("UPDATE inboxes SET paused = 1, pause_reason = ? WHERE id = ?").run(reason, inbox.id);
  event("warn", inbox.email, `Paused automatically: ${reason}`);
}

// ── Time, in the configured time zone ─────────────────────────────────────────────
function localParts(d = new Date(), tz = "UTC") {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hour12: false });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24, minute: Number(p.minute), weekday: p.weekday };
}
const isWeekend = (wd) => wd === "Sat" || wd === "Sun";
const dayDiff = (a, b) => Math.round((Date.parse(a + "T00:00:00Z") - Date.parse(b + "T00:00:00Z")) / 86400000);
const daysAgo = (n, tz) => localParts(new Date(Date.now() - n * 86400000), tz).day;

// ── DNS: no sending from a domain the receivers can't authenticate ────────────────
async function txt(name) {
  try { return (await dns.resolveTxt(name)).map((r) => r.join("")); } catch { return []; }
}
const dnsInFlight = new Map();
function checkDomain(domain, force = false) {
  if (!dnsInFlight.has(domain)) dnsInFlight.set(domain, checkDomainNow(domain, force).finally(() => dnsInFlight.delete(domain)));
  return dnsInFlight.get(domain);
}
async function checkDomainNow(domain, force) {
  const cached = db.prepare("SELECT * FROM dns_checks WHERE domain = ?").get(domain);
  if (!force && cached && Date.now() - Date.parse(cached.checked_at) < 6 * 3600000) return JSON.parse(cached.result);
  const selectors = [...new Set(db.prepare("SELECT dkim_selector FROM inboxes WHERE email LIKE ?").all(`%@${domain}`).map((r) => r.dkim_selector || "default"))];
  const spfRec = (await txt(domain)).find((t) => /^v=spf1/i.test(t)) || null;
  const dmarcRec = (await txt(`_dmarc.${domain}`)).find((t) => /^v=DMARC1/i.test(t)) || null;
  let dkimRec = null, dkimSel = null;
  for (const s of selectors.length ? selectors : ["google"]) {
    const r = (await txt(`${s}._domainkey.${domain}`)).find((t) => /v=DKIM1|k=rsa|p=/i.test(t));
    if (r) { dkimRec = r; dkimSel = s; break; }
  }
  const result = { domain, spf: spfRec, dkim: dkimRec ? `${dkimSel}: ${dkimRec.slice(0, 60)}...` : null, dmarc: dmarcRec,
    selectorsTried: selectors, ok: Boolean(spfRec && dkimRec && dmarcRec), checkedAt: new Date().toISOString() };
  db.prepare("INSERT INTO dns_checks VALUES (?,?,?) ON CONFLICT(domain) DO UPDATE SET result = excluded.result, checked_at = excluded.checked_at")
    .run(domain, JSON.stringify(result), result.checkedAt);
  if (!cached || JSON.parse(cached.result).ok !== result.ok)
    event(result.ok ? "info" : "warn", domain, result.ok ? "DNS check passed (SPF, DKIM, DMARC found)" :
      `DNS check failed: missing ${["SPF", "DKIM", "DMARC"].filter((_, i) => ![spfRec, dkimRec, dmarcRec][i]).join(", ")}. Sending from this domain is blocked.`);
  return result;
}

// ── Health: placement over the last few days drives slowdown and auto-pause ───────
function placement(email, sinceDay) {
  const r = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(folder='inbox'),0) inbox FROM seen
    WHERE day >= ? AND message_id IN (SELECT message_id FROM sent WHERE sender = ?)`).get(sinceDay, email);
  return { checked: r.n, inbox: r.inbox, pct: r.n ? Math.round((100 * r.inbox) / r.n) : null };
}

// The ramp: start small, add a little each day, never above the cap. Weekends lower,
// and half volume while recent placement sits below the slowdown line.
export function dailyTarget(inbox, s, now = new Date()) {
  const today = localParts(now, s.timezone);
  const dayN = dayDiff(today.day, inbox.start_date) + 1;
  if (dayN < 1) return { dayN: 0, target: 0, slowed: false };
  const cap = Math.min(inbox.cap || s.rampCap, s.rampCap);
  let n = Math.min(cap, s.rampStart + s.rampPerDay * (dayN - 1));
  if (isWeekend(today.weekday)) n = Math.ceil(n * s.weekendFactor);
  const p = placement(inbox.email, daysAgo(3, s.timezone));
  const slowed = p.checked >= 6 && p.pct < s.slowdownBelow;
  if (slowed) n = Math.ceil(n / 2);
  return { dayN, target: n, slowed };
}

function healthGuard(inbox, s) {
  const p = placement(inbox.email, daysAgo(3, s.timezone));
  if (p.checked >= 8 && p.pct < s.autoPauseBelow) {
    pauseInbox(inbox, `inbox placement fell to ${p.pct}% over the last 3 days (${p.inbox}/${p.checked}). Fix the cause, then resume.`);
    return false;
  }
  return true;
}

// ── Writing the emails ──────────────────────────────────────────────────────────
const first = (name) => String(name).split(" ")[0];
const pickOne = (arr) => arr[Math.floor(Math.random() * arr.length)];
const rand = (a, b) => a + Math.random() * (b - a);
const cap1 = (t) => t[0].toUpperCase() + t.slice(1);

const TEMPLATES = [
  (t, to, from) => ({ subject: cap1(t), body: `Hi ${to},\n\nDo you have a minute this week to look at ${t}? I put a few notes together and would value a second opinion before Friday.\n\nThanks,\n${from}` }),
  (t, to, from) => ({ subject: "Quick question", body: `Hey ${to},\n\nWhere did we land on ${t}? I want to close it out before the end of the week, so even a short answer helps.\n\n${from}` }),
  (t, to, from) => ({ subject: `Re ${t}`, body: `Hi ${to},\n\nSmall update on ${t}: I made a first pass and it looks simpler than we thought. I'll share the notes once I tidy them up. Anything you want me to add?\n\n${from}` }),
  (t, to, from) => ({ subject: cap1(t), body: `${to},\n\nCan we talk about ${t} on Tuesday or Wednesday? Fifteen minutes should be enough. Let me know what suits you.\n\nCheers,\n${from}` }),
];
const REPLIES = [
  (to, from) => `Hi ${to},\n\nThanks, that works for me. Let's go with that.\n\n${from}`,
  (to, from) => `Sounds good, ${to}. I'll take a look this afternoon and get back to you.\n\n${from}`,
  (to, from) => `Thanks ${to}. Tuesday is better for me if that's still open.\n\n${from}`,
  (to, from) => `Got it, thanks for the heads up. I'll keep you posted.\n\n${from}`,
];

const openrouterKey = (s) => { try { return decrypt(s.openrouterKeyEnc) || process.env.OPENROUTER_API_KEY || ""; } catch { return process.env.OPENROUTER_API_KEY || ""; } };
const stripLinks = (t) => t.replace(/https?:\/\/\S+|www\.\S+/gi, "").replace(/\s*[—–]\s*/g, ", ").replace(/[ \t]+\n/g, "\n").trim();

async function askAI(s, prompt) {
  const key = openrouterKey(s);
  if (!key) throw new Error("No OpenRouter key set");
  const res = await fetch((process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1") + "/chat/completions", {
    method: "POST", signal: AbortSignal.timeout(45000),
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "HTTP-Referer": "https://pitchpersona.app", "X-Title": "PitchPersona Warm-up" },
    body: JSON.stringify({ model: s.aiModel, max_tokens: 500, temperature: 0.9, messages: [{ role: "user", content: prompt }] }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(`OpenRouter: ${data.error?.message || res.status}`);
  const text = data.choices?.[0]?.message?.content || "";
  const json = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
  return { json, cost: data.usage?.cost ?? null };
}

async function writeEmail(s, { from, to, topic, previous }) {
  const fallback = () => previous
    ? { subject: `Re: ${previous.subject.replace(/^Re:\s*/i, "")}`, body: pickOne(REPLIES)(first(previous.senderName), first(from.name)) }
    : pickOne(TEMPLATES)(topic, first(to.name), first(from.name));
  if (DRY || !s.aiEnabled || !openrouterKey(s)) return { ...fallback(), by: "template" };
  const prompt = previous
    ? `You are ${from.name}. Write a short, natural reply (20-60 words) to this email from ${previous.senderName}.
Plain text only. No links, no images, no sales language, no em dashes. Sound like a real colleague: casual, specific, sometimes a question back.
Sign off with just "${first(from.name)}".

Their email:
"""${previous.body.slice(0, 1500)}"""

Reply with only JSON: {"body": "..."}`
    : `You are ${from.name}, writing to ${to.name}, someone you work with occasionally.
Write a short, ordinary work email (40-110 words) about: ${topic}.
Plain text only. No links, no images, no sales language, no em dashes, no "hope this finds you well".
Vary the opening; it can ask a question, share a small update or request a quick favor.
Subject: 2-6 words, normal capitalisation, not clickbait. Sign off with just "${first(from.name)}".

Reply with only JSON: {"subject": "...", "body": "..."}`;
  try {
    const { json } = await askAI(s, prompt);
    if (previous) json.subject = `Re: ${previous.subject.replace(/^Re:\s*/i, "")}`;
    if (!json.body || !json.subject) throw new Error("AI answer missing subject or body");
    return { subject: stripLinks(String(json.subject)).slice(0, 120), body: stripLinks(String(json.body)).slice(0, 2000), by: "ai" };
  } catch (e) {
    event("warn", from.email, `AI writer failed, used a template instead: ${String(e.message).slice(0, 200)}`);
    return { ...fallback(), by: "template" };
  }
}

// ── Sending ─────────────────────────────────────────────────────────────────────
const transports = new Map();
function transport(inbox) {
  if (!transports.has(inbox.email)) {
    transports.set(inbox.email, nodemailer.createTransport({
      host: inbox.smtp_host, port: inbox.smtp_port, secure: inbox.smtp_port === 465, requireTLS: inbox.smtp_port !== 465,
      auth: { user: inbox.email, pass: passwordOf(inbox) }, connectionTimeout: 20000, greetingTimeout: 20000,
    }));
  }
  return transports.get(inbox.email);
}

// Provider push-back that means "stop now", not "try again later".
const HARD_STOP = /spam|blocked|blacklist|reputation|suspicious|rate limit|too many|daily (user )?sending quota|5\.7\.\d|550|554|421 4\.7/i;
// "No such mailbox" at RCPT time: the address is bad, the inbox is fine.
const RECIPIENT_BAD = /5\.1\.\d+|user unknown|unknown user|no such (user|mailbox)|does not exist|recipient address rejected|address not found|invalid recipient/i;

// Every SMTP send, warm-up or campaign, goes through here so the push-back guard applies to both.
async function smtpSend(from, mail, { test = false } = {}) {
  // Re-read at the moment of sending: a pause pressed mid-cycle, or an inbox that paused
  // itself a second ago, must stop everything still queued in this cycle.
  const live = db.prepare("SELECT paused FROM inboxes WHERE id = ?").get(from.id);
  if (!live) throw new Error("Inbox was removed");
  if (live.paused) throw Object.assign(new Error("Inbox is paused"), { code: "PAUSED" });
  if (!test && getSettings().paused) throw Object.assign(new Error("Warm-up is paused"), { code: "PAUSED" });
  if (DRY) return;
  try {
    await transport(from).sendMail({ from: `"${from.name}" <${from.email}>`, ...mail });
    db.prepare("UPDATE inboxes SET error_streak = 0 WHERE id = ?").run(from.id);
  } catch (e) {
    const msg = String(e?.response || e?.message || e);
    if ((e?.code === "EENVELOPE" || /RCPT/i.test(e?.command || "")) && RECIPIENT_BAD.test(msg) && !/5\.7\.\d/.test(msg))
      throw Object.assign(e, { recipientRejected: true });
    const streak = db.prepare("UPDATE inboxes SET error_streak = error_streak + 1 WHERE id = ? RETURNING error_streak").get(from.id).error_streak;
    if (HARD_STOP.test(msg)) pauseInbox(from, `the provider refused a send: "${msg.slice(0, 160)}"`);
    else if (streak >= 3) pauseInbox(from, `3 sends failed in a row. Last error: "${msg.slice(0, 160)}"`);
    throw e;
  }
}

async function send(s, { from, to, subject, body, inReplyTo, threadRoot, depth, test = false }) {
  const messageId = `<${crypto.randomUUID()}@${domainOf(from.email)}>`;
  await smtpSend(from, {
    to: `"${to.name}" <${to.email}>`, subject, text: body, messageId,
    ...(inReplyTo ? { inReplyTo, references: [threadRoot, inReplyTo].filter((v, i, a) => v && a.indexOf(v) === i) } : {}),
  }, { test });
  db.prepare("INSERT INTO sent VALUES (?,?,?,?,?,?,?,?,?)").run(messageId, from.email, to.email, subject, body,
    threadRoot || messageId, depth, new Date().toISOString(), localParts(new Date(), s.timezone).day);
  event("send", from.email, `${DRY ? "[dry] " : ""}${depth ? "Replied to" : "Sent to"} ${to.email}: "${subject}"`);
  return messageId;
}

function chooseRecipient(s, from, pool) {
  const others = pool.filter((i) => i.email !== from.email);
  const seeds = others.filter((i) => i.role === "seed");
  if (seeds.length && Math.random() < s.seedShare) return pickOne(seeds);
  const senders = others.filter((i) => i.role === "sender");
  const otherDomain = senders.filter((i) => domainOf(i.email) !== domainOf(from.email));
  return otherDomain.length ? pickOne(otherDomain) : senders.length ? pickOne(senders) : seeds.length ? pickOne(seeds) : null;
}

const inWindow = (s, now) => now.hour >= s.startHour && now.hour < s.endHour;
const sentToday = (email, day) => db.prepare("SELECT COUNT(*) c FROM sent WHERE sender = ? AND day = ? AND depth = 0").get(email, day).c;

// Why an inbox can't send right now, or null when it can.
async function blockedReason(s, inbox) {
  if (inbox.paused) return inbox.pause_reason ? `Paused: ${inbox.pause_reason}` : "Paused";
  if (!inbox.password_enc && !DRY) return "No app password saved";
  if (inbox.role === "sender" && s.requireDns && !DRY) {
    const d = await checkDomain(domainOf(inbox.email));
    if (!d.ok) return `DNS not ready: missing ${["SPF", "DKIM", "DMARC"].filter((k) => !d[k.toLowerCase()]).join(", ")}`;
  }
  return null;
}

// Day 1 of the ramp is the first day an inbox can send, not the day it was added. An inbox added
// days before Start would otherwise begin at a later day's volume. A hand-picked day 1 is kept.
function rampFromToday() {
  const tz = getSettings().timezone, today = localParts(new Date(), tz).day;
  const moved = listInboxes().filter((i) => i.role === "sender" && i.start_date < today && i.created_at
    && i.start_date === localParts(new Date(i.created_at), tz).day && !db.prepare("SELECT 1 FROM sent WHERE sender = ? LIMIT 1").get(i.email));
  for (const i of moved) db.prepare("UPDATE inboxes SET start_date = ? WHERE id = ?").run(today, i.id);
  if (moved.length) event("info", null, `Warm-up day 1 set to today for ${moved.length} inbox${moved.length > 1 ? "es" : ""} that hadn't sent yet`);
}

// Why the mailer can't do anything yet, in words the panel shows as is; null when it can start.
function startBlock(all = listInboxes()) {
  const senders = all.filter((i) => i.role === "sender");
  if (!all.length) return "Add your inboxes first. Warm-up sends emails between your own inboxes, so it needs at least two.";
  if (!senders.length) return "Add at least one sending inbox. Seeds only receive and reply.";
  if (all.length < 2) return "Add at least one more inbox. Warm-up sends between your own inboxes, so a single inbox has no one to write to.";
  if (!DRY && !senders.some((i) => i.password_enc)) return "Save an app password for at least one sending inbox.";
  return null;
}

async function sendPhase(s, pool, force) {
  const now = localParts(new Date(), s.timezone);
  if (!DRY && !force && !inWindow(s, now)) return;
  const ticksLeft = Math.max(1, Math.ceil(((s.endHour - now.hour) * 60 - now.minute) / s.tickMinutes));
  for (const from of pool.filter((i) => i.role === "sender")) {
    if (await blockedReason(s, from)) continue;
    if (!healthGuard(from, s)) continue;
    const { target } = dailyTarget(from, s);
    const remaining = target - sentToday(from.email, now.day);
    if (remaining <= 0) continue;
    if (!DRY && !force && Math.random() > Math.min(1, remaining / ticksLeft)) continue;  // spread sends over the day
    const to = chooseRecipient(s, from, pool);
    if (!to) continue;
    try {
      const email = await writeEmail(s, { from, to, topic: pickOne(s.topics) });
      await send(s, { from, to, ...email, depth: 0 });
    } catch (e) { if (e.code !== "PAUSED") event("error", from.email, `Send failed: ${String(e.message).slice(0, 250)}`); }
  }
}

// ── Reading: rescue from spam, engage, queue replies ───────────────────────────
async function withImap(inbox, fn) {
  const client = new ImapFlow({ host: inbox.imap_host, port: inbox.imap_port || 993, secure: true,
    auth: { user: inbox.email, pass: passwordOf(inbox) }, logger: false,
    connectionTimeout: 20000, greetingTimeout: 15000, socketTimeout: 120000 });
  // Without a listener, a socket error would be an uncaught 'error' event and kill the process.
  client.on("error", (e) => event("error", inbox.email, `Mail server connection error: ${String(e?.message || e).slice(0, 200)}`));
  await client.connect();
  try { return await fn(client); } finally { await client.logout().catch(() => {}); }
}

// Reads one inbox. Returns true when the campaign reply scan covered every folder, which
// is what allows this inbox to send campaign emails in the same cycle.
async function readInbox(s, inbox, pool) {
  const day = localParts(new Date(), s.timezone).day;
  const poolAddrs = pool.map((i) => i.email).filter((e) => e !== inbox.email);
  let scanOk = true;
  await withImap(inbox, async (client) => {
    const boxes = await client.list();
    const junk = boxes.find((b) => b.specialUse === "\\Junk")?.path;
    // Replies are scanned in All Mail on Google, so a reply that was read and archived
    // before the next cycle is still seen. Warm-up mail is handled in the inbox and spam.
    const all = inbox.provider === "google" ? boxes.find((b) => b.specialUse === "\\All")?.path : null;
    const folders = new Map();
    folders.set("INBOX", { warm: true, scan: !all });
    if (all) folders.set(all, { warm: false, scan: true });
    if (junk) folders.set(junk, { warm: true, scan: true });
    for (const [folder, job] of folders) {
      const lock = await client.getMailboxLock(folder);
      try {
        if (job.scan && inbox.role === "sender") {
          try { await camp.scanFolder(client, inbox, folder, folder === junk); }
          catch (e) { scanOk = false; event("error", inbox.email, `Reply scan of ${folder} failed: ${String(e.message).slice(0, 200)}`); }
        }
        if (!job.warm || !poolAddrs.length) continue;
        const query = { since: new Date(Date.now() - 3 * 86400000) };
        if (poolAddrs.length === 1) query.from = poolAddrs[0]; else query.or = poolAddrs.map((a) => ({ from: a }));
        const uids = await client.search(query, { uid: true });
        if (!uids || !uids.length) continue;
        // Fetch everything first: imapflow can't run other commands inside a fetch loop.
        const msgs = await client.fetchAll(uids, { uid: true, envelope: true, headers: ["authentication-results", "dkim-signature"] }, { uid: true });
        for (const msg of msgs) {
          const id = msg.envelope?.messageId;
          const own = id && db.prepare("SELECT sender FROM sent WHERE message_id = ?").get(id);
          if (!own) continue;   // only our own warm-up mail
          if (db.prepare("SELECT 1 FROM seen WHERE message_id = ?").get(id)) continue;
          const dkim = dkimVerdict(msg.headers, domainOf(own.sender));
          if (dkim) db.prepare("INSERT INTO dkim_seen VALUES (?,?,?,?) ON CONFLICT(domain) DO UPDATE SET result = excluded.result, via = excluded.via, at = excluded.at")
            .run(domainOf(own.sender), dkim, inbox.email, new Date().toISOString());
          const inSpam = folder === junk;
          await client.messageFlagsAdd(msg.uid, ["\\Seen"], { uid: true });
          if (Math.random() < s.starRate) await client.messageFlagsAdd(msg.uid, ["\\Flagged"], { uid: true });
          if (inbox.provider === "google") await client.messageFlagsAdd(msg.uid, ["\\Important"], { uid: true, useLabels: true }).catch(() => {});
          if (inSpam) { await client.messageMove(msg.uid, "INBOX", { uid: true }); event("warn", inbox.email, `Rescued from spam: "${msg.envelope.subject}"`); }
          // Recorded only once handled, so a dropped connection means a retry, not a skipped message.
          db.prepare("INSERT OR IGNORE INTO seen VALUES (?,?,?,?,?,?)").run(id, inbox.email, inSpam ? "spam" : "inbox", inSpam ? 1 : 0, new Date().toISOString(), day);
          const row = db.prepare("SELECT depth FROM sent WHERE message_id = ?").get(id);
          if (row.depth < s.maxThreadDepth && Math.random() < s.replyRate) {
            const due = new Date(Date.now() + rand(s.replyDelayMin, s.replyDelayMax) * 60000).toISOString();
            db.prepare("INSERT OR IGNORE INTO reply_queue (message_id, due_at) VALUES (?, ?)").run(id, due);
          }
        }
      } finally { lock.release(); }
    }
  });
  return scanOk;
}

// Returns the ids of inboxes whose reply scan succeeded this cycle.
async function readPhase(s, pool) {
  const scanned = new Set();
  if (DRY) { pool.forEach((i) => scanned.add(i.id)); return scanned; }
  // In parallel, so one slow or dead mailbox can't hold up the rest.
  // An inbox whose password was rejected isn't retried until a new one is saved: repeated
  // failed logins can get the account locked.
  const readable = pool.filter((i) => i.password_enc && !(i.paused && String(i.pause_reason || "").startsWith(AUTH_PAUSE)));
  await Promise.all(readable.map((inbox) =>
    readInbox(s, inbox, pool).then((ok) => { if (ok) scanned.add(inbox.id); }).catch((e) => {
      // A rejected login won't fix itself; stop retrying a bad password every few minutes.
      if (isAuthError(e)) { pauseInbox(inbox, `${AUTH_PAUSE}. Save a new one, then resume.`); db.prepare("UPDATE inboxes SET login_ok = 0, login_at = ? WHERE id = ?").run(new Date().toISOString(), inbox.id); }
      else event("error", inbox.email, `Reading the inbox failed: ${imapError(e)}`);
    })));
  return scanned;
}

async function replyPhase(s, force) {
  const now = localParts(new Date(), s.timezone);
  if (!DRY && !force && !inWindow(s, now)) return;
  const due = db.prepare("SELECT s.* FROM reply_queue q JOIN sent s ON s.message_id = q.message_id WHERE q.done = 0 AND q.due_at <= ? ORDER BY q.due_at").all(new Date().toISOString());
  const repliedThisTick = new Set();
  for (const row of due) {
    // Fresh rows each time, so an inbox paused a moment ago stops here too.
    const from = db.prepare("SELECT * FROM inboxes WHERE email = ?").get(row.recipient), to = db.prepare("SELECT * FROM inboxes WHERE email = ?").get(row.sender);
    if (!from || !to) { db.prepare("UPDATE reply_queue SET done = 1 WHERE message_id = ?").run(row.message_id); continue; }
    if (repliedThisTick.has(from.id)) continue;     // one reply per inbox per cycle; the rest wait for the next one
    if (await blockedReason(s, from)) continue;      // stays queued until the inbox can send again
    db.prepare("UPDATE reply_queue SET done = 1 WHERE message_id = ?").run(row.message_id);
    repliedThisTick.add(from.id);
    try {
      const email = await writeEmail(s, { from, to, previous: { ...row, senderName: to.name } });
      await send(s, { from, to, ...email, inReplyTo: row.message_id, threadRoot: row.thread_root, depth: row.depth + 1 });
    } catch (e) {
      if (e.code === "PAUSED") db.prepare("UPDATE reply_queue SET done = 0 WHERE message_id = ?").run(row.message_id);
      else event("error", from.email, `Reply failed: ${String(e.message).slice(0, 250)}`);
    }
  }
  // Replies that waited more than two days are dropped; a late reply looks odd.
  db.prepare("UPDATE reply_queue SET done = 1 WHERE done = 0 AND due_at < ?").run(new Date(Date.now() - 2 * 86400000).toISOString());
}

// ── Scheduler ───────────────────────────────────────────────────────────────────
const state = { running: false, lastTickAt: null, nextTickAt: null, timer: null };
async function tick({ force = false } = {}) {
  if (state.running) return false;
  const s = getSettings();
  if (s.paused && !DRY) return false;
  state.running = true;
  try {
    const scanned = await readPhase(s, listInboxes());
    await replyPhase(s, force);
    await sendPhase(s, listInboxes(), force);
    await camp.sendPhase(getSettings(), listInboxes(), scanned);
    db.prepare("DELETE FROM events WHERE at < ?").run(new Date(Date.now() - 30 * 86400000).toISOString());
  } finally { state.running = false; state.lastTickAt = new Date().toISOString(); }
  return true;
}
function schedule() {
  clearTimeout(state.timer);
  const ms = getSettings().tickMinutes * 60000;
  state.nextTickAt = new Date(Date.now() + ms).toISOString();
  state.timer = setTimeout(async () => { try { await tick(); } catch (e) { event("error", null, `Cycle failed: ${e.message}`); } schedule(); }, ms);
}

// ── Stats for the panel ─────────────────────────────────────────────────────────
export async function overview() {
  const s = getSettings();
  const today = localParts(new Date(), s.timezone).day, since7 = daysAgo(6, s.timezone), since30 = daysAgo(29, s.timezone);
  const inboxes = [];
  for (const i of listInboxes()) {
    const { dayN, target, slowed } = i.role === "sender" ? dailyTarget(i, s) : { dayN: null, target: 0, slowed: false };
    const p7 = placement(i.email, since7);
    const blocked = await blockedReason(s, i);
    const errors7 = db.prepare("SELECT COUNT(*) c FROM events WHERE inbox = ? AND level = 'error' AND at >= ?").get(i.email, new Date(Date.now() - 7 * 86400000).toISOString()).c;
    const health = p7.pct == null ? null : Math.max(0, Math.min(100, p7.pct - errors7 * 3));
    inboxes.push({
      id: i.id, email: i.email, name: i.name, role: i.role, provider: i.provider, smtp_host: i.smtp_host, smtp_port: i.smtp_port,
      imap_host: i.imap_host, imap_port: i.imap_port, dkim_selector: i.dkim_selector, start_date: i.start_date, cap: i.cap,
      paused: !!i.paused, pause_reason: i.pause_reason, hasPassword: !!i.password_enc, day: dayN, targetToday: target, slowed,
      login: i.login_ok == null ? null : i.login_ok ? "ok" : "failed", loginAt: i.login_at,
      coldOk: i.role === "sender" ? (await camp.coldStatus(s, i)).ok : false,
      sentToday: db.prepare("SELECT COUNT(*) c FROM sent WHERE sender = ? AND day = ?").get(i.email, today).c,
      sent7d: db.prepare("SELECT COUNT(*) c FROM sent WHERE sender = ? AND day >= ?").get(i.email, since7).c,
      received7d: db.prepare("SELECT COUNT(*) c FROM seen WHERE recipient = ? AND day >= ?").get(i.email, since7).c,
      placement7d: p7.pct, checked7d: p7.checked, inbox7d: p7.inbox, errors7d: errors7, health,
      status: blocked ? "blocked" : i.role === "seed" ? "seed" : slowed ? "slowed" : "active", blocked,
      daily: db.prepare(`SELECT day, COUNT(*) sent FROM sent WHERE sender = ? AND day >= ? GROUP BY day`).all(i.email, since30),
    });
  }
  const days = [];
  for (let n = 29; n >= 0; n--) days.push(daysAgo(n, s.timezone));
  const sentBy = Object.fromEntries(db.prepare("SELECT day, COUNT(*) c, SUM(depth > 0) r FROM sent WHERE day >= ? GROUP BY day").all(since30).map((r) => [r.day, r]));
  const seenBy = Object.fromEntries(db.prepare("SELECT day, SUM(folder='inbox') i, SUM(folder='spam') sp FROM seen WHERE day >= ? GROUP BY day").all(since30).map((r) => [r.day, r]));
  const daily = days.map((d) => ({ day: d, sent: sentBy[d]?.c || 0, replies: sentBy[d]?.r || 0, inbox: seenBy[d]?.i || 0, spam: seenBy[d]?.sp || 0 }));
  const domains = [];
  for (const d of [...new Set(listInboxes().filter((i) => i.role === "sender").map((i) => domainOf(i.email)))])
    domains.push({ ...(await checkDomain(d)), signing: db.prepare("SELECT result, via, at FROM dkim_seen WHERE domain = ?").get(d) || null });
  const tot7 = daily.slice(-7).reduce((a, d) => ({ inbox: a.inbox + d.inbox, spam: a.spam + d.spam, sent: a.sent + d.sent }), { inbox: 0, spam: 0, sent: 0 });
  const { openrouterKeyEnc, ...pub } = s;
  const readiness = { startBlock: startBlock(), senders: inboxes.filter((i) => i.role === "sender").length,
    readySenders: inboxes.filter((i) => i.role === "sender" && !i.blocked).length };
  return {
    readiness,
    now: new Date().toISOString(), today, dry: DRY, storage: { persistent: PERSISTENT, dataDir: DATA_DIR }, settings: { ...pub, aiKeySet: !!openrouterKey(s), aiKeyFromEnv: !openrouterKeyEnc && !!process.env.OPENROUTER_API_KEY },
    limits: Object.fromEntries(Object.entries(SETTINGS).filter(([, v]) => typeof v.def === "number").map(([k, v]) => [k, [v.min, v.max]])),
    scheduler: { running: state.running, lastTickAt: state.lastTickAt, nextTickAt: state.nextTickAt, inWindow: inWindow(s, localParts(new Date(), s.timezone)) },
    totals: { sentToday: daily.at(-1).sent, repliesToday: daily.at(-1).replies, sent7d: tot7.sent, placement7d: tot7.inbox + tot7.spam ? Math.round((100 * tot7.inbox) / (tot7.inbox + tot7.spam)) : null, rescued7d: tot7.spam,
      queued: db.prepare("SELECT COUNT(*) c FROM reply_queue WHERE done = 0").get().c,
      sentEver: db.prepare("SELECT COUNT(*) c FROM sent").get().c, seenEver: db.prepare("SELECT COUNT(*) c FROM seen").get().c },
    campaigns: db.prepare("SELECT COUNT(*) count, COALESCE(SUM(status = 'active'), 0) active FROM campaigns").get(),
    inboxes, daily, domains, providers: PROVIDERS,
    events: db.prepare("SELECT * FROM events ORDER BY at DESC LIMIT 80").all(),
  };
}

function recentMail(limit = 50, inbox = null) {
  return db.prepare(`SELECT s.message_id id, s.sender, s.recipient, s.subject, s.body, s.depth, s.sent_at, v.folder FROM sent s
    LEFT JOIN seen v ON v.message_id = s.message_id ${inbox ? "WHERE s.sender = ? OR s.recipient = ?" : ""} ORDER BY s.sent_at DESC LIMIT ?`)
    .all(...(inbox ? [inbox, inbox] : []), Math.min(200, limit));
}

// ── Control panel server ────────────────────────────────────────────────────────
const PANEL_PASSWORD = process.env.PANEL_PASSWORD || "";
const sign = (v) => crypto.createHmac("sha256", KEY).update(v).digest("base64url");
const makeSession = () => { const exp = String(Date.now() + 14 * 86400000); return `${exp}.${sign("s:" + exp)}`; };
function validSession(req) {
  const m = /(?:^|;\s*)ww=([^;]+)/.exec(req.headers.cookie || "");
  if (!m) return false;
  const [exp, sig] = m[1].split(".");
  const want = sign("s:" + exp);
  return Number(exp) > Date.now() && sig?.length === want.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want));
}
const attempts = new Map();
function clientIp(req) {
  // Railway's proxy appends the real client address, so the last hop is the trustworthy one.
  const xff = String(req.headers["x-forwarded-for"] || "").split(",").map((x) => x.trim()).filter(Boolean);
  return String(req.headers["x-real-ip"] || xff.at(-1) || req.socket.remoteAddress);
}
// Failed sign-ins in the last 15 minutes: 10 per address, 50 overall.
function rateLimited(ip) {
  const now = Date.now(), win = 15 * 60000;
  for (const [k, v] of attempts) { const kept = v.filter((t) => now - t < win); if (kept.length) attempts.set(k, kept); else attempts.delete(k); }
  const all = [...attempts.values()].reduce((n, v) => n + v.length, 0);
  return (attempts.get(ip) || []).length >= 10 || all >= 50;
}
const failedLogin = (ip) => attempts.set(ip, [...(attempts.get(ip) || []), Date.now()]);
function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", (c) => { size += c.length; if (size > 200000) { reject(new Error("Body too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); } catch { reject(new Error("Invalid JSON")); } });
  });
}

const isAuthError = (e) => e?.authenticationFailed || /AUTHENTICATIONFAILED|Invalid credentials|LOGIN failed/i.test(String(e?.responseText || e?.message));
const imapError = (e) => (isAuthError(e) ? "the password was rejected" : String(e?.responseText || e?.message || e)).slice(0, 250);

async function testInbox(i) {
  const out = { smtp: null, imap: null };
  try { transports.delete(i.email); await transport(i).verify(); out.smtp = "ok"; } catch (e) { out.smtp = String(e.message).slice(0, 200); }
  try { await withImap(i, async (c) => { await c.list(); }); out.imap = "ok"; } catch (e) { out.imap = imapError(e); }
  db.prepare("UPDATE inboxes SET login_ok = ?, login_at = ? WHERE id = ?").run(out.smtp === "ok" && out.imap === "ok" ? 1 : 0, new Date().toISOString(), i.id);
  event(out.smtp === "ok" && out.imap === "ok" ? "info" : "error", i.email, `Login test: SMTP ${out.smtp === "ok" ? "ok" : "failed"}, IMAP ${out.imap === "ok" ? "ok" : "failed"}`);
  return out;
}

async function api(req, res, url) {
  const reply = (code, body) => res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(body));
  const p = url.pathname, m = req.method;
  if (p === "/api/login" && m === "POST") {
    const ip = clientIp(req);
    if (rateLimited(ip)) return reply(429, { error: "Too many attempts. Wait 15 minutes." });
    if (!PANEL_PASSWORD) return reply(503, { error: "The PANEL_PASSWORD variable isn't set. Add it under Variables in Railway, then deploy again." });
    const { password } = await readJson(req);
    const a = crypto.createHash("sha256").update(String(password || "")).digest(), b = crypto.createHash("sha256").update(PANEL_PASSWORD).digest();
    if (!crypto.timingSafeEqual(a, b)) { failedLogin(ip); return reply(401, { error: "Wrong password" }); }
    const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
    // Remember the public address for unsubscribe and tracking links.
    const host = String(req.headers["x-forwarded-host"] || req.headers.host || "");
    if (host && !/^(localhost|127\.|\[::1\])/.test(host)) saveSettings({ publicUrl: `${req.headers["x-forwarded-proto"] === "https" ? "https" : "http"}://${host}` });
    res.setHeader("set-cookie", `ww=${makeSession()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${14 * 86400}${secure}`);
    return reply(200, { ok: true });
  }
  if (!validSession(req)) return reply(401, { error: "Sign in first" });
  if (m !== "GET" && req.headers["content-type"] !== "application/json") return reply(415, { error: "JSON only" });
  if (p === "/api/logout" && m === "POST") { res.setHeader("set-cookie", "ww=; Path=/; Max-Age=0"); return reply(200, { ok: true }); }
  if (p === "/api/state" && m === "GET") return reply(200, await overview());
  if (p === "/api/mail" && m === "GET") return reply(200, recentMail(Number(url.searchParams.get("limit") || 50), url.searchParams.get("inbox")));
  if (p === "/api/settings" && m === "PUT") { saveSettings(await readJson(req)); schedule(); event("info", null, "Settings saved"); return reply(200, { ok: true }); }
  if (p === "/api/pause" && m === "POST") {
    const { paused } = await readJson(req);
    const why = paused ? null : startBlock();
    if (why) return reply(400, { error: why, code: "not_ready" });
    saveSettings({ paused: !!paused }); event("info", null, paused ? "Warm-up paused" : "Warm-up started");
    if (!paused) { rampFromToday(); tick().catch((e) => event("error", null, e.message)); }
    return reply(200, { ok: true });
  }
  if (p === "/api/run-now" && m === "POST") {
    if (getSettings().paused) return reply(400, { error: "Press Start warm-up first" });
    const why = startBlock();
    if (why) return reply(400, { error: why, code: "not_ready" });
    if (state.running) return reply(409, { error: "A cycle is already running. Check Activity in a minute." });
    tick({ force: true }).catch((e) => event("error", null, e.message));
    event("info", null, "Manual cycle started (ignores working hours, still respects every limit)");
    return reply(200, { ok: true });
  }
  if (p === "/api/dns-check" && m === "POST") {
    const ds = [...new Set(listInboxes().filter((i) => i.role === "sender").map((i) => domainOf(i.email)))];
    return reply(200, await Promise.all(ds.map((d) => checkDomain(d, true))));
  }
  if (p === "/api/ai-test" && m === "POST") {
    const s = getSettings();
    if (!openrouterKey(s)) return reply(400, { error: "Save an OpenRouter key first" });
    try {
      const { json, cost } = await askAI(s, `You are Alex, writing to Sam, a colleague. Write a short ordinary work email (40-80 words) about: ${pickOne(s.topics)}. Plain text, no links, no em dashes. Reply with only JSON: {"subject": "...", "body": "..."}`);
      return reply(200, { subject: stripLinks(String(json.subject)), body: stripLinks(String(json.body)), cost, model: s.aiModel });
    } catch (e) { return reply(400, { error: String(e.message).slice(0, 300) }); }
  }
  if (p === "/api/errors/clear" && m === "POST") { db.prepare("DELETE FROM events WHERE level = 'error'").run(); return reply(200, { ok: true }); }
  if (await camp.api(req, res, url, reply)) return;
  if (p === "/api/inboxes" && m === "POST") return reply(200, { id: saveInbox(await readJson(req)).id });
  if (p === "/api/inboxes/bulk" && m === "POST") {
    // One inbox per line: email, app password, sender name (name optional). Shared provider, role and start date.
    const { lines = "", provider, role, start_date } = await readJson(req);
    const results = [];
    for (const line of String(lines).split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 100)) {
      const [email, password, ...name] = line.split(/[,;\t]/).map((x) => x.trim());
      try { saveInbox({ email, password, name: name.join(" "), provider, role, start_date }); results.push({ email, ok: true }); }
      catch (e) { results.push({ email: email || line.slice(0, 40), ok: false, error: e.message }); }
    }
    return reply(200, { results });
  }
  const im = /^\/api\/inboxes\/(\d+)(\/test|\/send-test)?$/.exec(p);
  if (im) {
    const i = getInbox(Number(im[1]));
    if (!i) return reply(404, { error: "Inbox not found" });
    if (!im[2] && m === "PUT") return reply(200, { id: saveInbox(await readJson(req), i.id).id });
    if (!im[2] && m === "DELETE") {
      db.prepare("DELETE FROM inboxes WHERE id = ?").run(i.id); transports.delete(i.email);
      camp.inboxRemoved(i); event("info", i.email, "Inbox removed");
      return reply(200, { ok: true });
    }
    if (im[2] === "/test" && m === "POST") {
      if (!i.password_enc && !DRY) return reply(400, { error: `Save an app password for ${i.email} first: press Edit, paste it, then Save.` });
      return reply(200, await testInbox(i));
    }
    if (im[2] === "/send-test" && m === "POST") {
      const s = getSettings(), pool = listInboxes();
      const why = await blockedReason(s, i);
      if (why) return reply(400, { error: why });
      const { target } = dailyTarget(i, s);
      if (sentToday(i.email, localParts(new Date(), s.timezone).day) >= target) return reply(400, { error: `Today's limit for this inbox (${target}) is already reached` });
      const to = chooseRecipient(s, i, pool);
      if (!to) return reply(400, { error: "Add at least one more inbox to send to" });
      try {
        const email = await writeEmail(s, { from: i, to, topic: pickOne(s.topics) });
        await send(s, { from: i, to, ...email, depth: 0, test: true });
        return reply(200, { to: to.email, subject: email.subject, by: email.by });
      } catch (e) { return reply(400, { error: String(e.message).slice(0, 300) }); }
    }
  }
  return reply(404, { error: "Not found" });
}

function serve() {
  if (!PANEL_PASSWORD) console.warn("PANEL_PASSWORD is not set: the control panel will refuse every login until you set it.");
  http.createServer(async (req, res) => {
    res.setHeader("x-frame-options", "DENY"); res.setHeader("x-content-type-options", "nosniff"); res.setHeader("referrer-policy", "no-referrer");
    try {
      const url = new URL(req.url, "http://x");
      if (url.pathname === "/health") return res.writeHead(200).end("ok");
      if (await camp.publicRoute(req, res, url)) return;
      if (url.pathname.startsWith("/api/")) return await api(req, res, url);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(PANEL_HTML);
    } catch (e) {
      if (!res.headersSent) res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: String(e.message).slice(0, 300) }));
    }
  }).listen(Number(process.env.PORT || 8080), () => console.log(`control panel on :${process.env.PORT || 8080}`));
}

// ── Plumbing ────────────────────────────────────────────────────────────────────
function event(level, inbox, message) {
  console.log(new Date().toISOString(), level, inbox || "-", message);
  db.prepare("INSERT INTO events VALUES (?,?,?,?)").run(new Date().toISOString(), level, inbox, String(message).slice(0, 500));
}

process.on("unhandledRejection", (e) => event("error", null, `Unexpected error: ${String(e?.message || e).slice(0, 300)}`));

camp = createCampaigns({ db, DRY, event, getSettings, listInboxes, getInbox, blockedReason, dailyTarget, placement, localParts,
  daysAgo, smtpSend, domainOf, EMAIL_RE, readJson, first, pickOne, rand });

if (ONCE) { await tick({ force: true }); console.log(JSON.stringify((await overview()).totals, null, 2)); process.exit(0); }
serve();
schedule();
tick().catch((e) => event("error", null, e.message));
