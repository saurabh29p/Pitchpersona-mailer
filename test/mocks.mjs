// Local stand-ins for a mail provider and OpenRouter, all on 127.0.0.1:
// SMTP with STARTTLS (smtp-server), a small IMAP server over TLS, and a fake chat endpoint.
// Addresses starting with "ghost" don't exist; mail to "spamtrap..." is refused as spam;
// the password "wrong-password" is rejected by both SMTP and IMAP.
import tls from "node:tls";
import http from "node:http";
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

export async function startMocks({ key, cert }) {
  const received = [], commands = [], boxes = {};
  const box = (u) => (boxes[u] ||= { INBOX: { msgs: [], next: 1 }, Junk: { msgs: [], next: 1 } });

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
    let user = null, sel = null, buf = "";
    s.write("* OK [CAPABILITY IMAP4rev1 UIDPLUS MOVE] mock ready\r\n");
    s.on("data", (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        const sp = line.indexOf(" "), tag = line.slice(0, sp), rest = line.slice(sp + 1), cmd = rest.toUpperCase();
        commands.push(rest.replace(/^LOGIN .*/i, "LOGIN ***"));
        const ok = (t = "done") => s.write(`${tag} OK ${t}\r\n`);
        if (cmd.startsWith("CAPABILITY")) { s.write("* CAPABILITY IMAP4rev1 UIDPLUS MOVE\r\n"); ok(); }
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
    smtpPort, imapPort, aiUrl: `http://127.0.0.1:${aiPort}`, received, commands,
    deliver: (to, raw, folder = "INBOX") => { const t = box(to)[folder]; t.msgs.push({ uid: t.next++, raw }); },
    close: () => { smtp.close(); imap.close(); ai.close(); },
  };
}
