// Campaigns: the cold-email side of the mailer.
//
// Leads arrive from PitchPersona's "Custom webhook" push (one flat JSON object per
// prospect, already carrying the written sequence), from a CSV, or by paste. Each
// campaign has a multi-step sequence of templates ({{first_name}}, {{email_body}}, ...),
// a sending window, the inboxes it may use and per-inbox limits. New leads can wait in
// review until approved. Follow-ups go out in the same thread. A reply, bounce or
// unsubscribe stops the lead, puts the address on the suppression list and (for replies)
// tells PitchPersona.
//
// Guard rails on top of the warm-up's own: an inbox sends cold email only after enough
// warm-up days and while its placement holds, never above the per-inbox cold cap, never
// to a suppressed address, never with an unfilled {{variable}}, and only inside the
// campaign's window with a random gap between sends.

import crypto from "node:crypto";

const TRACK_PIXEL = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
const LEAD_STATUSES = ["review", "queued", "replied", "bounced", "unsubscribed", "completed", "failed", "skipped"];
const STOP_STATUSES = new Set(["replied", "bounced", "unsubscribed", "completed", "failed", "skipped"]);
const MAX_INGEST = 1000;
const DEFAULT_OPT_OUT = 'If this isn\'t relevant, just reply "no" and I won\'t email again.';

