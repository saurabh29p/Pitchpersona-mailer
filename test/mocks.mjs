// Local stand-ins for a mail provider and OpenRouter, all on 127.0.0.1:
// SMTP with STARTTLS (smtp-server), a small IMAP server over TLS, and a fake chat endpoint.
// Addresses starting with "ghost" don't exist; mail to "spamtrap..." is refused as spam;
// the password "wrong-password" is rejected by both SMTP and IMAP.
// With googlePublicKey, also Google's token endpoint and the Gmail API calls the mailer makes
// (see startGoogle below); its tokens sign in to the IMAP server with XOAUTH2, like Gmail's.
import tls from "node:tls";
import http from "node:http";
import crypto from "node:crypto";
import { SMTPServer } from "smtp-server";

const listen = (srv) => new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv.address().port)));
const hdr = (raw, name) => (raw.match(new RegExp(`^${name}:\\s*(.*)$`, "mi")) || [])[1]?.trim() || "";
const q = (s) => (s == null || s === "" ? "NIL" : `"${String(s).replace(/(["\\])/g, "\\$1")}"`);
const addr = (v) => {
  const m = /(?:"?([^"<]*)"?\s*)?<?([^\s<>@]+)@([^\s<>]+?)>?$/.exec(v.trim());
  return m ? `((${q(m[1]?.trim())} NIL ${q(m[2])} ${q(m[3])}))` : "NIL";
};
const envelope = (raw) => `(${q(hdr(raw, "Date"))} ${q(hdr(raw, "Subject"))} ${addr(hdr(raw, "From"))} ${addr(hdr(raw, "From"))} ${addr(hdr(raw, "From"))} ${addr(hdr(raw, "To"))} NIL NIL ${q(hdr(raw, "In-Reply-To"))} ${q(hdr(raw, "Message-ID"))})`;
const lit = (s) => `{${Buffer.byteLength(s)}}\r\n${s}`;

