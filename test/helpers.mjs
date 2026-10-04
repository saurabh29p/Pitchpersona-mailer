// Shared test plumbing: start the engine on a free port with its own temporary data folder.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";

export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
});

// Pass an existing dataDir to restart on the same database.
export async function startEngine(env = {}, { dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mailer-test-")) } = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, ["--experimental-sqlite", "--no-warnings", "src/index.mjs"], {
    cwd: ROOT, env: { ...process.env, DATA_DIR: dataDir, PORT: String(port), ...env }, stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  const url = `http://127.0.0.1:${port}`;
  for (let k = 0; k < 100; k++) {
    try { if ((await fetch(url + "/health")).ok) break; } catch { /* not up yet */ }
    await sleep(100);
  }
  return {
    url, port, dataDir, child, dbPath: path.join(dataDir, "warmup.db"), log: () => log,
    stop: ({ keep = false } = {}) => { child.kill(); if (!keep) fs.rmSync(dataDir, { recursive: true, force: true }); },
    // Stops the process and waits for it to exit, keeping the data folder.
    exit: () => new Promise((resolve) => { if (child.exitCode !== null) return resolve(child.exitCode); child.once("exit", (code) => resolve(code)); child.kill(); }),
  };
}

// A signed-in API client for one engine.
export function client(url) {
  let cookie = "";
  const api = async (p, method = "GET", body, headers = {}) => {
    const r = await fetch(url + p, {
      method, redirect: "manual", body: body ? JSON.stringify(body) : undefined,
      headers: { cookie, ...(method !== "GET" ? { "content-type": "application/json" } : {}), ...headers },
    });
    const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
    if (p === "/api/login" && r.status === 200) cookie = r.headers.get("set-cookie").split(";")[0];
    return { status: r.status, body: j, headers: r.headers };
  };
  const waitIdle = async () => {
    for (let k = 0; k < 300; k++) { if (!(await api("/api/state")).body.scheduler.running) return; await sleep(100); }
    throw new Error("a cycle never finished");
  };
  const runNow = async () => { await waitIdle(); await api("/api/run-now", "POST", {}); await sleep(200); await waitIdle(); };
  return { api, waitIdle, runNow };
}

export function checker(name) {
  let fails = 0, passes = 0;
  const ok = (cond, label, extra = "") => {
    if (cond) passes++; else fails++;
    console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra && !cond ? "  " + extra : ""}`);
  };
  const done = () => { console.log(`\n${name}: ${passes} passed, ${fails} failed`); return fails; };
  return { ok, done };
}