export function createCampaigns(ctx) {
  const { db, DRY, event, getSettings, listInboxes, getInbox, blockedReason, dailyTarget, placement, localParts, daysAgo,
    deliver, domainOf, EMAIL_RE, readJson, first, pickOne, rand } = ctx;

  db.exec(`
  CREATE TABLE IF NOT EXISTS campaigns (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, status TEXT DEFAULT 'draft', sender_ids TEXT DEFAULT '[]',
    start_hour INTEGER DEFAULT 9, end_hour INTEGER DEFAULT 17, days TEXT DEFAULT '12345', daily_limit INTEGER DEFAULT 20,
    gap_min INTEGER DEFAULT 8, gap_max INTEGER DEFAULT 20, review INTEGER DEFAULT 1, stop_on_reply INTEGER DEFAULT 1,
    track_opens INTEGER DEFAULT 0, track_clicks INTEGER DEFAULT 0, opt_out_line TEXT DEFAULT '', signature TEXT DEFAULT '{{sender_first_name}}',
    ingest_token TEXT UNIQUE, created_at TEXT, updated_at TEXT);
  CREATE TABLE IF NOT EXISTS steps (
    id INTEGER PRIMARY KEY AUTOINCREMENT, campaign_id INTEGER, n INTEGER, delay_days REAL, subject TEXT, body TEXT, same_thread INTEGER DEFAULT 1);
  CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT, campaign_id INTEGER, email TEXT, name TEXT, first_name TEXT, company TEXT, title TEXT,
    vars TEXT DEFAULT '{}', overrides TEXT DEFAULT '{}', status TEXT, step INTEGER DEFAULT 0, next_at TEXT, sender_id INTEGER,
    thread_id TEXT, last_message_id TEXT, last_subject TEXT, token TEXT UNIQUE, error TEXT, source TEXT, created_at TEXT, updated_at TEXT,
    UNIQUE(campaign_id, email));
  CREATE INDEX IF NOT EXISTS leads_due ON leads(campaign_id, status, next_at);
  CREATE INDEX IF NOT EXISTS leads_email ON leads(email);
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, lead_id INTEGER, campaign_id INTEGER, step INTEGER, sender TEXT, recipient TEXT,
    message_id TEXT, subject TEXT, body TEXT, sent_at TEXT, day TEXT, token TEXT UNIQUE, opens INTEGER DEFAULT 0, clicks INTEGER DEFAULT 0,
    first_open_at TEXT, first_click_at TEXT);
  CREATE INDEX IF NOT EXISTS messages_sender_day ON messages(sender, day);
  CREATE INDEX IF NOT EXISTS messages_mid ON messages(message_id);
  CREATE TABLE IF NOT EXISTS replies (
    id INTEGER PRIMARY KEY AUTOINCREMENT, lead_id INTEGER, campaign_id INTEGER, inbox TEXT, from_email TEXT, kind TEXT,
    subject TEXT, snippet TEXT, received_at TEXT, message_id TEXT UNIQUE, read INTEGER DEFAULT 0);
  CREATE TABLE IF NOT EXISTS suppression (email TEXT PRIMARY KEY, reason TEXT, source TEXT, at TEXT);
  CREATE TABLE IF NOT EXISTS imap_cursor (inbox TEXT, folder TEXT, uidvalidity TEXT, last_uid INTEGER, PRIMARY KEY (inbox, folder));
  `);

  try { db.exec("ALTER TABLE leads ADD COLUMN attempts INTEGER DEFAULT 0"); } catch { /* already there */ }
  db.exec(`
  CREATE INDEX IF NOT EXISTS messages_campaign_day ON messages(campaign_id, day);
  CREATE INDEX IF NOT EXISTS messages_campaign_lead ON messages(campaign_id, lead_id, opens, clicks);
  CREATE INDEX IF NOT EXISTS messages_lead ON messages(lead_id);
  CREATE INDEX IF NOT EXISTS messages_sender_time ON messages(sender, sent_at);
  CREATE INDEX IF NOT EXISTS replies_lead ON replies(lead_id);
  CREATE INDEX IF NOT EXISTS replies_campaign ON replies(campaign_id, kind);
  CREATE INDEX IF NOT EXISTS replies_inbox ON replies(inbox, kind, received_at);
  `);

  const now = () => new Date().toISOString();
  const token = () => crypto.randomBytes(18).toString("base64url");
  const J = (v, d) => { try { return JSON.parse(v); } catch { return d; } };
  const getCampaign = (id) => db.prepare("SELECT * FROM campaigns WHERE id = ?").get(id);
  const stepsOf = (id) => db.prepare("SELECT * FROM steps WHERE campaign_id = ? ORDER BY n").all(id);
  // Matches the address itself or a whole-domain entry such as "@competitor.com".
  const suppressed = (email) => db.prepare("SELECT reason FROM suppression WHERE email IN (?, ?) LIMIT 1").get(email, "@" + email.split("@")[1])?.reason || null;
  const suppress = (email, reason, source) => db.prepare("INSERT INTO suppression VALUES (?,?,?,?) ON CONFLICT(email) DO NOTHING").run(email.toLowerCase(), reason, source || null, now());

  // ── Templates ─────────────────────────────────────────────────────────────────
  // {{name}} or {{name|fallback}}. An unfilled variable without a fallback is an error,
  // never "Hi {{first_name}}," in someone's inbox.
  function varsFor(lead, sender) {
    const v = { ...J(lead.vars, {}) };
    Object.assign(v, {
      email: lead.email, name: lead.name || "", first_name: lead.first_name || "", company: lead.company || "", title: lead.title || "",
      sender_name: sender?.name || "", sender_first_name: sender ? first(sender.name) : "", sender_email: sender?.email || "",
    });
    return v;
  }
  function render(tpl, vars) {
    const missing = [];
    const out = String(tpl || "").replace(/\{\{\s*([a-zA-Z0-9_]+)\s*(?:\|([^}]*))?\}\}/g, (_, k, fb) => {
      const val = vars[k] ?? vars[k.toLowerCase()];
      if (val !== undefined && val !== null && String(val).trim() !== "") return String(val);
      if (fb !== undefined) return fb;
      missing.push(k); return "";
    });
    return { text: out, missing };
  }
  // The email a lead would get at a step: overrides first, then the step template.
  function compose(campaign, step, lead, sender) {
    const vars = varsFor(lead, sender);
    const ov = J(lead.overrides, {})[step.n] || {};
    const subj = render(ov.subject ?? step.subject, vars);
    const body = render(ov.body ?? step.body, vars);
    const sig = render(campaign.signature || "", vars);
    // An unfilled variable fails the lead; only a template that is empty on purpose
    // (e.g. {{email_3_body|}} for a lead with two emails) skips a later step.
    if (body.missing.length) return { missing: [...new Set(body.missing)], text: "", subject: "" };
    let text = body.text.trim();
    if (!text) return step.n === 1 ? { missing: ["body"], text: "", subject: "" } : { empty: true };
    // Under a sign-off ("Best,") the name goes on the next line; after a paragraph, a blank line first.
    if (sig.text.trim() && !text.endsWith(sig.text.trim())) text += (/,\s*$/.test(text) ? "\n" : "\n\n") + sig.text.trim();
    if (campaign.opt_out_line?.trim()) text += "\n\n" + render(campaign.opt_out_line, vars).text.trim();
    // A follow-up is a reply only when there is a thread to reply to. One that has to start a new
    // thread (its inbox changed) keeps the earlier subject if its own is empty, without "Re:".
    const threaded = !!(step.n > 1 && step.same_thread && lead.last_subject && lead.last_message_id);
    const prior = (lead.last_subject || "").replace(/^(re:\s*)+/i, "");
    const subject = threaded ? `Re: ${prior}` : subj.text.trim() || (step.n > 1 ? prior : "");
    const missing = [...new Set([...subj.missing.filter(() => !threaded), ...body.missing, ...sig.missing])];
    if (!subject && !missing.length) missing.push("subject");
    return { subject, text, missing, threaded };
  }

  // ── Leads in ──────────────────────────────────────────────────────────────────
  // Accepts PitchPersona's webhook payload (prospect_email, prospect_first_name, ...,
  // email_subject, email_body, email_2_subject, ...) as well as plain CSV-style rows.
  function normalizeLead(raw) {
    const r = {};
    for (const [k, v] of Object.entries(raw || {})) {
      if (v === null || v === undefined) continue;
      const key = String(k).trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
      if (key) r[key] = Array.isArray(v) ? v.join("; ") : typeof v === "object" ? JSON.stringify(v) : String(v);
    }
    const pickKey = (...keys) => keys.map((k) => r[k]).find((v) => v && v.trim()) || "";
    // Exactly one plain address, or nothing: "<a@b.com>" is unwrapped, but "a@b.com, c@d.com"
    // is refused rather than guessed.
    const rawEmail = pickKey("prospect_email", "email", "work_email", "email_address").trim().toLowerCase().replace(/^mailto:/, "");
    const found = rawEmail.match(/[a-z0-9._%+'-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) || [];
    const email = found.length === 1 && !/[,;]/.test(rawEmail) ? found[0].toLowerCase() : rawEmail;
    const name = pickKey("prospect_name", "name", "full_name");
    return {
      email, name, first_name: pickKey("prospect_first_name", "first_name", "firstname") || (name ? name.split(" ")[0] : ""),
      company: pickKey("prospect_company", "company", "company_name", "organization"), title: pickKey("prospect_title", "title", "job_title"),
      status_hint: pickKey("prospect_email_status", "email_status").toLowerCase(), vars: r,
    };
  }

  function addLeads(campaign, rows, source) {
    const added = [], skipped = [];
    const ins = db.prepare(`INSERT INTO leads (campaign_id, email, name, first_name, company, title, vars, status, next_at, token, source, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(campaign_id, email) DO NOTHING`);
    const elsewhere = db.prepare(`SELECT c.name FROM leads l JOIN campaigns c ON c.id = l.campaign_id
      WHERE l.email = ? AND l.campaign_id != ? AND c.status != 'archived' AND l.status IN ('review','queued') LIMIT 1`);
    db.exec("BEGIN");
    try {
    for (const raw of rows.slice(0, MAX_INGEST)) {
      const l = normalizeLead(raw);
      if (!EMAIL_RE.test(l.email)) { skipped.push({ email: l.email || "(none)", reason: "no valid email" }); continue; }
      if (/invalid|undeliverable|bounce/.test(l.status_hint)) { skipped.push({ email: l.email, reason: `email marked ${l.status_hint}` }); continue; }
      const sup = suppressed(l.email);
      if (sup) { skipped.push({ email: l.email, reason: `on the do-not-email list (${sup})` }); continue; }
      const other = elsewhere.get(l.email, campaign.id);
      if (other) { skipped.push({ email: l.email, reason: `already being emailed by "${other.name}"` }); continue; }
      const r = ins.run(campaign.id, l.email, l.name, l.first_name, l.company, l.title, JSON.stringify(l.vars),
        campaign.review ? "review" : "queued", now(), token(), source, now(), now());
      if (r.changes) added.push(l.email); else skipped.push({ email: l.email, reason: "already in this campaign" });
    }
    db.exec("COMMIT");
    } catch (e) { db.exec("ROLLBACK"); throw e; }
    if (added.length) event("info", null, `${added.length} lead${added.length > 1 ? "s" : ""} added to "${campaign.name}" from ${source}${campaign.review ? " (waiting for review)" : ""}`);
    // Never drop rows silently: say how many were left out so they can be sent again.
    const notRead = Math.max(0, rows.length - MAX_INGEST);
    return { added: added.length, skipped, ...(notRead ? { notRead, note: `Only the first ${MAX_INGEST} leads are read per batch. Send the other ${notRead} in another batch.` } : {}) };
  }

  // A lead still marked 'sending' was interrupted: the email may or may not have gone out.
  // It waits in review rather than risk sending the same email twice.
  function recoverInterrupted(olderThanMs) {
    const rows = db.prepare("SELECT id, error FROM leads WHERE status = 'sending' AND updated_at < ?").all(new Date(Date.now() - olderThanMs).toISOString());
    for (const l of rows) {
      const what = String(l.error || "").replace(/^Sending /, "") || "its next step";
      db.prepare("UPDATE leads SET status='review', next_at=COALESCE(next_at, ?), error=?, updated_at=? WHERE id=?")
        .run(now(), `The mailer stopped while sending ${what}. If that email is in the inbox's Sent folder, press Skip; if not, Approve to send it.`, now(), l.id);
    }
    if (rows.length) event("warn", null, `${rows.length} lead${rows.length > 1 ? "s" : ""} moved to review: the mailer stopped while emailing ${rows.length > 1 ? "them" : "it"}. Check the Sent folder before approving.`);
  }
  recoverInterrupted(-1000);   // at start-up nothing is sending, so every such lead was interrupted
  const housekeeping = () => recoverInterrupted(15 * 60000);

  // ── Cold eligibility: the warm-up has to have earned it ──────────────────────
  async function coldStatus(s, inbox) {
    const blocked = await blockedReason(s, inbox);
    if (blocked) return { ok: false, reason: blocked };
    if (inbox.role !== "sender") return { ok: false, reason: "Seeds don't send campaigns" };
    if (DRY) return { ok: true };
    const { dayN } = dailyTarget(inbox, s);
    if (dayN < s.coldMinWarmDays) return { ok: false, reason: `Warm-up day ${Math.max(dayN, 0)} of ${s.coldMinWarmDays}` };
    const p = placement(inbox.email, daysAgo(6, s.timezone));
    if (p.checked < 10) return { ok: false, reason: "Not enough warm-up placement data yet" };
    if (p.pct < s.coldMinPlacement) return { ok: false, reason: `Placement ${p.pct}% is below ${s.coldMinPlacement}%` };
    return { ok: true };
  }
  const coldSentToday = (email, day) => db.prepare("SELECT COUNT(*) c FROM messages WHERE sender = ? AND day = ?").get(email, day).c;
  const campaignSentToday = (cid, email, day) => db.prepare("SELECT COUNT(*) c FROM messages WHERE campaign_id = ? AND sender = ? AND day = ?").get(cid, email, day).c;
  const nextGap = new Map();

  function inCampaignWindow(c, s) {
    const t = localParts(new Date(), s.timezone);
    const dow = { Mon: "1", Tue: "2", Wed: "3", Thu: "4", Fri: "5", Sat: "6", Sun: "7" }[t.weekday];
    return String(c.days || "").includes(dow) && t.hour >= c.start_hour && t.hour < c.end_hour;
  }

  // ── Sending ───────────────────────────────────────────────────────────────────
  const URL_RE = /https?:\/\/[^\s<>()"']+[^\s<>()"'.,;:!?]/g;
  // Links inside campaign emails use the link address when one is set, so a cold email never
  // carries the panel's own address (which may be on your main domain).
  const linkBase = (s) => s.linkUrl || s.publicUrl;
  function trackedBodies(campaign, text, msgToken, s) {
    const base = linkBase(s);
    let plain = text;
    if (campaign.track_clicks && base) plain = plain.replace(URL_RE, (u) => `${base}/c/${msgToken}?u=${encodeURIComponent(u)}`);
    if (!(campaign.track_opens && base)) return { text: plain };
    const esc = (t) => t.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    const html = `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5">${esc(plain).replace(URL_RE, (u) => `<a href="${u}">${u}</a>`).replace(/\n/g, "<br>")}</div><img src="${base}/o/${msgToken}.gif" width="1" height="1" alt="">`;
    return { text: plain, html };
  }

  async function sendStep(s, campaign, lead, sender, steps) {
    const step = steps.find((x) => x.n === lead.step + 1);
    if (!step) { db.prepare("UPDATE leads SET status='completed', next_at=NULL, updated_at=? WHERE id=?").run(now(), lead.id); return false; }
    const mail = compose(campaign, step, lead, sender);
    // Moves the lead past this step. A new (non-threaded) email starts a new thread;
    // a threaded follow-up only moves the reply pointer.
    const advance = (sentId, newThreadSubject) => {
      const next = steps.find((x) => x.n === step.n + 1);
      const nextAt = next ? new Date(Date.now() + next.delay_days * 86400000 + rand(0, 3) * 3600000).toISOString() : null;
      db.prepare(`UPDATE leads SET step=?, status=?, next_at=?, sender_id=?, error=NULL, attempts=0, updated_at=? WHERE id=?`)
        .run(step.n, next ? "queued" : "completed", nextAt, sender.id, now(), lead.id);
      if (sentId && newThreadSubject) db.prepare("UPDATE leads SET thread_id=?, last_message_id=?, last_subject=? WHERE id=?").run(sentId, sentId, newThreadSubject, lead.id);
      else if (sentId) db.prepare("UPDATE leads SET last_message_id=? WHERE id=?").run(sentId, lead.id);
    };
    if (mail.empty) { advance(null, null); event("info", sender.email, `Skipped step ${step.n} for ${lead.email}: the template is empty for this lead`); return false; }
    if (mail.missing.length) {
      db.prepare("UPDATE leads SET status='failed', error=?, updated_at=? WHERE id=?").run(`Missing ${mail.missing.map((m) => `{{${m}}}`).join(", ")}`, now(), lead.id);
      event("warn", sender.email, `Did not send step ${step.n} to ${lead.email}: missing ${mail.missing.join(", ")}`);
      return false;
    }
    const msgToken = token();
    const messageId = `<${crypto.randomUUID()}@${domainOf(sender.email)}>`;
    const bodies = trackedBodies(campaign, mail.text, msgToken, s);
    const headers = {};
    if (linkBase(s)) { headers["List-Unsubscribe"] = `<${linkBase(s)}/u/${lead.token}>, <mailto:${sender.email}?subject=unsubscribe>`; headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click"; }
    else headers["List-Unsubscribe"] = `<mailto:${sender.email}?subject=unsubscribe>`;
    const threadRefs = mail.threaded && lead.last_message_id ? { inReplyTo: lead.last_message_id, references: [lead.thread_id, lead.last_message_id].filter((v, i, a) => v && a.indexOf(v) === i) } : {};
    // Marked first, so a restart in the middle of a send can't lead to the same email twice.
    db.prepare("UPDATE leads SET status='sending', error=?, updated_at=? WHERE id=?").run(`Sending step ${step.n} from ${sender.email}`, now(), lead.id);
    let sentId;
    try { sentId = (await deliver(sender, { to: { name: lead.name || "", address: lead.email }, subject: mail.subject, messageId, headers, ...bodies, ...threadRefs })).messageId; }
    catch (e) { db.prepare("UPDATE leads SET status='queued', error=NULL WHERE id=? AND status='sending'").run(lead.id); throw e; }
    db.prepare("INSERT INTO messages (lead_id, campaign_id, step, sender, recipient, message_id, subject, body, sent_at, day, token) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run(lead.id, campaign.id, step.n, sender.email, lead.email, sentId, mail.subject, mail.text, now(), localParts(new Date(), s.timezone).day, msgToken);
    advance(sentId, mail.threaded ? null : mail.subject);
    event("send", sender.email, `${DRY ? "[dry] " : ""}Campaign "${campaign.name}" step ${step.n} to ${lead.email}: "${mail.subject}"`);
    return true;
  }

  // Sends at most one campaign email per inbox per cycle. `scanned` holds the inboxes whose
  // reply scan succeeded this cycle: an inbox that couldn't check for replies doesn't send,
  // so a follow-up never goes to someone whose reply we haven't seen yet.
  async function sendPhase(s, pool, scanned) {
    const campaigns = db.prepare("SELECT * FROM campaigns WHERE status = 'active'").all();
    if (!campaigns.length) return;
    const day = localParts(new Date(), s.timezone).day;
    // A lead whose inbox was removed, or taken off its campaign, continues from another inbox in a new thread.
    for (const c of campaigns) {
      const ids = J(c.sender_ids, []);
      db.prepare(`UPDATE leads SET sender_id=NULL, thread_id=NULL, last_message_id=NULL
        WHERE campaign_id = ? AND status='queued' AND sender_id IS NOT NULL AND sender_id NOT IN (SELECT value FROM json_each(?))`).run(c.id, JSON.stringify(ids));
    }
    const eligible = new Map();
    for (const i of pool.filter((x) => x.role === "sender")) eligible.set(i.id, scanned && !scanned.has(i.id) ? { ok: false } : await coldStatus(s, i));
    const usedThisCycle = new Set();
    for (const c of campaigns) {
      if (!DRY && !inCampaignWindow(c, s)) continue;
      const steps = stepsOf(c.id);
      if (!steps.length) continue;
      const senders = pool.filter((i) => J(c.sender_ids, []).includes(i.id) && eligible.get(i.id)?.ok);
      for (const sender of senders) {
        if (usedThisCycle.has(sender.id)) continue;
        if (getInbox(sender.id)?.paused || getSettings().paused) continue;     // paused a moment ago
        if (coldSentToday(sender.email, day) >= s.coldDailyCap) continue;
        if (campaignSentToday(c.id, sender.email, day) >= Math.min(c.daily_limit, s.coldDailyCap)) continue;
        // The gap is measured from the last campaign email in the database, so a restart doesn't reset it.
        const last = Date.parse(db.prepare("SELECT MAX(sent_at) t FROM messages WHERE sender = ?").get(sender.email).t || 0) || 0;
        if (!DRY && Date.now() - last < (nextGap.get(sender.id) ?? c.gap_min * 60000)) continue;
        // Follow-ups first (they keep their sender); new leads take whichever inbox is free.
        const lead = db.prepare(`SELECT * FROM leads WHERE campaign_id = ? AND status = 'queued' AND next_at <= ?
          AND (sender_id = ? OR sender_id IS NULL) ORDER BY (sender_id IS NULL), step DESC, next_at LIMIT 1`).get(c.id, now(), sender.id);
        if (!lead) continue;
        const sup = suppressed(lead.email);
        if (sup) { db.prepare("UPDATE leads SET status='skipped', error=?, next_at=NULL, updated_at=? WHERE id=?").run(`On the do-not-email list (${sup})`, now(), lead.id); continue; }
        try {
          if (await sendStep(s, c, lead, sender, steps)) {
            usedThisCycle.add(sender.id);
            nextGap.set(sender.id, rand(c.gap_min, Math.max(c.gap_min, c.gap_max)) * 60000);
          }
        } catch (e) {
          usedThisCycle.add(sender.id);
          if (e.code === "PAUSED") continue;                                   // not the lead's fault; it stays queued
          if (e.recipientRejected) {                                           // the mail server says the address doesn't exist
            db.prepare("UPDATE leads SET status='bounced', error=?, next_at=NULL, updated_at=? WHERE id=?").run(String(e.response || e.message).slice(0, 200), now(), lead.id);
            suppress(lead.email, "bounced", sender.email);
            db.prepare("INSERT OR IGNORE INTO replies (lead_id, campaign_id, inbox, from_email, kind, subject, snippet, received_at, message_id) VALUES (?,?,?,?,?,?,?,?,?)")
              .run(lead.id, c.id, sender.email, lead.email, "bounce", "Rejected when sending", "The mail server said this address doesn't exist. It is now on the do-not-email list.", now(), `rcpt:${lead.id}:${Date.now()}`);
            event("warn", sender.email, `${lead.email} was rejected as a bad address. It won't be emailed again.`);
            bounceGuard(sender);
            continue;
          }
          const attempts = (lead.attempts || 0) + 1;
          if (attempts >= 5) db.prepare("UPDATE leads SET status='failed', attempts=?, error=?, next_at=NULL, updated_at=? WHERE id=?").run(attempts, `Gave up after 5 tries: ${String(e.message).slice(0, 160)}`, now(), lead.id);
          else db.prepare("UPDATE leads SET attempts=?, error=?, next_at=?, updated_at=? WHERE id=?").run(attempts, String(e.message).slice(0, 200), new Date(Date.now() + 3600000).toISOString(), now(), lead.id);
          event("error", sender.email, `Campaign send to ${lead.email} failed (try ${attempts} of 5): ${String(e.message).slice(0, 200)}`);
        }
      }
    }
  }

  // ── Reading: replies, auto-replies, bounces ──────────────────────────────────
  const AUTO_RE = /out of (the )?office|automatic reply|auto.?reply|autoreply|away from (the )?office|on vacation|on leave|abwesenheit|absence/i;
  const UNSUB_RE = /\b(unsubscribe|remove me|take me off|stop emailing|stop sending|do not (contact|email)|don't (contact|email))\b/i;
  const BOUNCE_FROM_RE = /mailer-daemon|postmaster|mail delivery (subsystem|system)/i;

  async function postReplyWebhook(s, lead, campaign, reply) {
    if (!s.replyWebhookUrl) return;
    try {
      // Instantly's reply event shape, which PitchPersona's /webhooks/instantly/<token> understands.
      const res = await fetch(s.replyWebhookUrl, {
        method: "POST", signal: AbortSignal.timeout(10000), headers: { "content-type": "application/json" },
        body: JSON.stringify({ event_type: "reply_received", timestamp: now(), lead_email: lead.email, campaign_name: campaign?.name || "",
          email_account: reply.inbox, reply_subject: reply.subject, reply_text_snippet: reply.snippet, source: "pitchpersona-mailer" }),
      });
      if (!res.ok) event("warn", reply.inbox, `Reply webhook answered ${res.status}`);
    } catch (e) { event("warn", reply.inbox, `Reply webhook failed: ${String(e.message).slice(0, 150)}`); }
  }

  function snippetOf(source) {
    const raw = source.toString("utf8");
    const bodyStart = raw.search(/\r?\n\r?\n/);
    let body = bodyStart > 0 ? raw.slice(bodyStart).trim() : raw;
    if (/content-transfer-encoding:\s*base64/i.test(raw.slice(0, bodyStart > 0 ? bodyStart : 2000)) && /^[A-Za-z0-9+/=\s]+$/.test(body.slice(0, 400)))
      body = Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8");
    body = body.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
    body = body.replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/--[0-9a-zA-Z_=.-]+[\s\S]*?\r?\n\r?\n/, "");
    const lines = body.split(/\r?\n/).filter((l) => !/^\s*>/.test(l));
    const cut = lines.findIndex((l) => /^On .+wrote:$|^-+\s*Original Message|^From: /i.test(l.trim()));
    return (cut > 0 ? lines.slice(0, cut) : lines).join(" ").replace(/\s+/g, " ").trim().slice(0, 400);
  }

  // Only permanent failures count as bounces; "delayed, will retry" notices don't.
  const HARD_BOUNCE_RE = /Action:\s*failed|Status:\s*5\.\d+\.\d+|\b5\d\d[ -]5\.\d+\.\d+|address not found|does not exist|user unknown|no such user|mailbox unavailable|recipient (address )?rejected|undeliverable/i;
  const SOFT_BOUNCE_RE = /Action:\s*delayed|\(Delay\)|delivery (is |has been )?delayed|will (retry|keep trying)/i;

  // Reads messages that arrived since the last look (a UID cursor per folder) and records
  // replies, auto-replies, opt-outs and bounces for leads this inbox has emailed.
  // Returns false while there is still unread mail left for the next cycle.
  const SCAN_BATCH = Number(process.env.SCAN_BATCH) || 1000;
  async function scanFolder(client, inbox, folder, isSpam) {
    const mb = client.mailbox;
    const cur = db.prepare("SELECT * FROM imap_cursor WHERE inbox = ? AND folder = ?").get(inbox.email, folder);
    const validity = String(mb.uidValidity);
    if (!cur || cur.uidvalidity !== validity) {
      // First look at this folder (or it was rebuilt): start from now, don't replay history.
      db.prepare("INSERT INTO imap_cursor VALUES (?,?,?,?) ON CONFLICT(inbox, folder) DO UPDATE SET uidvalidity=excluded.uidvalidity, last_uid=excluded.last_uid")
        .run(inbox.email, folder, validity, Math.max(0, (mb.uidNext || 1) - 1));
      return true;
    }
    if (!mb.uidNext || mb.uidNext - 1 <= cur.last_uid) return true;
    const s = getSettings();
    const pool = new Set(listInboxes().map((i) => i.email));
    // A busy mailbox, or one not read for a while, is worked through in batches so one cycle
    // never loads thousands of messages at once.
    const end = Math.min(mb.uidNext - 1, cur.last_uid + SCAN_BATCH);
    // Collect first, then act: imapflow can't run other commands inside a fetch loop.
    const msgs = (await client.fetchAll(end < mb.uidNext - 1 ? `${cur.last_uid + 1}:${end}` : `${cur.last_uid + 1}:*`,
      { uid: true, envelope: true, headers: ["auto-submitted", "x-autoreply", "in-reply-to", "references"] }, { uid: true }))
      .filter((m) => m.uid > cur.last_uid).sort((x, y) => x.uid - y.uid);
    const setCursor = (uid) => db.prepare("UPDATE imap_cursor SET last_uid = ? WHERE inbox = ? AND folder = ? AND last_uid < ?").run(uid, inbox.email, folder, uid);
    for (const msg of msgs) {
      await handleMessage(client, inbox, folder, isSpam, msg, s, pool);
      setCursor(msg.uid);      // per message, so a failure halfway never re-handles or skips one
    }
    if (end < mb.uidNext - 1) { setCursor(end); return false; }   // UIDs can have gaps; carry on after this batch next cycle
    return true;
  }

  async function handleMessage(client, inbox, folder, isSpam, msg, s, pool) {
    const fromAddr = (msg.envelope?.from?.[0]?.address || "").toLowerCase();
    const fromName = msg.envelope?.from?.[0]?.name || "";
    if (!fromAddr || pool.has(fromAddr)) return;
    const subject = msg.envelope?.subject || "";
    const mid = msg.envelope?.messageId || `${inbox.email}:${folder}:${msg.uid}`;
    // Bounces are stored as "<message id>:<address>"; ":" sorts right before ";", so this range finds them by index.
    if (db.prepare("SELECT 1 FROM replies WHERE message_id = ? OR (message_id > ? AND message_id < ?)").get(mid, `${mid}:`, `${mid};`)) return;
    const download = async () => {
      const dl = await client.download(String(msg.uid), undefined, { uid: true, maxBytes: 65536 });
      return dl ? streamToBuffer(dl.content) : Buffer.alloc(0);
    };

    if (BOUNCE_FROM_RE.test(fromAddr) || BOUNCE_FROM_RE.test(fromName)) {
      const text = (await download()).toString("utf8");
      if (!HARD_BOUNCE_RE.test(text) || SOFT_BOUNCE_RE.test(text + " " + subject)) return;
      // Prefer the recipient the report names; fall back to every address in it.
      const named = [...text.matchAll(/(?:Final|Original)-Recipient:\s*rfc822;\s*<?([^\s>]+@[^\s>]+)>?/gi)].map((m) => m[1].toLowerCase());
      const addrs = named.length ? [...new Set(named)] : [...new Set((text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || []).map((a) => a.toLowerCase()))];
      for (const a of addrs) {
        const lead = db.prepare(`SELECT l.* FROM leads l JOIN messages m ON m.lead_id = l.id WHERE l.email = ? AND m.sender = ? ORDER BY m.sent_at DESC LIMIT 1`).get(a, inbox.email);
        if (!lead) continue;
        db.prepare("UPDATE leads SET status='bounced', next_at=NULL, updated_at=? WHERE email = ? AND status NOT IN ('replied','unsubscribed')").run(now(), a);
        suppress(a, "bounced", inbox.email);
        db.prepare("INSERT OR IGNORE INTO replies (lead_id, campaign_id, inbox, from_email, kind, subject, snippet, received_at, message_id) VALUES (?,?,?,?,?,?,?,?,?)")
          .run(lead.id, lead.campaign_id, inbox.email, a, "bounce", subject, "The email bounced. The address is now on the do-not-email list.", now(), `${mid}:${a}`);
        event("warn", inbox.email, `Bounce from ${a}. It won't be emailed again.`);
        bounceGuard(inbox);
      }
      return;
    }

    // The lead is whoever we emailed from this inbox at that address, or, for a reply sent
    // from a colleague's or alias address, whoever the In-Reply-To/References point at.
    let lead = db.prepare(`SELECT l.* FROM leads l WHERE l.email = ? AND EXISTS (SELECT 1 FROM messages m WHERE m.lead_id = l.id AND m.sender = ?) ORDER BY l.updated_at DESC LIMIT 1`).get(fromAddr, inbox.email);
    if (!lead) {
      const hdr = msg.headers ? msg.headers.toString() : "";
      const ids = hdr.match(/<[^<>\s]+@[^<>\s]+>/g) || [];
      for (const id of ids) {
        lead = db.prepare("SELECT l.* FROM messages m JOIN leads l ON l.id = m.lead_id WHERE m.message_id = ? AND m.sender = ?").get(id, inbox.email);
        if (lead) break;
      }
    }
    if (!lead) return;
    const snippet = snippetOf(await download());
    const hdr = msg.headers ? msg.headers.toString() : "";
    const auto = AUTO_RE.test(subject) || /auto-submitted:\s*auto-(replied|generated)/i.test(hdr) || /x-autoreply/i.test(hdr);
    const kind = auto ? "auto" : UNSUB_RE.test(subject + " " + snippet) ? "unsubscribe" : "reply";
    const campaign = getCampaign(lead.campaign_id);
    db.prepare("INSERT OR IGNORE INTO replies (lead_id, campaign_id, inbox, from_email, kind, subject, snippet, received_at, message_id) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(lead.id, lead.campaign_id, inbox.email, fromAddr, kind, subject, snippet, now(), mid);
    if (isSpam) await client.messageMove(String(msg.uid), "INBOX", { uid: true }).catch(() => {});
    if (kind === "auto") { event("info", inbox.email, `Auto-reply from ${fromAddr}. The sequence continues.`); return; }
    if (kind === "unsubscribe") {
      db.prepare("UPDATE leads SET status='unsubscribed', next_at=NULL, updated_at=? WHERE email IN (?, ?) AND status NOT IN ('bounced')").run(now(), fromAddr, lead.email);
      suppress(lead.email, "asked to stop", inbox.email);
      if (fromAddr !== lead.email) suppress(fromAddr, "asked to stop", inbox.email);
      event("warn", inbox.email, `${fromAddr} asked to stop. They won't be emailed again.`);
      return;
    }
    if (!campaign || campaign.stop_on_reply) {
      db.prepare("UPDATE leads SET status='replied', next_at=NULL, updated_at=? WHERE id=?").run(now(), lead.id);
      // Someone who replied is never cold-emailed again by another campaign.
      suppress(lead.email, "replied", inbox.email);
      db.prepare("UPDATE leads SET status='skipped', error='Replied to another campaign', next_at=NULL, updated_at=? WHERE email = ? AND id != ? AND status IN ('review','queued')").run(now(), lead.email, lead.id);
    }
    event("info", inbox.email, `Reply from ${fromAddr} on "${campaign?.name || "a campaign"}"`);
    await postReplyWebhook(s, lead, campaign, { inbox: inbox.email, subject, snippet });
  }

  // More than 5% bounces over the last 40 cold sends means a bad list: pause the inbox.
  function bounceGuard(inbox) {
    const sent = db.prepare("SELECT COUNT(*) c FROM (SELECT 1 FROM messages WHERE sender = ? ORDER BY sent_at DESC LIMIT 40)").get(inbox.email).c;
    const since = db.prepare("SELECT MIN(sent_at) t FROM (SELECT sent_at FROM messages WHERE sender = ? ORDER BY sent_at DESC LIMIT 40)").get(inbox.email).t;
    const bounces = db.prepare("SELECT COUNT(*) c FROM replies WHERE inbox = ? AND kind = 'bounce' AND received_at >= ?").get(inbox.email, since || now()).c;
    if (sent >= 20 && bounces / sent > 0.05) {
      db.prepare("UPDATE inboxes SET paused = 1, pause_reason = ? WHERE id = ?").run(`${bounces} bounces in the last ${sent} campaign emails. Clean the list before resuming.`, inbox.id);
      event("warn", inbox.email, `Paused automatically: ${bounces} bounces in the last ${sent} campaign emails`);
    }
  }

  // Replies to a removed inbox can't be seen any more, so a lead it was emailing could already
  // have answered. Those leads wait in review instead of getting a follow-up from another inbox.
  function inboxRemoved(inbox) {
    const n = db.prepare(`UPDATE leads SET status='review', sender_id=NULL, thread_id=NULL, last_message_id=NULL, error=?, updated_at=?
      WHERE sender_id = ? AND status = 'queued'`).run(`Its inbox ${inbox.email} was removed. Check that mailbox for a reply, then approve to continue from another inbox.`, now(), inbox.id).changes;
    for (const c of db.prepare("SELECT id, sender_ids FROM campaigns").all())
      db.prepare("UPDATE campaigns SET sender_ids = ? WHERE id = ?").run(JSON.stringify(J(c.sender_ids, []).filter((x) => x !== inbox.id)), c.id);
    if (n) event("warn", null, `${n} lead${n > 1 ? "s" : ""} that ${inbox.email} was emailing moved to review. Check that mailbox for replies first.`);
  }

  async function streamToBuffer(stream) {
    const chunks = [];
    for await (const c of stream) chunks.push(c);
    return Buffer.concat(chunks);
  }

  // ── Stats ─────────────────────────────────────────────────────────────────────
  function campaignStats(c) {
    const counts = Object.fromEntries(LEAD_STATUSES.map((k) => [k, 0]));
    for (const r of db.prepare("SELECT status, COUNT(*) n FROM leads WHERE campaign_id = ? GROUP BY status").all(c.id)) counts[r.status] = r.n;
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    const m = db.prepare("SELECT COUNT(*) sent, COUNT(DISTINCT lead_id) contacted, SUM(opens > 0) opened, SUM(clicks > 0) clicked FROM messages WHERE campaign_id = ?").get(c.id);
    const rep = db.prepare("SELECT COUNT(DISTINCT lead_id) n FROM replies WHERE campaign_id = ? AND kind = 'reply'").get(c.id).n;
    // Addresses refused at send time never got a message, but they were emailed.
    const refused = db.prepare("SELECT COUNT(*) n FROM leads WHERE campaign_id = ? AND status = 'bounced' AND step = 0").get(c.id).n;
    return { total, counts, sent: m.sent, contacted: m.contacted, attempted: m.contacted + refused, opened: m.opened || 0, clicked: m.clicked || 0, replied: rep,
      replyRate: m.contacted ? Math.round((1000 * rep) / m.contacted) / 10 : null, bounced: counts.bounced };
  }
  function campaignDaily(cid, tz) {
    const days = []; for (let n = 13; n >= 0; n--) days.push(daysAgo(n, tz));
    const sent = Object.fromEntries(db.prepare("SELECT day, COUNT(*) c FROM messages WHERE campaign_id = ? AND day >= ? GROUP BY day").all(cid, days[0]).map((r) => [r.day, r.c]));
    const rep = Object.fromEntries(db.prepare("SELECT substr(received_at,1,10) day, COUNT(*) c FROM replies WHERE campaign_id = ? AND kind='reply' AND received_at >= ? GROUP BY day").all(cid, days[0]).map((r) => [r.day, r.c]));
    return days.map((d) => ({ day: d, sent: sent[d] || 0, replies: rep[d] || 0 }));
  }
  function publicCampaign(c, s) {
    return { ...c, sender_ids: J(c.sender_ids, []), review: !!c.review, stop_on_reply: !!c.stop_on_reply, track_opens: !!c.track_opens,
      track_clicks: !!c.track_clicks, ingestUrl: s.publicUrl ? `${s.publicUrl}/i/${c.ingest_token}` : `/i/${c.ingest_token}`, stats: campaignStats(c) };
  }

  // ── Campaign CRUD ─────────────────────────────────────────────────────────────
  const PRESET_STEPS = {
    pitchpersona: [
      { n: 1, delay_days: 0, subject: "{{email_subject}}", body: "{{email_body}}", same_thread: 0 },
      { n: 2, delay_days: 3, subject: "{{email_2_subject|}}", body: "{{email_2_body|}}", same_thread: 1 },
      { n: 3, delay_days: 4, subject: "{{email_3_subject|}}", body: "{{email_3_body|}}", same_thread: 1 },
    ],
    blank: [
      { n: 1, delay_days: 0, subject: "Quick question, {{first_name}}", body: "Hi {{first_name}},\n\n", same_thread: 0 },
      { n: 2, delay_days: 3, subject: "", body: "Hi {{first_name}}, just bumping this in case it got buried.", same_thread: 1 },
    ],
  };
  function createCampaign(body) {
    const senders = listInboxes().filter((i) => i.role === "sender").map((i) => i.id);
    const id = Number(db.prepare(`INSERT INTO campaigns (name, sender_ids, ingest_token, opt_out_line, created_at, updated_at) VALUES (?,?,?,?,?,?)`)
      .run(String(body.name || "New campaign").slice(0, 120), JSON.stringify(senders), token(), DEFAULT_OPT_OUT, now(), now()).lastInsertRowid);
    saveSteps(id, PRESET_STEPS[body.preset] || PRESET_STEPS.pitchpersona);
    event("info", null, `Campaign "${body.name || "New campaign"}" created`);
    return id;
  }
  function saveSteps(cid, steps) {
    if (!Array.isArray(steps) || !steps.length) throw new Error("A campaign needs at least one step");
    if (steps.length > 8) throw new Error("Up to 8 steps");
    db.prepare("DELETE FROM steps WHERE campaign_id = ?").run(cid);
    steps.forEach((st, k) => db.prepare("INSERT INTO steps (campaign_id, n, delay_days, subject, body, same_thread) VALUES (?,?,?,?,?,?)")
      .run(cid, k + 1, k === 0 ? 0 : Math.min(60, Math.max(1, Number(st.delay_days) || 1)), String(st.subject || "").slice(0, 300), String(st.body || "").slice(0, 10000), k === 0 ? 0 : st.same_thread === false || st.same_thread === 0 ? 0 : 1));
  }
  function updateCampaign(c, body) {
    const n = (v, min, max, d) => (v === undefined ? d : Math.min(max, Math.max(min, Math.round(Number(v)) || min)));
    const b = (v, d) => (v === undefined ? d : v ? 1 : 0);
    const valid = new Set(listInboxes().map((i) => i.id));
    const row = {
      name: body.name !== undefined ? String(body.name).trim().slice(0, 120) || c.name : c.name,
      sender_ids: JSON.stringify(body.sender_ids !== undefined ? body.sender_ids.map(Number).filter((x) => valid.has(x)) : J(c.sender_ids, [])),
      start_hour: n(body.start_hour, 0, 23, c.start_hour), end_hour: n(body.end_hour, 1, 24, c.end_hour),
      days: body.days !== undefined ? String(body.days).replace(/[^1-7]/g, "").split("").filter((v, i, a) => a.indexOf(v) === i).sort().join("") : c.days,
      daily_limit: n(body.daily_limit, 1, 50, c.daily_limit), gap_min: n(body.gap_min, 2, 240, c.gap_min), gap_max: n(body.gap_max, 2, 480, c.gap_max),
      review: b(body.review, c.review), stop_on_reply: b(body.stop_on_reply, c.stop_on_reply), track_opens: b(body.track_opens, c.track_opens),
      track_clicks: b(body.track_clicks, c.track_clicks), opt_out_line: body.opt_out_line !== undefined ? String(body.opt_out_line).slice(0, 300) : c.opt_out_line,
      signature: body.signature !== undefined ? String(body.signature).slice(0, 500) : c.signature,
    };
    if (row.end_hour <= row.start_hour) throw new Error("End hour must be after start hour");
    if (!row.days) throw new Error("Pick at least one sending day");
    if (row.gap_max < row.gap_min) row.gap_max = row.gap_min;
    db.prepare(`UPDATE campaigns SET name=?, sender_ids=?, start_hour=?, end_hour=?, days=?, daily_limit=?, gap_min=?, gap_max=?, review=?, stop_on_reply=?,
      track_opens=?, track_clicks=?, opt_out_line=?, signature=?, updated_at=? WHERE id=?`)
      .run(row.name, row.sender_ids, row.start_hour, row.end_hour, row.days, row.daily_limit, row.gap_min, row.gap_max, row.review, row.stop_on_reply,
        row.track_opens, row.track_clicks, row.opt_out_line, row.signature, now(), c.id);
    if (body.steps) saveSteps(c.id, body.steps);
  }

  function leadDetail(lead) {
    const c = getCampaign(lead.campaign_id), steps = stepsOf(lead.campaign_id);
    const sender = lead.sender_id ? getInbox(lead.sender_id) : listInboxes().find((i) => J(c.sender_ids, []).includes(i.id)) || null;
    const previewLead = { ...lead, last_subject: lead.last_subject || compose(c, steps[0] || {}, lead, sender).subject, last_message_id: lead.last_message_id || "<preview>" };
    return {
      ...lead, vars: J(lead.vars, {}), overrides: J(lead.overrides, {}), campaign: { id: c.id, name: c.name },
      sender: sender ? { id: sender.id, email: sender.email, name: sender.name } : null,
      preview: steps.map((st) => {
        const m = compose(c, st, previewLead, sender);
        return { n: st.n, delay_days: st.delay_days, subject: m.subject || "", body: m.text || "", empty: !!m.empty, missing: m.missing || [], sent: st.n <= lead.step };
      }),
      messages: db.prepare("SELECT step, sender, subject, body, sent_at, opens, clicks FROM messages WHERE lead_id = ? ORDER BY sent_at").all(lead.id),
      replies: db.prepare("SELECT kind, subject, snippet, received_at, inbox FROM replies WHERE lead_id = ? ORDER BY received_at").all(lead.id),
    };
  }

  // ── Panel API (signed-in only) ───────────────────────────────────────────────
  async function api(req, res, url, reply) {
    const p = url.pathname, m = req.method, s = getSettings();
    if (p === "/api/campaigns" && m === "GET") {
      const eligibility = [];
      for (const i of listInboxes().filter((x) => x.role === "sender")) eligibility.push({ id: i.id, email: i.email, ...(await coldStatus(s, i)) });
      reply(200, { campaigns: db.prepare("SELECT * FROM campaigns WHERE status != 'archived' ORDER BY created_at DESC").all().map((c) => publicCampaign(c, s)),
        eligibility, cold: { minWarmDays: s.coldMinWarmDays, minPlacement: s.coldMinPlacement, dailyCap: s.coldDailyCap }, publicUrl: s.publicUrl, replyWebhookUrl: s.replyWebhookUrl });
      return true;
    }
    if (p === "/api/campaigns" && m === "POST") { reply(200, { id: createCampaign(await readJson(req)) }); return true; }
    if (p === "/api/replies" && m === "GET") {
      reply(200, db.prepare(`SELECT r.*, l.name lead_name, l.company, c.name campaign_name FROM replies r LEFT JOIN leads l ON l.id = r.lead_id
        LEFT JOIN campaigns c ON c.id = r.campaign_id ORDER BY r.received_at DESC LIMIT 200`).all());
      return true;
    }
    if (p === "/api/replies/read" && m === "POST") { db.prepare("UPDATE replies SET read = 1").run(); reply(200, { ok: true }); return true; }
    if (p === "/api/suppression" && m === "GET") { reply(200, db.prepare("SELECT * FROM suppression ORDER BY at DESC LIMIT 1000").all()); return true; }
    if (p === "/api/suppression" && m === "POST") {
      const { emails = "", reason = "added by hand" } = await readJson(req);
      const list = String(emails).split(/[\s,;]+/).map((e) => e.trim().toLowerCase()).filter((e) => EMAIL_RE.test(e) || /^@[^\s@]+\.[^\s@]+$/.test(e));
      for (const e of list) { suppress(e, reason, "panel"); db.prepare("UPDATE leads SET status='skipped', error='On the do-not-email list', next_at=NULL WHERE (email = ? OR email LIKE ?) AND status IN ('review','queued')").run(e, e.startsWith("@") ? `%${e}` : e); }
      reply(200, { added: list.length }); return true;
    }
    const sm = /^\/api\/suppression\/(.+)$/.exec(p);
    if (sm && m === "DELETE") { db.prepare("DELETE FROM suppression WHERE email = ?").run(decodeURIComponent(sm[1]).toLowerCase()); reply(200, { ok: true }); return true; }

    const lm = /^\/api\/leads\/(\d+)$/.exec(p);
    if (lm) {
      const lead = db.prepare("SELECT * FROM leads WHERE id = ?").get(Number(lm[1]));
      if (!lead) { reply(404, { error: "Lead not found" }); return true; }
      if (m === "GET") { reply(200, leadDetail(lead)); return true; }
      if (m === "PUT") {
        const body = await readJson(req);
        const ov = J(lead.overrides, {});
        for (const [n, v] of Object.entries(body.overrides || {})) {
          if (!v || (v.subject == null && v.body == null)) delete ov[n];
          else ov[n] = { ...(v.subject != null ? { subject: String(v.subject).slice(0, 300) } : {}), ...(v.body != null ? { body: String(v.body).slice(0, 10000) } : {}) };
        }
        db.prepare("UPDATE leads SET overrides = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(ov), now(), lead.id);
        reply(200, leadDetail(db.prepare("SELECT * FROM leads WHERE id = ?").get(lead.id))); return true;
      }
    }

    const cm = /^\/api\/campaigns\/(\d+)(\/[a-z-]+)?(\/[a-z-]+)?$/.exec(p);
    if (!cm) return false;
    const c = getCampaign(Number(cm[1]));
    if (!c) { reply(404, { error: "Campaign not found" }); return true; }
    const sub = (cm[2] || "") + (cm[3] || "");
    if (!sub && m === "GET") {
      reply(200, { ...publicCampaign(c, s), steps: stepsOf(c.id), daily: campaignDaily(c.id, s.timezone),
        variables: [...new Set(db.prepare("SELECT vars FROM leads WHERE campaign_id = ? ORDER BY id DESC LIMIT 20").all(c.id).flatMap((r) => Object.keys(J(r.vars, {}))))].sort() });
      return true;
    }
    if (!sub && m === "PUT") { updateCampaign(c, await readJson(req)); reply(200, { ok: true }); return true; }
    if (!sub && m === "DELETE") {
      db.prepare("UPDATE campaigns SET status = 'archived', updated_at = ? WHERE id = ?").run(now(), c.id);
      db.prepare("UPDATE leads SET status = 'skipped', next_at = NULL WHERE campaign_id = ? AND status IN ('review','queued')").run(c.id);
      event("info", null, `Campaign "${c.name}" archived`); reply(200, { ok: true }); return true;
    }
    if (sub === "/status" && m === "POST") {
      const { status } = await readJson(req);
      if (!["active", "paused"].includes(status)) { reply(400, { error: "Unknown status" }); return true; }
      if (status === "active") {
        if (!J(c.sender_ids, []).length) { reply(400, { error: "Pick at least one inbox under Schedule & inboxes" }); return true; }
        if (!stepsOf(c.id).length) { reply(400, { error: "Add at least one step" }); return true; }
      }
      db.prepare("UPDATE campaigns SET status = ?, updated_at = ? WHERE id = ?").run(status, now(), c.id);
      event("info", null, `Campaign "${c.name}" ${status === "active" ? "started" : "paused"}`);
      reply(200, { ok: true }); return true;
    }
    if (sub === "/rotate-token" && m === "POST") { db.prepare("UPDATE campaigns SET ingest_token = ? WHERE id = ?").run(token(), c.id); reply(200, { ok: true }); return true; }
    if (sub === "/leads" && m === "GET") {
      const st = url.searchParams.get("status"), q = (url.searchParams.get("q") || "").toLowerCase();
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit")) || 200)), offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
      const where = ["l.campaign_id = ?"], args = [c.id];
      if (st && LEAD_STATUSES.includes(st)) { where.push("l.status = ?"); args.push(st); }
      // Columns are named with "l." because inboxes, joined below for the sender, has email and name too.
      if (q) { where.push("(l.email LIKE ? OR l.name LIKE ? OR l.company LIKE ?)"); args.push(`%${q}%`, `%${q}%`, `%${q}%`); }
      const rows = db.prepare(`SELECT l.id, l.email, l.name, l.company, l.title, l.status, l.step, l.next_at, l.error, l.updated_at, i.email sender
        FROM leads l LEFT JOIN inboxes i ON i.id = l.sender_id WHERE ${where.join(" AND ")} ORDER BY l.id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset);
      const total = db.prepare(`SELECT COUNT(*) c FROM leads l WHERE ${where.join(" AND ")}`).get(...args).c;
      reply(200, { rows, total }); return true;
    }
    if (sub === "/leads" && m === "POST") {
      const body = await readJson(req);
      reply(200, addLeads(c, Array.isArray(body) ? body : body.leads || [], body.source || "the panel")); return true;
    }
    if (sub === "/leads/action" && m === "POST") {
      const { ids = [], status: fromStatus, action } = await readJson(req);
      const target = { approve: ["queued", ["review", "failed", "skipped"]], skip: ["skipped", ["review", "queued", "failed"]], requeue: ["queued", ["failed", "skipped"]] }[action];
      const sel = fromStatus ? db.prepare("SELECT id FROM leads WHERE campaign_id = ? AND status = ?").all(c.id, fromStatus).map((r) => r.id) : ids.map(Number);
      let changed = 0;
      for (const id of sel) {
        if (action === "delete") { changed += db.prepare("DELETE FROM leads WHERE id = ? AND campaign_id = ? AND step = 0").run(id, c.id).changes; continue; }
        if (!target) break;
        changed += db.prepare(`UPDATE leads SET status = ?, error = NULL, next_at = COALESCE(next_at, ?), updated_at = ? WHERE id = ? AND campaign_id = ? AND status IN (${target[1].map(() => "?").join(",")})`)
          .run(target[0], now(), now(), id, c.id, ...target[1]).changes;
      }
      reply(200, { changed }); return true;
    }
    if (sub === "/test" && m === "POST") {
      // Sends step 1, rendered for the newest lead (or sample values), to one of your own inboxes.
      const { to } = await readJson(req);
      const target = listInboxes().find((i) => i.email === String(to || "").toLowerCase());
      if (!target) { reply(400, { error: "Pick one of your own inboxes to receive the test" }); return true; }
      const sender = listInboxes().find((i) => J(c.sender_ids, []).includes(i.id) && i.role === "sender");
      if (!sender) { reply(400, { error: "Pick at least one sending inbox first" }); return true; }
      const blocked = await blockedReason(s, sender);
      if (blocked) { reply(400, { error: `${sender.email}: ${blocked}` }); return true; }
      const lead = db.prepare("SELECT * FROM leads WHERE campaign_id = ? ORDER BY id DESC LIMIT 1").get(c.id)
        || { email: target.email, name: "Priya Sharma", first_name: "Priya", company: "Acme", title: "Head of Sales", vars: "{}", overrides: "{}" };
      const step = stepsOf(c.id)[0];
      const mail = compose(c, step, lead, sender);
      if (mail.empty || mail.missing?.length) { reply(400, { error: mail.empty ? "Step 1 is empty for this lead" : `Missing ${mail.missing.join(", ")}` }); return true; }
      try { await deliver(sender, { to: target.email, subject: `[TEST] ${mail.subject}`, text: mail.text }, { test: true }); }
      catch (e) { reply(400, { error: String(e.message).slice(0, 200) }); return true; }
      event("info", sender.email, `Test of "${c.name}" sent to ${target.email}`);
      reply(200, { from: sender.email, to: target.email, subject: mail.subject }); return true;
    }
    return false;
  }

  // ── Public routes: lead ingest, unsubscribe, tracking ────────────────────────
  async function publicRoute(req, res, url) {
    const p = url.pathname;
    const im = /^\/i\/([A-Za-z0-9_-]{16,})$/.exec(p);
    if (im) {
      const send = (code, body) => res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(body));
      const c = db.prepare("SELECT * FROM campaigns WHERE ingest_token = ? AND status != 'archived'").get(im[1]);
      if (!c) return send(404, { error: "Unknown campaign link" }), true;
      if (req.method === "GET") return send(200, { ok: true, campaign: c.name }), true;
      if (req.method !== "POST") return send(405, { error: "POST leads here" }), true;
      let body;
      try { body = await readJsonBig(req); } catch (e) { return send(400, { error: e.message }), true; }
      const rows = Array.isArray(body) ? body : Array.isArray(body?.leads) ? body.leads : [body];
      const r = addLeads(c, rows, "PitchPersona webhook");
      return send(200, { ok: true, ...r }), true;
    }
    const um = /^\/u\/([A-Za-z0-9_-]{16,})$/.exec(p);
    if (um) {
      const lead = db.prepare("SELECT * FROM leads WHERE token = ?").get(um[1]);
      const page = (msg) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unsubscribe</title><body style="font:16px system-ui;max-width:460px;margin:15vh auto;padding:0 16px;background:#FAF8F5;color:#16120E">${msg}</body>`);
      if (!lead) return page("<p>This link is no longer valid.</p>"), true;
      if (req.method === "POST") {
        suppress(lead.email, "unsubscribed", "link");
        db.prepare("UPDATE leads SET status='unsubscribed', next_at=NULL, updated_at=? WHERE email = ? AND status NOT IN ('bounced')").run(now(), lead.email);
        event("warn", null, `${lead.email} unsubscribed with the link`);
        return page("<h2>Done.</h2><p>You won't get any more emails from us.</p>"), true;
      }
      // A button, not an automatic unsubscribe: mail scanners open links on their own.
      return page(`<h2>Unsubscribe</h2><p>Stop all emails to <b>${lead.email.replace(/[<>&"]/g, "")}</b>?</p><form method="post"><button style="font:inherit;padding:10px 18px;border-radius:10px;border:0;background:#FF6A1A;color:#1A0D04;font-weight:600;cursor:pointer">Unsubscribe</button></form>`), true;
    }
    const om = /^\/o\/([A-Za-z0-9_-]{16,})\.gif$/.exec(p);
    if (om) {
      db.prepare("UPDATE messages SET opens = opens + 1, first_open_at = COALESCE(first_open_at, ?) WHERE token = ?").run(now(), om[1]);
      res.writeHead(200, { "content-type": "image/gif", "cache-control": "no-store" }).end(TRACK_PIXEL);
      return true;
    }
    const ck = /^\/c\/([A-Za-z0-9_-]{16,})$/.exec(p);
    if (ck) {
      const msg = db.prepare("SELECT * FROM messages WHERE token = ?").get(ck[1]);
      const target = url.searchParams.get("u") || "";
      // Only redirect to a link that was really in that email, so this is never an open redirect.
      if (!msg || !(msg.body.match(URL_RE) || []).includes(target)) { res.writeHead(404).end("Not found"); return true; }
      db.prepare("UPDATE messages SET clicks = clicks + 1, first_click_at = COALESCE(first_click_at, ?) WHERE id = ?").run(now(), msg.id);
      res.writeHead(302, { location: target }).end();
      return true;
    }
    return false;
  }

  function readJsonBig(req) {
    return new Promise((resolve, reject) => {
      let size = 0; const chunks = [];
      req.on("data", (c) => { size += c.length; if (size > 5_000_000) { reject(new Error("Body too large (5 MB max)")); req.destroy(); } else chunks.push(c); });
      req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); } catch { reject(new Error("Body must be JSON")); } });
    });
  }

  return { sendPhase, scanFolder, api, publicRoute, coldStatus, compose, render, normalizeLead, inboxRemoved, housekeeping };
}
