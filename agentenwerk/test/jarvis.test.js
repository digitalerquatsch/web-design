import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/app.js";
import { sanitizeSnapshot } from "../src/jarvis.js";

const H = { "x-agentenwerk": "1", "content-type": "application/json" };
const ai = { configured: true, provider: "mistral", keyName: "K", model: "fake", isApiError: () => false };

test("sanitizeSnapshot caps sizes and drops unknown fields", () => {
  const snap = sanitizeSnapshot({
    host: "mac", runs: Array.from({ length: 80 }, (_, i) => ({ id: i + 1, prompt: "x".repeat(900), status: "weird", secret: "no" })),
    sessions: [{ session_id: "s1", state: "needs_you", needs: "Freigabe" }, { state: "idle" }],
    limits: { measured: true, windows: [{ key: "five_hour", utilization: 0.5 }] },
  });
  assert.equal(snap.runs.length, 50);
  assert.equal(snap.runs[0].prompt.length, 300);
  assert.equal(snap.runs[0].status, "queued");
  assert.equal("secret" in snap.runs[0], false);
  assert.equal(snap.sessions.length, 1);
  assert.throws(() => sanitizeSnapshot(null));
});

test("JARVIS ingest needs the connection token; the page data is admin only", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentenwerk-jv-"));
  const server = http.createServer(createApp({ dataDir: dir, ai }));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://localhost:${server.address().port}`;
  let cookie = "";
  const call = async (method, p, body, headers = {}) => {
    const r = await fetch(base + p, { method, headers: { ...H, ...(cookie ? { cookie } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = r.headers.get("set-cookie"); if (set) cookie = set.split(";")[0];
    const t = await r.text(); return { status: r.status, body: t ? JSON.parse(t) : null };
  };
  await call("POST", "/api/auth/setup", { name: "Alex", email: "a@x.de", password: "sehr-sicheres-pw" });
  assert.equal((await call("POST", "/api/public/jarvis/ingest", { runs: [] })).status, 401, "no token configured yet");
  const t = await call("POST", "/api/jarvis/token", {});
  assert.equal(t.status, 201);
  assert.match(t.body.token, /^jv_/);
  assert.equal((await call("POST", "/api/public/jarvis/ingest", { runs: [] }, { authorization: "Bearer jv_falsch" })).status, 401);
  const auth = { authorization: `Bearer ${t.body.token}` };
  const ok = await call("POST", "/api/public/jarvis/ingest", { host: "mac", runs: [{ id: "r1", project_name: "jarvis", prompt: "baue", status: "running", created_at: Date.now() / 1000 }], sessions: [{ session_id: "s", state: "needs_you", needs: "ja/nein" }] }, auth);
  assert.equal(ok.status, 200);
  const view = (await call("GET", "/api/jarvis")).body;
  assert.equal(view.connected, true);
  assert.equal(view.snapshot.runs[0].project, "jarvis");
  assert.equal(view.stale, false);
  assert.equal(view.feed[0].kind, "run");
  assert.equal(JSON.stringify(view).includes(t.body.token), false, "token is never stored in the clear");
  await call("DELETE", "/api/jarvis/token");
  assert.equal((await call("POST", "/api/public/jarvis/ingest", { runs: [] }, auth)).status, 401);
  server.close(); await fs.rm(dir, { recursive: true, force: true });
});
