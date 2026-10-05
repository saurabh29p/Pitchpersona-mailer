// Runs every test file in this folder, one after another. `npm test`
import { spawnSync } from "node:child_process";
import { ROOT } from "./helpers.mjs";

const files = ["scanner.test.mjs", "deploy.test.mjs", "guide.test.mjs", "e2e.test.mjs", "live.test.mjs", "stability.test.mjs", "feedback.test.mjs"];
let failed = 0;
for (const f of files) {
  console.log(`\n── ${f}`);
  const r = spawnSync(process.execPath, ["--experimental-sqlite", "--no-warnings", `test/${f}`], { cwd: ROOT, stdio: "inherit", timeout: 300000 });
  if (r.status !== 0) failed++;
}
console.log(failed ? `\n${failed} test file(s) failed` : "\nAll test files passed");
process.exit(failed ? 1 : 0);
