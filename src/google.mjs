// Google sign-in for Workspace inboxes, without app passwords. A Google Cloud service account
// that a Workspace admin has allowed (domain-wide delegation) gets a short-lived token for each
// inbox. Sending goes through the Gmail API over HTTPS, which hosts that block email ports
// (Railway below its Pro plan) leave open. Reading still uses IMAP, signed in with the same token.
import crypto from "node:crypto";

export const GOOGLE_SCOPE = "https://mail.google.com/";   // sending and IMAP both need this one
const AUDIENCE = "https://oauth2.googleapis.com/token";
// Overridable so the tests can point them at local stand-ins.
const TOKEN_URL = process.env.GOOGLE_TOKEN_URL || AUDIENCE;
export const GMAIL_API = (process.env.GMAIL_API_BASE || "https://gmail.googleapis.com").replace(/\/+$/, "");
// Personal Google accounts have no admin who could allow a service account.
export const PERSONAL_GMAIL = /@(gmail|googlemail)\.com$/i;

export class GoogleError extends Error {
  constructor(message, { status = null, code = null, signin = false, network = false } = {}) {
    super(message);
    Object.assign(this, { google: true, status, code, signin, network });
  }
}

// The JSON key file Google Cloud downloads. Returns the parts the mailer keeps.
export function parseServiceAccount(text) {
  let j;
  try { j = typeof text === "string" ? JSON.parse(text.trim()) : text; }
  catch { throw new Error("That isn't a key file. Paste the whole JSON file Google downloaded, from the first { to the last }."); }
  if (j?.type !== "service_account")
    throw new Error("That JSON isn't a service-account key. In Google Cloud open IAM & Admin, Service accounts, pick the account, then Keys, Add key, Create new key, JSON.");
  if (!j.client_email || !j.private_key || !j.client_id) throw new Error("The key file is missing parts (client_email, private_key or client_id). Download a new JSON key and paste it again.");
  try { crypto.createPrivateKey(j.private_key); } catch { throw new Error("The private key in that file is damaged. Download a new JSON key and paste it again."); }
  return { client_email: String(j.client_email), client_id: String(j.client_id), private_key: j.private_key,
    private_key_id: j.private_key_id ? String(j.private_key_id) : null, project_id: j.project_id ? String(j.project_id) : null };
}

// A request to Google. A connection that never got through reads like a mail server's
// ("connect ECONNREFUSED host:port"), so it's explained the same way.
async function call(url, init) {
  try { return await fetch(url, { ...init, signal: AbortSignal.timeout(30000) }); }
  catch (e) {
    const u = new URL(url);
    if (e?.name === "TimeoutError") throw new GoogleError(`${u.hostname} didn't answer within 30 seconds`, { network: true });
    const code = e?.cause?.code === "UND_ERR_CONNECT_TIMEOUT" ? "ETIMEDOUT" : e?.cause?.code || e?.code || "ECONNRESET";
    throw new GoogleError(/ENOTFOUND|EAI_AGAIN/.test(code) ? `getaddrinfo ${code} ${u.hostname}` : `connect ${code} ${u.hostname}:${u.port || 443}`, { code, network: true });
  }
}

// account() returns the saved service account, or null.
export function createGoogle({ account }) {
  const tokens = new Map();   // "service account|inbox" -> { token, exp }

  async function token(email, { fresh = false } = {}) {
    const sa = account();
    if (!sa) throw new GoogleError("Google sign-in is chosen, but no service-account key is saved", { code: "no_key", signin: true });
    const k = `${sa.client_email}|${email}`, c = tokens.get(k);
    if (!fresh && c && c.exp - 60000 > Date.now()) return c.token;
    const now = Math.floor(Date.now() / 1000), b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const unsigned = `${b64({ alg: "RS256", typ: "JWT", ...(sa.private_key_id ? { kid: sa.private_key_id } : {}) })}.${b64({
      iss: sa.client_email, sub: email, scope: GOOGLE_SCOPE, aud: AUDIENCE, iat: now, exp: now + 3600 })}`;
    const jwt = `${unsigned}.${crypto.sign("RSA-SHA256", Buffer.from(unsigned), sa.private_key).toString("base64url")}`;
    const r = await call(TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }).toString() });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token)
      throw new GoogleError(`Google sign-in refused: ${j.error || `HTTP ${r.status}`}${j.error_description ? `: ${j.error_description}` : ""}`, { status: r.status, code: j.error || null, signin: true });
    tokens.set(k, { token: j.access_token, exp: Date.now() + (Number(j.expires_in) || 3600) * 1000 });
    return j.access_token;
  }

  async function gmail(email, method, path, body) {
    let t = await token(email);
    for (let attempt = 0; ; attempt++) {
      const r = await call(`${GMAIL_API}/gmail/v1/users/${encodeURIComponent(email)}${path}`, { method,
        headers: { authorization: `Bearer ${t}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
      // An expired or revoked token gets one fresh try. Nothing was accepted, so a send can't go out twice.
      if (r.status === 401 && attempt === 0) { t = await token(email, { fresh: true }); continue; }
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        const e = j.error || {}, reason = e.errors?.[0]?.reason || e.status || "";
        throw new GoogleError(`Gmail API ${r.status}${reason ? ` ${reason}` : ""}: ${String(e.message || r.statusText).replace(/\s+/g, " ").trim()}`, { status: r.status, code: reason || null });
      }
      return j;
    }
  }

  // Sends a complete message. Returns the Message-ID Gmail actually used: replies and reply
  // matching depend on it, and Gmail may set its own.
  async function send(email, raw, { inReplyTo } = {}) {
    let threadId;
    // In the sender's own mailbox, a reply joins its thread only when the thread is named.
    if (inReplyTo) threadId = (await gmail(email, "GET", `/messages?maxResults=1&q=${encodeURIComponent(`rfc822msgid:${inReplyTo.replace(/^<|>$/g, "")}`)}`)
      .catch(() => ({}))).messages?.[0]?.threadId;
    const sent = await gmail(email, "POST", "/messages/send", { raw: Buffer.from(raw).toString("base64url"), ...(threadId ? { threadId } : {}) });
    const meta = await gmail(email, "GET", `/messages/${encodeURIComponent(sent.id)}?format=metadata&metadataHeaders=Message-ID`).catch(() => null);
    const messageId = meta?.payload?.headers?.find((h) => /^message-id$/i.test(h.name))?.value || null;
    return { id: sent.id, threadId: sent.threadId, messageId };
  }

  return {
    token, send,
    // Signs in and opens the mailbox through the API, without sending anything.
    profile: (email) => gmail(email, "GET", "/profile"),
    forget: (email) => { for (const k of tokens.keys()) if (!email || k.endsWith(`|${email}`)) tokens.delete(k); },
  };
}
