// What the receiving server said about DKIM on one of our emails. "pass" means signed with the
// domain's own key. Google signs with a default gappssmtp.com key until Start authentication is
// clicked in Google Admin, which shows up here as "unaligned". null when the headers say nothing.
export function dkimVerdict(raw, domain) {
  const lines = String(raw || "").replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/);
  const own = new RegExp(`(?:@|header\\.d=|\\bd=)${domain.toLowerCase().replace(/[.-]/g, "\\$&")}(?![\\w.-])`, "i");
  const results = lines.filter((l) => /^authentication-results:/i.test(l))
    .flatMap((l) => [...l.matchAll(/\bdkim=(\w+)([^;]*)/gi)].map((m) => ({ r: m[1].toLowerCase(), rest: m[2] })));
  if (results.length) {
    if (results.some((x) => x.r === "pass" && own.test(x.rest))) return "pass";
    return results.some((x) => x.r === "pass") ? "unaligned" : results[0].r;
  }
  return lines.some((l) => /^dkim-signature:/i.test(l) && own.test(l)) ? "signed" : null;
}
