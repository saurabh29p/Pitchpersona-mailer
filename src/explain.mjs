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

const DELEGATION = "Security, Access and data control, API controls, Manage Domain Wide Delegation";
const IMAP_ON = "In Google Admin (https://admin.google.com) open Apps, Google Workspace, Gmail, End User Access, and turn on POP and IMAP access.";

// An inbox that signs in through a Google service account (see google.mjs). "smtp" is then its
// sending side, the Gmail API. Returns null for anything the general rules below explain well.
function explainGoogle(kind, r, inbox, account, out) {
  const who = inbox.email, domain = who.split("@")[1];
  const id = account?.clientId || "(the client ID shown under Settings, Google sign-in)";
  if (/no service-account key is saved/i.test(r))
    return out("google_no_key", "Google sign-in is chosen for this inbox, but no service-account key is saved.", "Open Settings, Google sign-in, and add the key file. The steps are listed there.");
  if (/unauthorized_client|access_denied|not authorized for any of the scopes/i.test(r))
    return out("google_delegation", `Google hasn't allowed the mailer to sign in as ${who} yet.`,
      `Sign in to Google Admin (https://admin.google.com) as an admin of ${domain}. Open ${DELEGATION}, press Add new, enter Client ID ${id} and OAuth scope https://mail.google.com/ then press Authorize. Google can take a few minutes, sometimes longer, to apply it. The mailer tries again every 15 minutes by itself, or press Test login.`);
  if (/Invalid email or User ID|invalid_grant: (Not a valid email|Invalid email)/i.test(r))
    return out("google_user", `Google says ${who} isn't an account it can sign in as.`,
      `Check that ${who} is spelled right and is a real user in your Google Workspace, not an alias or a group. A new user can take a few minutes to become usable.`);
  if (/Invalid JWT Signature|invalid_client|disabled_client|account (not found|is disabled|has been deleted)/i.test(r))
    return out("google_key", "Google didn't accept the service-account key. It may have been deleted, or the service account switched off.",
      "In Google Cloud (https://console.cloud.google.com/iam-admin/serviceaccounts) open the service account, then Keys, Add key, Create new key, JSON. Add the new file under Settings, Google sign-in.");
  if (/reasonable timeframe|Invalid JWT/i.test(r))
    return out("google_clock", "Google rejected the sign-in because this server's clock looks wrong.", "Redeploy the mailer. If it keeps happening, tell the hosting provider the server's clock is off.");
  if (/accessNotConfigured|SERVICE_DISABLED|has not been used in project|API has not been used/i.test(r))
    return out("api_off", "The Gmail API is switched off in the Google Cloud project the key belongs to.",
      `Open https://console.cloud.google.com/apis/library/gmail.googleapis.com${account?.projectId ? `?project=${account.projectId}` : ""} press Enable, wait a minute, then press Test login.`);
  if (/failedPrecondition|Precondition check failed|Mail service not enabled/i.test(r))
    return out("gmail_off", `Google won't open ${who}'s mailbox for the mailer.`,
      `Check in Google Admin, Users, that ${who} has a Google Workspace licence with Gmail switched on. Personal Gmail addresses can't use Google sign-in: give them an app password instead.`);
  if (/Delegation denied/i.test(r))
    return out("google_delegation", `Google refused to let the mailer act for ${who}.`, `In Google Admin for ${domain}, open ${DELEGATION} and check Client ID ${id} has the scope https://mail.google.com/ then press Test login.`);
  if (/\b429\b|LimitExceeded|limit exceeded|quotaExceeded|RESOURCE_EXHAUSTED/i.test(r))
    return out("throttled", `Google is limiting how much ${who} can send or read for a while.`,
      "Wait until tomorrow, then press Resume on the inbox if it paused. Keep its daily cap where it is or lower it.");
  const viaApi = kind === "smtp" || /googleapis\.com/i.test(r);
  if (viaApi && (NET_RE.test(r) || /ENOTFOUND|EAI_AGAIN|getaddrinfo|didn't answer within/i.test(r)))
    return out("api_blocked", "The mailer couldn't reach Google's servers.",
      "This is usually brief. The connection is checked again every 5 minutes, or press Test login to try now. If it lasts, check that this server can make outgoing HTTPS connections.");
  if (kind === "imap" && /not enabled for IMAP|IMAP (access )?(is )?disabled|enable your account for IMAP/i.test(r))
    return out("imap_off", `IMAP is turned off for ${who}, so the mailer can't read its inbox.`, `${IMAP_ON} Wait about 15 minutes, then press Test login again.`);
  if (kind === "imap" && /AUTHENTICATIONFAILED|Invalid credentials|authentication failed/i.test(r))
    return out("google_imap", `Google signed the mailer in, but refused it for reading ${who}'s mail.`,
      `${IMAP_ON} Also check in ${DELEGATION} that Client ID ${id} has exactly the scope https://mail.google.com/ . Then press Test login.`);
  return null;
}

// kind: "smtp" (sending) or "imap" (reading). Returns null for "ok" or no result.
// code is one of: smtp_blocked, imap_blocked, api_blocked, host, no_greeting, bad_password, app_password_required,
// web_login, imap_off, throttled, slow, dropped, tls, other, and for Google sign-in google_no_key,
// google_delegation, google_user, google_key, google_clock, api_off, gmail_off, google_imap.
// google: { clientId, projectId } of the saved service account, for the fix texts.
export function explainMailError(kind, raw, inbox, { onRailway = false, google: account = null } = {}) {
  if (!raw || raw === "ok") return null;
  const r = String(raw);
  const host = kind === "smtp" ? inbox.smtp_host : inbox.imap_host, port = kind === "smtp" ? inbox.smtp_port : inbox.imap_port;
  const google = inbox.provider === "google" || /gmail|google/i.test(host || "");
  const who = inbox.email;
  const out = (code, why, fix) => ({ code, why, fix, raw: r });
  if (inbox.signin === "google") { const g = explainGoogle(kind, r, inbox, account, out); if (g) return g; }

  if (/didn't finish within|Socket timeout|ETIMEOUT\b|^Timeout\b/i.test(r))
    return out("slow", "The mail server stopped answering partway through.", "This is usually temporary. Press Test login again in a few minutes.");
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(r))
    return out("host", `The server name ${host} couldn't be found.`,
      google ? "Press Edit and pick Google Workspace / Gmail as the provider. That fills in the right servers." : "Press Edit, open Server settings and check the host name.");
  if (NET_RE.test(r) || (GREETING_RE.test(r) && kind === "smtp" && onRailway)) {
    if (kind === "smtp" && onRailway)
      return out("smtp_blocked", `Railway is blocking outgoing email. The mailer can't open a connection to ${host} on port ${port}, because Railway's Free, Trial and Hobby plans block every email-sending (SMTP) connection.`,
        google ? "Switch this inbox to Google sign-in: it sends through Google's API, which Railway doesn't block, and needs no app password. Settings, Google sign-in has the steps. The other way is to upgrade this Railway workspace to the Pro plan, then redeploy the mailer in Railway."
          : "Upgrade this Railway workspace to the Pro plan, then redeploy the mailer in Railway (Railway only opens the email ports on a new deploy). The mailer checks the connection when it starts and tests the logins again by itself.");
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
    return out("imap_off", `IMAP is turned off for ${who}, so the mailer can't read its inbox.`, `${IMAP_ON} Wait about 15 minutes, then press Test login again.`);
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
