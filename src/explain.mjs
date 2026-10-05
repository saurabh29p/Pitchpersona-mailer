// Turns what a mail server said into a reason and a fix a person can act on.
// Used for Test login results, the Overview banner, the setup checklist and Activity.

// The connection itself never got through: nothing about the password is known yet.
export const NET_RE = /\b(ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|CONNECT_TIMEOUT)\b|Connection timeout|connect E[A-Z]+/i;
// Connected, but the other end never said hello the way a mail server does.
const GREETING_RE = /Greeting never received|Failed to receive greeting|GREETING_TIMEOUT/i;

// The error text worth keeping: the server's own words plus the error code when it adds something.
export function errText(e) {
  // nodemailer and imapflow keep the server's own line in `response` (imapflow only once it's text).
  let m = String((typeof e?.response === "string" && e.response) || e?.responseText || e?.message || e).replace(/\s+/g, " ").trim();
  if (e?.serverResponseCode && !m.includes(e.serverResponseCode)) m = `[${e.serverResponseCode}] ${m}`;
  else if (e?.authenticationFailed && !/AUTHENTICATIONFAILED/.test(m)) m = `[AUTHENTICATIONFAILED] ${m}`;
  if (e?.code && !m.includes(e.code)) m = `${m} (${e.code})`;
  return m.slice(0, 300);
}

const APP_PASSWORDS = "https://myaccount.google.com/apppasswords";
const TWO_STEP = "https://myaccount.google.com/signinoptions/twosv";

// kind: "smtp" (sending) or "imap" (reading). Returns null for "ok" or no result.
// code is one of: smtp_blocked, imap_blocked, host, no_greeting, bad_password, app_password_required,
// web_login, imap_off, throttled, slow, dropped, tls, other.
export function explainMailError(kind, raw, inbox, { onRailway = false } = {}) {
  if (!raw || raw === "ok") return null;
  const r = String(raw);
  const host = kind === "smtp" ? inbox.smtp_host : inbox.imap_host, port = kind === "smtp" ? inbox.smtp_port : inbox.imap_port;
  const google = inbox.provider === "google" || /gmail|google/i.test(host || "");
  const who = inbox.email;
  const out = (code, why, fix) => ({ code, why, fix, raw: r });

  if (/didn't finish within|Socket timeout|ETIMEOUT\b|^Timeout\b/i.test(r))
    return out("slow", "The mail server stopped answering partway through.", "This is usually temporary. Press Test login again in a few minutes.");
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(r))
    return out("host", `The server name ${host} couldn't be found.`,
      google ? "Press Edit and pick Google Workspace / Gmail as the provider. That fills in the right servers." : "Press Edit, open Server settings and check the host name.");
  if (NET_RE.test(r) || (GREETING_RE.test(r) && kind === "smtp" && onRailway)) {
    if (kind === "smtp" && onRailway)
      return out("smtp_blocked", `Railway is blocking outgoing email. The mailer can't open a connection to ${host} on port ${port}, because Railway's Free, Trial and Hobby plans block every email-sending (SMTP) connection.`,
        "Upgrade this Railway workspace to the Pro plan, then redeploy the mailer in Railway (Railway only opens the email ports on a new deploy). The mailer checks the connection when it starts and tests the logins again by itself. Nothing in Google needs changing.");
    return out(kind === "smtp" ? "smtp_blocked" : "imap_blocked", `The mailer can't open a connection to ${host} on port ${port}. Something between this server and the mail provider is blocking it.`,
      `Check the host and port under Edit, Server settings. If they're right, this server's network blocks outgoing connections on port ${port}.`);
  }
  if (GREETING_RE.test(r))
    return out("no_greeting", `${host} accepted the connection on port ${port} but never answered like a mail server.`,
      "Press Edit and pick your provider again to reset the servers. For Gmail, sending uses port 465 and reading uses 993.");
  if (/5\.7\.9|Application-specific password required|InvalidSecondFactor/i.test(r))
    return out("app_password_required", "Google wants an app password for this inbox, not its normal password.",
      `Sign in to Google as ${who}, turn on 2-Step Verification (${TWO_STEP}), create an app password (${APP_PASSWORDS}), then press Edit here, paste the 16 letters and Save.`);
  if (/5\.7\.14|web ?browser|WEBALERT|Web login required/i.test(r))
    return out("web_login", "Google stopped the sign-in until it's confirmed in a browser.",
      `Sign in to Gmail as ${who} in a browser, approve any security prompt, then press Test login again.`);
  if (/not enabled for IMAP|IMAP (access )?(is )?disabled|enable your account for IMAP/i.test(r))
    return out("imap_off", `IMAP is turned off for ${who}, so the mailer can't read its inbox.`,
      "In Google Admin (https://admin.google.com) open Apps, Google Workspace, Gmail, End User Access, and turn on POP and IMAP access. Wait about 15 minutes, then press Test login again.");
  if (/too many|THROTTLED|4\.7\.0|try again later|temporar/i.test(r))
    return out("throttled", "The provider is limiting sign-ins for this inbox for a while.", "Wait 15 to 30 minutes, then press Test login again. Don't retry in a loop: it makes the wait longer.");
  if (/\b535\b|5\.7\.8|BadCredentials|AUTHENTICATIONFAILED|Invalid credentials|LOGIN failed|Username and Password not accepted|EAUTH|Invalid login|authentication failed|password was rejected/i.test(r))
    return google
      ? out("bad_password", `Google rejected the app password for ${who}.`,
        `Create a new app password while signed in as ${who} (${APP_PASSWORDS}), then press Edit here, paste the 16 letters and Save. Use an app password, not the normal Google password. If that page says app passwords aren't available, turn on 2-Step Verification for ${who} first (${TWO_STEP}); in Google Workspace an admin may need to allow it under Security, Authentication.`)
      : out("bad_password", `The mail server rejected the password for ${who}.`, "Press Edit, paste the right password (or an app password, if the provider uses them) and Save, then press Test login.");
  if (/Unexpected close|Connection closed|ECONNRESET|EPIPE|socket hang up/i.test(r))
    return out("dropped", "The mail server closed the connection unexpectedly.", "Usually temporary. Press Test login again in a few minutes.");
  if (/certificate|CERT_|self[- ]signed|wrong version number|EPROTO|SSL routines/i.test(r))
    return out("tls", `The secure connection to ${host} failed. The port and the security setting probably don't match.`,
      "Press Edit and pick your provider again to reset the servers. For Gmail, sending uses port 465 and reading uses 993.");
  return out("other", `The mail server answered: "${r.slice(0, 160)}"`, "Check the provider and app password under Edit, then press Test login again.");
}

// One line for the Activity log: the plain reason and fix when there is one, the raw text otherwise.
export function friendlyError(kind, e, inbox, opts) {
  const raw = typeof e === "string" ? e : errText(e);
  const x = explainMailError(kind, raw, inbox, opts);
  return x && !["other", "slow", "dropped", "throttled"].includes(x.code) ? `${x.why} ${x.fix}` : raw;
}
