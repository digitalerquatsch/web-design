import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/app.js";
import { hashPassword, verifyPassword, allowed } from "../src/users.js";

let dir, server, base, port;
const H = { "x-agentenwerk": "1", "content-type": "application/json" };

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentenwerk-users-"));
  server = http.createServer(createApp({ dataDir: dir, ai: { configured: false, keyName: "MISTRAL_API_KEY" } }));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  port = server.address().port;
  base = `http://localhost:${port}`;
});
after(async () => { server.close(); await fs.rm(dir, { recursive: true, force: true }); });

// A tiny cookie-keeping client.
function client(host = base) {
  let cookie = "";
  return async (method, p, body) => {
    const r = await fetch(host + p, { method, headers: { ...H, ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = r.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0].endsWith("=") ? "" : set.split(";")[0];
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : null, setCookie: set };
  };
}
// Requests that look like they come from the internet, not localhost.
function remote(method, p, headers = {}, body) {
  return new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port, path: p, method, headers: { ...H, host: "bots.example.de", ...headers } }, (res) => {
      let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => resolve({ status: res.statusCode, body: d ? JSON.parse(d) : null }));
    });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

test("password hashing", () => {
  const h = hashPassword("ein-gutes-passwort");
  assert.match(h, /^scrypt\$/);
  assert.equal(verifyPassword("ein-gutes-passwort", h), true);
  assert.equal(verifyPassword("falsch-falsch", h), false);
  assert.equal(verifyPassword("x", "kaputt"), false);
});

test("role permissions", () => {
  const kunde = { role: "kunde" }, team = { role: "team" };
  assert.equal(allowed(team, "GET", "/api/users"), false);
  assert.equal(allowed(team, "POST", "/api/batches"), true);
  assert.equal(allowed(kunde, "GET", "/api/leads"), false);
  assert.equal(allowed(kunde, "POST", "/api/agents"), false);
  assert.equal(allowed(kunde, "PUT", "/api/agents/abc"), true);
  assert.equal(allowed(kunde, "DELETE", "/api/agents/abc"), false);
  assert.equal(allowed(kunde, "POST", "/api/analyze"), false);
});