export async function startMocks({ key, cert, googlePublicKey = null }) {
  const received = [], commands = [], boxes = {};
  const box = (u) => (boxes[u] ||= { INBOX: { msgs: [], next: 1 }, Junk: { msgs: [], next: 1 } });
  const google = googlePublicKey ? await startGoogle(googlePublicKey, (to, raw) => { const b = box(to).INBOX; b.msgs.push({ uid: b.next++, raw }); }, received) : null;

  const smtp = new SMTPServer({
    secure: false, key, cert, logger: false,
    onAuth(auth, _s, cb) { auth.password === "wrong-password" ? cb(new Error("535 5.7.8 Username and Password not accepted")) : cb(null, { user: auth.username }); },
    onRcptTo(a, _s, cb) {
      if (/^ghost/.test(a.address)) return cb(Object.assign(new Error("5.1.1 The email account that you tried to reach does not exist"), { responseCode: 550 }));
      cb();
    },
    onData(stream, session, cb) {
      const chunks = []; stream.on("data", (c) => chunks.push(c));
      stream.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        if (session.envelope.rcptTo.some((r) => /^spamtrap/.test(r.address))) return cb(Object.assign(new Error("5.7.1 Message rejected as spam"), { responseCode: 550 }));
        received.push({ from: session.envelope.mailFrom.address, to: session.envelope.rcptTo.map((r) => r.address), raw });
        // Like Gmail, the receiving side records a DKIM verdict. Domains with "nodkim" in them are
        // signed with Google's default key, as before Start authentication is clicked.
        const dom = session.envelope.mailFrom.address.split("@")[1];
        const signer = /nodkim/.test(dom) ? `${dom.replace(/\./g, "-")}.20230601.gappssmtp.com` : dom;
        const stored = `Authentication-Results: mock.test;\r\n       dkim=pass header.i=@${signer} header.s=google;\r\n       spf=pass smtp.mailfrom=${session.envelope.mailFrom.address}\r\n${raw}`;
        for (const r of session.envelope.rcptTo) { const b = box(r.address).INBOX; b.msgs.push({ uid: b.next++, raw: stored }); }
        cb();
      });
    },
  });
  smtp.on("error", () => {});
  const smtpPort = await new Promise((r) => smtp.listen(0, "127.0.0.1", () => r(smtp.server.address().port)));

  const imap = tls.createServer({ key, cert }, (s) => {
    let user = null, sel = null, buf = "", refused = null;
    s.write("* OK [CAPABILITY IMAP4rev1 UIDPLUS MOVE AUTH=XOAUTH2] mock ready\r\n");
    s.on("data", (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        // Like Gmail, a refused XOAUTH2 sign-in waits for the client's empty line before saying NO.
        if (refused) { s.write(`${refused} NO [AUTHENTICATIONFAILED] Invalid credentials (Failure)\r\n`); refused = null; continue; }
        const sp = line.indexOf(" "), tag = line.slice(0, sp), rest = line.slice(sp + 1), cmd = rest.toUpperCase();
        commands.push(rest.replace(/^LOGIN .*/i, "LOGIN ***").replace(/^(AUTHENTICATE \S+) .*/i, "$1 ***"));
        const ok = (t = "done") => s.write(`${tag} OK ${t}\r\n`);
        if (cmd.startsWith("CAPABILITY")) { s.write("* CAPABILITY IMAP4rev1 UIDPLUS MOVE AUTH=XOAUTH2\r\n"); ok(); }
        else if (cmd.startsWith("AUTHENTICATE XOAUTH2")) {
          const sasl = Buffer.from(rest.split(/\s+/)[2] || "", "base64").toString();
          const u = /user=([^\x01]+)/.exec(sasl)?.[1], t = /auth=Bearer ([^\x01]+)/.exec(sasl)?.[1];
          if (u && t && google?.tokens.get(t) === u) { user = u; ok("authenticated"); }
          else { s.write(`+ ${Buffer.from(JSON.stringify({ status: "400", schemes: "Bearer", scope: "https://mail.google.com/" })).toString("base64")}\r\n`); refused = tag; }
        }
        else if (cmd.startsWith("LOGIN")) {
          const m = /^LOGIN\s+"?([^"\s]+)"?\s+"?([^"\s]*)"?/i.exec(rest);
          if (m[2] === "wrong-password") s.write(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials (Failure)\r\n`); else { user = m[1]; ok("logged in"); }
        }
        else if (cmd.startsWith("LIST") || cmd.startsWith("LSUB")) {
          const k = cmd.startsWith("LIST") ? "LIST" : "LSUB";
          s.write(`* ${k} (\\HasNoChildren) "/" "INBOX"\r\n* ${k} (\\HasNoChildren \\Junk) "/" "Junk"\r\n`); ok();
        }
        else if (cmd.startsWith("SELECT") || cmd.startsWith("EXAMINE")) {
          sel = /INBOX/i.test(rest) ? "INBOX" : "Junk";
          const b = box(user)[sel];
          s.write(`* ${b.msgs.length} EXISTS\r\n* 0 RECENT\r\n* OK [UIDVALIDITY 42] ok\r\n* OK [UIDNEXT ${b.next}] ok\r\n* FLAGS (\\Seen \\Flagged)\r\n* OK [PERMANENTFLAGS (\\Seen \\Flagged \\*)] ok\r\n${tag} OK [READ-WRITE] selected\r\n`);
        }
        else if (cmd.startsWith("UID SEARCH")) {
          const froms = [...rest.matchAll(/FROM\s+"?([^"\s)]+)"?/gi)].map((m) => m[1].toLowerCase());
          const hits = box(user)[sel].msgs.filter((m) => !froms.length || froms.some((f) => hdr(m.raw, "From").toLowerCase().includes(f))).map((m) => m.uid);
          s.write(`* SEARCH${hits.map((u) => " " + u).join("")}\r\n`); ok();
        }
        else if (cmd.startsWith("UID FETCH")) {
          const [, range, items] = /^UID FETCH\s+(\S+)\s+\((.*)\)$/i.exec(rest);
          const b = box(user)[sel];
          const pick = range.split(",").flatMap((r) => { const [lo, hi] = r.split(":"); const L = Number(lo), H = hi === "*" ? Infinity : Number(hi ?? lo); return b.msgs.filter((m) => m.uid >= L && m.uid <= H); });
          if (!pick.length && /:\*/.test(range) && b.msgs.length) pick.push(b.msgs.at(-1));     // "N:*" always returns the last message
          for (const m of pick) {
            const parts = [`UID ${m.uid}`];
            if (/ENVELOPE/i.test(items)) parts.push(`ENVELOPE ${envelope(m.raw)}`);
            if (/FLAGS/i.test(items)) parts.push("FLAGS ()");
            const hf = /BODY\.PEEK\[HEADER\.FIELDS \(([^)]*)\)\]/i.exec(items);
            if (hf) {
              const want = hf[1].split(/\s+/).map((w) => w.toUpperCase() + ":");
              const lines = m.raw.split(/\r?\n\r?\n/)[0].split(/\r?\n(?![ \t])/).filter((l) => want.some((w) => l.toUpperCase().startsWith(w)));
              parts.push(`BODY[HEADER.FIELDS (${hf[1]})] ${lit(lines.join("\r\n") + "\r\n\r\n")}`);
            }
            const part = /BODY\.PEEK\[\]<(\d+)\.(\d+)>/i.exec(items);
            if (part) parts.push(`BODY[]<${part[1]}> ${lit(Buffer.from(m.raw).subarray(Number(part[1]), Number(part[1]) + Number(part[2])).toString())}`);
            else if (/BODY\.PEEK\[\]/i.test(items)) parts.push(`BODY[] ${lit(m.raw)}`);
            s.write(`* ${b.msgs.indexOf(m) + 1} FETCH (${parts.join(" ")})\r\n`);
          }
          ok("fetch done");
        }
        else if (cmd.startsWith("UID MOVE")) {
          const uid = Number(/^UID MOVE\s+(\d+)/i.exec(rest)[1]), b = box(user)[sel], k = b.msgs.findIndex((m) => m.uid === uid);
          if (k >= 0) { const [m] = b.msgs.splice(k, 1); const t = box(user).INBOX; t.msgs.push({ ...m, uid: t.next++ }); s.write(`* ${k + 1} EXPUNGE\r\n`); }
          ok("moved");
        }
        else if (cmd.startsWith("LOGOUT")) { s.write(`* BYE\r\n${tag} OK bye\r\n`); s.end(); }
        else ok();
      }
    });
    s.on("error", () => {});
  });
  const imapPort = await listen(imap);

  // OpenRouter's chat completions shape. The text has a link and an em dash, which the engine must strip.
  const ai = http.createServer((req, res) => {
    let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
      if (req.headers.authorization !== "Bearer sk-or-test") return res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "No auth credentials found" } }));
      const content = JSON.parse(b || "{}").messages?.[0]?.content || "";
      const isReply = /reply/i.test(content) && !/subject/.test(content.split("Reply with only JSON")[1] || "");
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ usage: { cost: 0.00042 }, choices: [{ message: { content: isReply
        ? '{"body":"Thanks Sam, Tuesday works. See https://x.com for details \u2014 cheers.\\n\\nAlex"}'
        : 'Sure! {"subject":"Q4 planning doc","body":"Hi Sam,\\n\\nCould you look at the Q4 doc \u2014 see www.example.com\\n\\nAlex"}' } }] }));
    });
  });
  const aiPort = await listen(ai);

  return {
    smtpPort, imapPort, aiUrl: `http://127.0.0.1:${aiPort}`, received, commands, google,
    deliver: (to, raw, folder = "INBOX") => { const t = box(to)[folder]; t.msgs.push({ uid: t.next++, raw }); },
    close: () => { smtp.close(); imap.close(); ai.close(); google?.close(); },
  };
}

// Google's token endpoint (POST /token) and the Gmail API (/gmail/v1/users/...), as the mailer
// uses them. Like Google: a token is issued only for a domain whose admin delegated the client
// (google.delegated), the API can be switched off (google.apiOn = false), sends can hit the rate
// limit (google.limited = true), and Gmail gives every sent message its own Message-ID. Sent mail
// lands in the recipient's IMAP inbox. "ghost" addresses aren't users.
async function startGoogle(publicKey, toInbox, received) {
  const g = { delegated: new Set(), apiOn: true, limited: false, tokens: new Map(), tokenRequests: [], sent: [], store: {} };
  const mailbox = (u) => (g.store[u] ||= { byId: new Map(), byMsgId: new Map() });
  const json = (res, code, body) => res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(body));
  const apiError = (res, code, status, reason, message) => json(res, code, { error: { code, message, status, errors: [{ reason, message }] } });
  const newId = () => crypto.randomBytes(8).toString("hex");
  const server = http.createServer((req, res) => {
    let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
      const url = new URL(req.url, "http://x");
      if (url.pathname === "/token" && req.method === "POST") {
        const f = new URLSearchParams(b), [h, p, sig] = String(f.get("assertion") || "").split(".");
        let claims = {}; try { claims = JSON.parse(Buffer.from(p, "base64url").toString()); } catch { /* checked below */ }
        g.tokenRequests.push(claims.sub);
        if (f.get("grant_type") !== "urn:ietf:params:oauth:grant-type:jwt-bearer") return json(res, 400, { error: "unsupported_grant_type" });
        let signed = false; try { signed = crypto.verify("RSA-SHA256", Buffer.from(`${h}.${p}`), publicKey, Buffer.from(sig, "base64url")); } catch { /* bad signature */ }
        if (!signed) return json(res, 400, { error: "invalid_grant", error_description: "Invalid JWT Signature." });
        if (claims.aud !== "https://oauth2.googleapis.com/token" || claims.scope !== "https://mail.google.com/" || !(claims.exp > claims.iat))
          return json(res, 400, { error: "invalid_scope", error_description: "Bad audience, scope or lifetime" });
        const sub = String(claims.sub || "");
        if (/^ghost/.test(sub)) return json(res, 400, { error: "invalid_grant", error_description: "Invalid email or User ID" });
        if (!g.delegated.has(sub.split("@")[1]))
          return json(res, 401, { error: "unauthorized_client", error_description: "Client is unauthorized to retrieve access tokens using this method, or client not authorized for any of the scopes requested." });
        const t = `ya29.mock-${newId()}`; g.tokens.set(t, sub);
        return json(res, 200, { access_token: t, expires_in: 3599, token_type: "Bearer" });
      }
      const m = /^\/gmail\/v1\/users\/([^/]+)(\/.*)$/.exec(url.pathname);
      if (!m) return json(res, 404, {});
      const who = g.tokens.get(String(req.headers.authorization || "").replace(/^Bearer /, ""));
      if (!who) return apiError(res, 401, "UNAUTHENTICATED", "authError", "Request had invalid authentication credentials.");
      if (decodeURIComponent(m[1]) !== "me" && decodeURIComponent(m[1]) !== who) return apiError(res, 403, "PERMISSION_DENIED", "forbidden", `Delegation denied for ${who}`);
      if (!g.apiOn) return apiError(res, 403, "PERMISSION_DENIED", "accessNotConfigured",
        "Gmail API has not been used in project 1234567890 before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/gmail.googleapis.com/overview?project=1234567890 then retry.");
      const me = mailbox(who), path = m[2];
      if (path === "/profile") return json(res, 200, { emailAddress: who, messagesTotal: me.byId.size, threadsTotal: 0, historyId: "1" });
      if (path === "/messages/send" && req.method === "POST") {
        if (g.limited) return apiError(res, 429, "RESOURCE_EXHAUSTED", "rateLimitExceeded", "User-rate limit exceeded.  Retry after 2026-10-06T00:00:00.000Z");
        const body = JSON.parse(b || "{}");
        let raw = Buffer.from(body.raw || "", "base64url").toString("utf8");
        const head = raw.split(/\r?\n\r?\n/)[0];
        const get = (n) => (head.match(new RegExp(`^${n}:[ \\t]*(.*(?:\\r?\\n[ \\t].*)*)`, "mi")) || [])[1]?.replace(/\r?\n[ \t]+/g, " ").trim() || "";
        const to = [...get("To").matchAll(/[^\s<>",]+@[^\s<>",]+/g)].map((x) => x[0].toLowerCase());
        if (!to.length) return apiError(res, 400, "INVALID_ARGUMENT", "invalidArgument", "Recipient address required");
        const messageId = `<CA${newId()}@mail.gmail.com>`;
        raw = /^Message-ID:/mi.test(head) ? raw.replace(/^Message-ID:.*$/mi, `Message-ID: ${messageId}`) : `Message-ID: ${messageId}\r\n${raw}`;
        const id = newId(), known = body.threadId && [...me.byId.values()].some((x) => x.threadId === body.threadId);
        const threadId = known ? body.threadId : id;
        me.byId.set(id, { threadId, messageId }); me.byMsgId.set(messageId, { id, threadId });
        const parentId = get("In-Reply-To");
        g.sent.push({ from: who, to, raw, threadId: body.threadId || null, inReplyTo: parentId || null, messageId, fromHeader: get("From") });
        received.push({ from: who, to, raw, via: "gmail-api" });
        for (const r of to) {
          const box = mailbox(r), rid = newId(), thread = box.byMsgId.get(parentId)?.threadId || rid;
          box.byId.set(rid, { threadId: thread, messageId }); box.byMsgId.set(messageId, { id: rid, threadId: thread });
          toInbox(r, `Authentication-Results: mock.test;\r\n       dkim=pass header.i=@${who.split("@")[1]} header.s=google;\r\n       spf=pass smtp.mailfrom=${who}\r\n${raw}`);
        }
        return json(res, 200, { id, threadId, labelIds: ["SENT"] });
      }
      const one = /^\/messages\/([^/]+)$/.exec(path);
      if (one && req.method === "GET") {
        const x = me.byId.get(one[1]);
        return x ? json(res, 200, { id: one[1], threadId: x.threadId, payload: { headers: [{ name: "Message-ID", value: x.messageId }] } }) : apiError(res, 404, "NOT_FOUND", "notFound", "Requested entity was not found.");
      }
      if (path === "/messages" && req.method === "GET") {
        const q = /rfc822msgid:(\S+)/.exec(url.searchParams.get("q") || "")?.[1], x = q && me.byMsgId.get(q.startsWith("<") ? q : `<${q}>`);
        return json(res, 200, x ? { messages: [{ id: x.id, threadId: x.threadId }], resultSizeEstimate: 1 } : { resultSizeEstimate: 0 });
      }
      return json(res, 404, {});
    });
  });
  const port = await listen(server);
  return Object.assign(g, { url: `http://127.0.0.1:${port}`, close: () => server.close() });
}
