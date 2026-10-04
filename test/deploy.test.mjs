// Deployment guards: a missing PANEL_PASSWORD and a missing Railway volume are reported plainly.
import { startEngine, client, checker } from "./helpers.mjs";

const { ok, done } = checker("deploy guards");
const noPw = await startEngine({ DRY_RUN: "1", PANEL_PASSWORD: "" });
try {
  const r = await client(noPw.url).api("/api/login", "POST", { password: "anything" });
  ok(r.status === 503 && /PANEL_PASSWORD/.test(r.body.error), "sign-in explains that PANEL_PASSWORD is missing", JSON.stringify(r.body));
} finally { noPw.stop(); }

const noVol = await startEngine({ DRY_RUN: "1", PANEL_PASSWORD: "pw", RAILWAY_ENVIRONMENT_NAME: "production", RAILWAY_VOLUME_MOUNT_PATH: "" });
try {
  const c = client(noVol.url); await c.api("/api/login", "POST", { password: "pw" });
  ok((await c.api("/api/state")).body.storage.persistent === false, "on Railway without a volume, the panel warns that data will be erased");
} finally { noVol.stop(); }

// A volume mounted at "/" contains whatever temporary data folder the test engine uses.
const vol = await startEngine({ DRY_RUN: "1", PANEL_PASSWORD: "pw", RAILWAY_ENVIRONMENT_NAME: "production", RAILWAY_VOLUME_MOUNT_PATH: "/" });
try {
  const c = client(vol.url); await c.api("/api/login", "POST", { password: "pw" });
  ok((await c.api("/api/state")).body.storage.persistent === true, "with the data folder on the volume, no warning");
} finally { vol.stop(); }

process.exit(done() ? 1 : 0);