test("first admin, approval, roles, customers, last-admin guard", async () => {
  // Before any account: setup from the internet needs the token, from localhost it works.
  const st0 = await (await fetch(`${base}/api/auth/state`, { headers: H })).json();
  assert.equal(st0.setupNeeded, true);
  assert.equal((await remote("POST", "/api/auth/setup", {}, { name: "Böse", email: "x@y.de", password: "1234567890" })).status, 403);
  assert.equal((await remote("GET", "/api/agents")).status, 403);

  const admin = client();
  const setup = await admin("POST", "/api/auth/setup", { name: "Anna Admin", email: "Anna@Agentur.de", password: "sehr-sicheres-pw" });
  assert.equal(setup.status, 201);
  assert.match(setup.setCookie, /aw_session=.+; Path=\/; HttpOnly; SameSite=Lax/);
  assert.equal(setup.body.user.passwordHash, undefined);
  assert.equal((await admin("POST", "/api/auth/setup", { name: "Zwei", email: "b@b.de", password: "sehr-sicheres-pw" })).status, 409);

  // Now the API needs a session, also from localhost.
  assert.equal((await fetch(`${base}/api/agents`, { headers: H })).status, 401);
  const me = (await admin("GET", "/api/status")).body.me;
  assert.equal(me.role, "admin");
  assert.equal(me.email, "anna@agentur.de");

  // Someone requests access; they cannot log in until approved.
  const reg = await fetch(`${base}/api/auth/register`, { method: "POST", headers: H, body: JSON.stringify({ name: "Tom Team", email: "tom@agentur.de", password: "toms-passwort-1", note: "Vertrieb" }) });
  assert.equal(reg.status, 201);
  const tom = client();
  const early = await tom("POST", "/api/auth/login", { email: "tom@agentur.de", password: "toms-passwort-1" });
  assert.equal(early.status, 403);
  assert.match(early.body.error, /Freischaltung/);
  assert.equal((await admin("GET", "/api/status")).body.pendingUsers, 1);

  const list = (await admin("GET", "/api/users")).body;
  const tomRow = list.users.find((u) => u.email === "tom@agentur.de");
  assert.equal(tomRow.status, "pending");
  assert.equal(tomRow.passwordHash, undefined);
  const approved = await admin("PATCH", `/api/users/${tomRow.id}`, { status: "active", role: "team" });
  assert.equal(approved.body.user.approvedBy, "Anna Admin");
  assert.equal((await tom("POST", "/api/auth/login", { email: "tom@agentur.de", password: "falsch-falsch" })).status, 401);
  assert.equal((await tom("POST", "/api/auth/login", { email: "TOM@agentur.de", password: "toms-passwort-1" })).status, 200);
  assert.equal((await tom("GET", "/api/batches")).status, 200, "team may use the autopilot");
  assert.equal((await tom("GET", "/api/users")).status, 403, "team may not manage users");

  // Invite a customer and give them one of two agents.
  const a1 = (await admin("POST", "/api/agents", { name: "Bot Eins" })).body;
  const a2 = (await admin("POST", "/api/agents", { name: "Bot Zwei" })).body;
  const inv = await admin("POST", "/api/users", { name: "Karl Kunde", email: "karl@kunde.de", role: "kunde" });
  assert.equal(inv.status, 201);
  assert.match(inv.body.password, /^[\w]{7}-[\w]{7}$/);
  await admin("PATCH", `/api/users/${inv.body.user.id}`, { agentIds: [a1.id, "gibt-es-nicht"] });
  const karl = client();
  assert.equal((await karl("POST", "/api/auth/login", { email: "karl@kunde.de", password: inv.body.password })).status, 200);
  const karlAgents = (await karl("GET", "/api/agents")).body;
  assert.deepEqual(karlAgents.map((a) => a.id), [a1.id]);
  assert.equal((await karl("GET", `/api/agents/${a2.id}`)).status, 404);
  const ov = (await karl("GET", "/api/overview")).body;
  assert.equal(ov.agents, 1, "start page counts only the customer's agents");
  assert.equal(ov.leads, undefined, "customers see no acquisition numbers");
  assert.equal(ov.recentAgents[0].id, a1.id);
  const adminOv = (await admin("GET", "/api/overview")).body;
  assert.equal(adminOv.agents, 2);
  assert.equal(adminOv.leads.total, 0);
  assert.equal(typeof adminOv.pendingUsers, "number");
  assert.equal((await karl("PUT", `/api/agents/${a1.id}`, { ...a1, name: "Mein Bot" })).body.name, "Mein Bot");
  assert.equal((await karl("DELETE", `/api/agents/${a1.id}`)).status, 403);
  assert.equal((await karl("GET", "/api/leads")).status, 403);
  assert.equal((await karl("POST", "/api/test-chat", { agent: { id: a2.id }, message: "hi" })).status, 403);

  // Block: sessions end immediately.
  await admin("PATCH", `/api/users/${inv.body.user.id}`, { status: "blocked" });
  assert.equal((await karl("GET", "/api/agents")).status, 401);
  assert.equal((await karl("POST", "/api/auth/login", { email: "karl@kunde.de", password: inv.body.password })).status, 403);

  // Password reset gives a new one-time password and ends old sessions.
  const reset = await admin("POST", `/api/users/${tomRow.id}/reset-password`);
  assert.equal((await tom("GET", "/api/batches")).status, 401);
  assert.equal((await tom("POST", "/api/auth/login", { email: "tom@agentur.de", password: reset.body.password })).status, 200);
  assert.equal((await tom("POST", "/api/auth/password", { current: reset.body.password, next: "neues-passwort-1" })).status, 200);
  assert.equal((await tom("GET", "/api/status")).status, 200, "still logged in after own change");

  // Never zero admins.
  const annaId = me.id;
  assert.match((await admin("PATCH", `/api/users/${annaId}`, { role: "team" })).body.error, /mindestens ein aktiver Admin/);
  assert.match((await admin("DELETE", `/api/users/${annaId}`)).body.error, /selbst/);
  await admin("PATCH", `/api/users/${tomRow.id}`, { role: "admin" });
  assert.equal((await admin("PATCH", `/api/users/${annaId}`, { role: "team" })).status, 200, "fine once another admin exists");

  // Closing registration.
  await tom("PUT", "/api/auth/config", { signupOpen: false });
  assert.equal((await fetch(`${base}/api/auth/state`, { headers: H }).then((r) => r.json())).signupOpen, false);
  assert.equal((await fetch(`${base}/api/auth/register`, { method: "POST", headers: H, body: JSON.stringify({ name: "N", email: "n@n.de", password: "1234567890" }) })).status, 403);

  // Logout clears the session.
  const out = await tom("POST", "/api/auth/logout");
  assert.match(out.setCookie, /Max-Age=0/);
  assert.equal((await tom("GET", "/api/status")).status, 401);
});

test("login is rate limited", async () => {
  const c = client();
  let last;
  for (let i = 0; i < 12; i++) last = await c("POST", "/api/auth/login", { email: "wer@auch.de", password: "falsch-falsch" });
  assert.equal(last.status, 429);
});

test("ADMIN_TOKEN still works as a master key", async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), "agentenwerk-tok-"));
  const s = http.createServer(createApp({ dataDir: d, ai: { configured: false }, adminToken: "geheim-token" }));
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const u = `http://127.0.0.1:${s.address().port}`;
  assert.equal((await fetch(`${u}/api/agents`, { headers: H })).status, 401);
  const ok = await fetch(`${u}/api/status`, { headers: { ...H, authorization: "Bearer geheim-token" } });
  assert.equal((await ok.json()).me.role, "admin");
  s.close();
  await fs.rm(d, { recursive: true, force: true });
});
