import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/app.js";

const H = { "x-agentenwerk": "1", "content-type": "application/json" };
const ai = { configured: true, provider: "mistral", model: "f", isApiError: () => false };

async function boot(mails) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentenwerk-sec-"));
  const server = http.createServer(createApp({ dataDir: dir, ai, mailer: { from: "a@b.de", dailyLimit: 5, async send(m) { mails.push(m); } } }));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://localhost:${server.address().port}`;
  const client = () => {
    const jar = new Map();
    return async (method, p, body) => {
      const r = await fetch(base + p, { method, headers: { ...H, cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") }, body: body === undefined ? undefined : JSON.stringify(body) });
      for (const c of r.headers.getSetCookie()) { const [kv] = c.split(";"); const i = kv.indexOf("="); const k = kv.slice(0, i), v = kv.slice(i + 1); if (v) jar.set(k, v); else jar.delete(k); }
      const t = await r.text(); let b = t; try { b = JSON.parse(t); } catch { /* none */ } return { status: r.status, body: b };
    };
  };
  return { client, close: async () => { server.close(); await fs.rm(dir, { recursive: true, force: true }); } };
}
const codeOf = (mails) => /Code: (\d{6})/.exec(mails.at(-1).text)[1];

test("two-factor login: enable, challenge, wrong and right code, trusted device, disable", async () => {
  const mails = [];
  const { client, close } = await boot(mails);
  try {
    const a = client();
    await a("POST", "/api/auth/setup", { name: "A", email: "a@x.de", password: "sehr-sicheres-pw" });
    const start = await a("POST", "/api/account/2fa/start", {});
    assert.equal(start.status, 200);
    assert.equal((await a("POST", "/api/account/2fa/confirm", { challenge: start.body.challenge, code: "000000" })).status, 401);
    assert.equal((await a("POST", "/api/account/2fa/confirm", { challenge: start.body.challenge, code: codeOf(mails) })).status, 200);
    assert.equal((await a("GET", "/api/auth/state")).body.user.twofaEnabled, true);

    const b = client();
    const login = await b("POST", "/api/auth/login", { email: "a@x.de", password: "sehr-sicheres-pw" });
    assert.equal(login.body.twofa, true);
    assert.equal(login.body.user, undefined, "no session before the code");
    assert.equal((await b("GET", "/api/agents")).status, 401);
    assert.equal(JSON.stringify(login.body).includes("a@x.de"), false, "address is masked");
    const good = codeOf(mails);
    assert.equal((await b("POST", "/api/auth/2fa", { challenge: login.body.challenge, code: good === "123456" ? "654321" : "123456" })).status, 401);
    const ok = await b("POST", "/api/auth/2fa", { challenge: login.body.challenge, code: good, trust: true });
    assert.equal(ok.status, 200);
    assert.equal((await b("GET", "/api/agents")).status, 200);
    assert.equal((await b("POST", "/api/auth/2fa", { challenge: login.body.challenge, code: good })).status, 400, "a code works once");

    await b("POST", "/api/auth/logout", {});
    const again = await b("POST", "/api/auth/login", { email: "a@x.de", password: "sehr-sicheres-pw" });
    assert.equal(again.body.twofa, undefined, "trusted device skips the code");
    const other = client();
    assert.equal((await other("POST", "/api/auth/login", { email: "a@x.de", password: "sehr-sicheres-pw" })).body.twofa, true, "a new device still needs one");

    // too many wrong codes burn the challenge
    const c = client();
    const ch = (await c("POST", "/api/auth/login", { email: "a@x.de", password: "sehr-sicheres-pw" })).body.challenge;
    for (let i = 0; i < 5; i++) await c("POST", "/api/auth/2fa", { challenge: ch, code: "111111" });
    assert.equal((await c("POST", "/api/auth/2fa", { challenge: ch, code: codeOf(mails) })).status, 429);

    assert.equal((await b("POST", "/api/account/2fa/disable", { password: "falsch" })).status, 401);
    assert.equal((await b("POST", "/api/account/2fa/disable", { password: "sehr-sicheres-pw" })).status, 200);
    assert.equal((await client()("POST", "/api/auth/login", { email: "a@x.de", password: "sehr-sicheres-pw" })).body.twofa, undefined);
  } finally { await close(); }
});

test("support access: grant, admin enters, limits and audit log, revoke", async () => {
  const mails = [];
  const { client, close } = await boot(mails);
  try {
    const admin = client();
    await admin("POST", "/api/auth/setup", { name: "Admin", email: "a@x.de", password: "sehr-sicheres-pw" });
    const made = await admin("POST", "/api/users", { name: "Abo", email: "abo@x.de", role: "abo" });
    const pw = made.body.password;
    const abo = client();
    await abo("POST", "/api/auth/login", { email: "abo@x.de", password: pw });
    const agent = (await abo("POST", "/api/agents", { name: "Aboagent" })).body;

    assert.equal((await admin("POST", "/api/support/start", { userId: made.body.user.id })).status, 403, "not granted yet");
    const grant = await abo("POST", "/api/account/support", { on: true });
    assert.ok(grant.body.until > Date.now() + 47 * 3_600_000);
    assert.equal((await admin("POST", "/api/support/start", { userId: made.body.user.id })).status, 200);

    const status = (await admin("GET", "/api/auth/state")).body.user;
    assert.equal(status.support.adminName, "Admin");
    const list = (await admin("GET", "/api/agents")).body;
    assert.deepEqual(list.map((x) => x.id), [agent.id], "the admin sees the customer's workspace");
    assert.equal((await admin("PUT", `/api/agents/${agent.id}`, { ...agent, name: "Repariert" })).status, 200, "can help");
    assert.equal((await admin("DELETE", `/api/agents/${agent.id}`)).status, 403, "cannot delete");
    assert.equal((await admin("POST", "/api/agents/bulk-delete", { ids: [agent.id] })).status, 403);
    for (const p of ["/api/account", "/api/users", "/api/system", "/api/billing/portal"]) assert.equal((await admin("POST", p, {})).status === 403 || (await admin("GET", p)).status === 403, true, p);

    const log = (await abo("GET", "/api/account/support")).body.log;
    assert.ok(log.some((l) => l.method === "PUT" && l.adminName === "Admin"), "the customer sees what was done");

    await abo("POST", "/api/account/support", { on: false });
    assert.equal((await admin("GET", "/api/agents")).body.length, 0, "access ends the moment it is revoked");
    assert.equal((await admin("GET", "/api/auth/state")).body.user.support, undefined);
  } finally { await close(); }
});

test("customers page: limit, copy of a demo, stats, remove", async () => {
  const mails = [];
  const { client, close } = await boot(mails);
  try {
    const a = client();
    await a("POST", "/api/auth/setup", { name: "A", email: "a@x.de", password: "sehr-sicheres-pw" });
    await a("PUT", "/api/system", { customerLimit: 2 });
    const demo = (await a("POST", "/api/agents", { name: "Demo Salon", company: "Salon" })).body;
    const k1 = await a("POST", "/api/customers", { name: "Kunde Eins", email: "k1@x.de", agentId: demo.id });
    assert.equal(k1.status, 201);
    assert.notEqual(k1.body.agentId, demo.id, "a copy is assigned, the demo stays");
    const kc = client();
    await kc("POST", "/api/auth/login", { email: "k1@x.de", password: k1.body.password });
    assert.deepEqual((await kc("GET", "/api/agents")).body.map((x) => x.id), [k1.body.agentId]);
    assert.equal((await kc("GET", "/api/customers")).status, 403);
    assert.equal((await a("POST", "/api/customers", { name: "Zwei", email: "k2@x.de", agentId: demo.id, copy: false })).status, 201);
    assert.equal((await a("POST", "/api/customers", { name: "Drei", email: "k3@x.de" })).status, 409, "limit reached");
    const view = (await a("GET", "/api/customers")).body;
    assert.equal(view.used, 2);
    assert.equal(view.limit, 2);
    assert.equal(view.customers.find((c) => c.email === "k1@x.de").agents.length, 1);
    assert.equal((await a("DELETE", `/api/customers/${view.customers[0].id}`)).status, 204);
    assert.equal((await a("GET", "/api/customers")).body.used, 1);
  } finally { await close(); }
});
