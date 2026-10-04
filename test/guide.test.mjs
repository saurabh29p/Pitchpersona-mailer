// The panel guides instead of pretending: Start is refused with a reason until there are
// inboxes to warm up, Test login needs a password first, and the setup guide's facts
// (login results, DKIM signing seen on received mail) are reported by /api/state.
import { DatabaseSync } from "node:sqlite";
import { dkimVerdict } from "../src/dkim.mjs";
import { startEngine, client, checker } from "./helpers.mjs";

const { ok, done } = checker("guide");

// ── DKIM verdict from the headers the receiving server adds ──
const d = "getpitchpersona.com";
for (const [h, want, label] of [
  ["Authentication-Results: mx.google.com;\r\n       dkim=pass header.i=@getpitchpersona.com header.s=google;\r\n       spf=pass", "pass", "signed with the domain's own key"],
  ["Authentication-Results: mx.google.com;\r\n       dkim=pass header.i=@getpitchpersona-com.20230601.gappssmtp.com;\r\n       spf=pass", "unaligned", "Google's default key (Start authentication not clicked)"],
  ["Authentication-Results: mx.google.com; spf=pass smtp.mailfrom=x@getpitchpersona.com; dkim=none", "none", "no signature"],
  ["Authentication-Results: x; dkim=pass header.d=getpitchpersona.com.evil.io", "unaligned", "a lookalike domain doesn't count"],
  ["DKIM-Signature: v=1; a=rsa-sha256; d=getpitchpersona.com; s=google;", "signed", "own signature present, no verdict header"],
  ["Subject: hi", null, "nothing to go on"],
]) ok(dkimVerdict(h, d) === want, `DKIM verdict: ${label}`, `got ${dkimVerdict(h, d)}`);

// ── Start is refused, with the reason, until there's something to warm up (dry run) ──
const dry = await startEngine({ DRY_RUN: "1", PANEL_PASSWORD: "pw" });
try {
  const { api } = client(dry.url);
  await api("/api/login", "POST", { password: "pw" });
  let st = (await api("/api/state")).body;
  ok(/Add your inboxes/.test(st.readiness.startBlock), "with no inboxes, the state says what to do first", st.readiness.startBlock);
  let r = await api("/api/pause", "POST", { paused: false });
  ok(r.status === 400 && r.body.code === "not_ready" && /Add your inboxes/.test(r.body.error), "Start with no inboxes is refused with the reason", JSON.stringify(r.body));
  ok((await api("/api/state")).body.settings.paused === true, "...and the mailer stays paused");
  r = await api("/api/run-now", "POST", {});
  ok(r.status === 400 && /Start warm-up first/.test(r.body.error), "Run a cycle now while paused says to start first", JSON.stringify(r.body));

  const add = (b) => api("/api/inboxes", "POST", { provider: "google", password: "abcdefghijklmnop", ...b });
  const one = (await add({ email: "one@getpitchpersona.com", role: "sender" })).body.id;
  r = await api("/api/pause", "POST", { paused: false });
  ok(r.status === 400 && /one more inbox/.test(r.body.error), "one inbox alone is refused: nobody to write to", r.body.error);
  await api(`/api/inboxes/${one}`, "DELETE");
  await add({ email: "s1@gmail.com", role: "seed" }); await add({ email: "s2@outlook.com", role: "seed" });
  r = await api("/api/pause", "POST", { paused: false });
  ok(r.status === 400 && /sending inbox/.test(r.body.error), "seeds alone are refused: they only receive", r.body.error);
  await add({ email: "two@getpitchpersona.com", role: "sender" });
  // Added three days ago and never sent: its day 1 should be the day Start is pressed.
  // One with a hand-picked day 1 keeps it.
  const today = (await api("/api/state")).body.today, back = (n) => new Date(Date.parse(today + "T12:00:00Z") - n * 86400000).toISOString();
  const db = new DatabaseSync(dry.dbPath);
  db.prepare("UPDATE inboxes SET start_date = ?, created_at = ? WHERE email = 'two@getpitchpersona.com'").run(back(3).slice(0, 10), back(3));
  await add({ email: "hand@getpitchpersona.com", role: "sender", start_date: back(10).slice(0, 10) });
  st = (await api("/api/state")).body;
  ok(st.readiness.startBlock === null && st.readiness.readySenders === 2, "senders plus seeds are ready", JSON.stringify(st.readiness));
  ok((await api("/api/pause", "POST", { paused: false })).status === 200 && (await api("/api/state")).body.settings.paused === false, "then Start works");
  await api("/api/pause", "POST", { paused: true });
  const days = Object.fromEntries((await api("/api/state")).body.inboxes.map((i) => [i.email, i.day]));
  ok(days["two@getpitchpersona.com"] === 1, "an inbox added days before Start begins on day 1, not day 4", JSON.stringify(days));
  ok(days["hand@getpitchpersona.com"] === 11, "a hand-picked day 1 is kept", JSON.stringify(days));

  st = (await api("/api/state")).body;
  ok(st.inboxes.every((i) => i.login === null), "new inboxes show their login as not tested");
  ok(st.totals.sentEver >= 0 && st.totals.seenEver >= 0 && st.campaigns.count === 0 && st.campaigns.active === 0, "the guide gets totals and campaign counts", JSON.stringify(st.campaigns));
  ok(st.domains.length === 1 && "signing" in st.domains[0], "each sending domain reports its DKIM signing status", JSON.stringify(st.domains[0]).slice(0, 120));
  ok(st.settings.dkimConfirmed === false, "DKIM signing starts unconfirmed");
  await api("/api/settings", "PUT", { dkimConfirmed: true });
  ok((await api("/api/state")).body.settings.dkimConfirmed === true, "'I've clicked Start authentication' is remembered");
} finally { dry.stop(); }

// ── Real mode: a password is required before Test login or Start ──
const real = await startEngine({ PANEL_PASSWORD: "pw" });
try {
  const { api } = client(real.url);
  await api("/api/login", "POST", { password: "pw" });
  const add = (b) => api("/api/inboxes", "POST", { provider: "google", ...b });
  const x = (await add({ email: "x@guide-test.invalid", role: "sender" })).body.id;
  await add({ email: "y@guide-test.invalid", role: "sender" });
  const t = await api(`/api/inboxes/${x}/test`, "POST", {});
  ok(t.status === 400 && /Save an app password/.test(t.body.error), "Test login without a password says to save one first", JSON.stringify(t.body));
  const r = await api("/api/pause", "POST", { paused: false });
  ok(r.status === 400 && /app password/.test(r.body.error), "Start with no passwords saved is refused with the reason", JSON.stringify(r.body));
} finally { real.stop(); }

process.exit(done() ? 1 : 0);
