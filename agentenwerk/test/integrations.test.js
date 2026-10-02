import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/app.js";
import { sanitizeIntegrations, maskIntegrations, deliver, dispatch, IntegrationError } from "../src/integrations.js";

const pub = async () => [{ address: "93.184.216.34" }];
const H = { "x-agentenwerk": "1", "content-type": "application/json" };

test("sanitize validates, keeps stored secrets on empty input, masks output", () => {
  const stored = [{ id: "int-abc1", type: "webhook", enabled: true, events: ["lead"], url: "https://hooks.example.com/abc1234", secret: "s3cret", to: "", chatId: "", token: "" }];
  const [i] = sanitizeIntegrations([{ id: "int-abc1", type: "webhook", url: "", events: ["termin", "x"] }], stored);
  assert.equal(i.url, "https://hooks.example.com/abc1234");
  assert.deepEqual(i.events, ["termin"]);
  const m = maskIntegrations([i])[0];
  assert.equal(m.url, "");
  assert.equal(m.has.url, true);
  assert.equal(m.hint.url, "…1234");
  assert.equal(JSON.stringify(m).includes("s3cret"), false);
  assert.throws(() => sanitizeIntegrations([{ type: "webhook", url: "http://x.de/h" }]), IntegrationError);
  assert.throws(() => sanitizeIntegrations([{ type: "slack", url: "https://evil.example.com/x" }]), /Slack/);
  assert.throws(() => sanitizeIntegrations([{ type: "email", to: "kaputt" }]), IntegrationError);
  assert.equal(sanitizeIntegrations([{ type: "ftp" }]).length, 0);
});

test("deliver: signed webhook, telegram, internal hosts refused, redirects not followed", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, ...init }); return new Response("ok"); };
  const event = { type: "lead", agentId: "a", agentName: "Ida", data: { name: "Eva" } };
  await deliver({ type: "webhook", url: "https://hooks.example.com/x", secret: "k" }, event, { fetchImpl, lookup: pub });
  assert.match(calls[0].headers["x-agentenwerk-signature"], /^sha256=[0-9a-f]{64}$/);
  assert.equal(JSON.parse(calls[0].body).data.name, "Eva");
  assert.equal(calls[0].redirect, "manual");
  await deliver({ type: "telegram", token: "1:AB", chatId: "42" }, event, { fetchImpl, lookup: pub });
  assert.equal(calls[1].url, "https://api.telegram.org/bot1:AB/sendMessage");
  await assert.rejects(deliver({ type: "webhook", url: "https://intern.example.com/x" }, event, { fetchImpl, lookup: async () => [{ address: "10.0.0.5" }] }), IntegrationError);
  await assert.rejects(deliver({ type: "webhook", url: "https://hooks.example.com/x" }, event, { fetchImpl: async () => new Response("", { status: 302 }), lookup: pub }), /302/);
  const mails = [];
  await deliver({ type: "email", to: "a@b.de" }, event, { mailer: { send: async (m) => mails.push(m) } });
  assert.match(mails[0].subject, /Neuer Kontakt/);
});

test("dispatch skips paused and unready integrations and never throws", async () => {
  const agent = { id: "a", name: "Ida", integrations: [
    { id: "1", type: "email", to: "a@b.de", enabled: true, events: ["lead"] },
    { id: "2", type: "email", to: "a@b.de", enabled: false, events: ["lead"] },
    { id: "3", type: "slack", url: "", enabled: true, events: ["lead"] },
    { id: "4", type: "email", to: "a@b.de", enabled: true, events: ["termin"] },
  ] };
  const sent = [];
  const r = await dispatch(agent, { type: "lead", data: {} }, { mailer: { send: async () => { sent.push(1); } } });
  assert.deepEqual(r, [{ id: "1", ok: true }]);
  const bad = await dispatch(agent, { type: "lead", data: {} }, { mailer: { send: async () => { throw new Error("smtp down"); } } });
  assert.equal(bad[0].ok, false);
});

test("API never returns secrets and keeps them across saves; agents of others stay private", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentenwerk-int-"));
  const server = http.createServer(createApp({ dataDir: dir, ai: { configured: true, provider: "mistral", model: "f", isApiError: () => false }, mailer: { from: "a@b.de", dailyLimit: 5, async send() {} } }));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://localhost:${server.address().port}`;
  let cookie = "";
  const call = async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: { ...H, ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = r.headers.get("set-cookie"); if (set) cookie = set.split(";")[0];
    const t = await r.text(); return { status: r.status, body: t ? JSON.parse(t) : null };
  };
  await call("POST", "/api/auth/setup", { name: "A", email: "a@x.de", password: "sehr-sicheres-pw" });
  const made = await call("POST", "/api/agents", { name: "Bot", integrations: [{ id: "int-test1", type: "webhook", url: "https://hooks.example.com/geheim9999", secret: "topsecret" }] });
  assert.equal(made.status, 201);
  assert.equal(JSON.stringify(made.body).includes("geheim9999"), false);
  assert.equal(made.body.integrations[0].has.url, true);
  const again = await call("PUT", `/api/agents/${made.body.id}`, { ...made.body, name: "Bot 2" });
  assert.equal(again.body.integrations[0].has.url, true, "empty secret in the request keeps the stored one");
  assert.equal(JSON.stringify((await call("GET", "/api/agents")).body).includes("topsecret"), false);
  assert.equal((await call("POST", "/api/agents", { name: "X", integrations: [{ type: "webhook", url: "http://nope" }] })).status, 400);
  const mail = await call("PUT", `/api/agents/${made.body.id}`, { ...again.body, integrations: [{ id: "int-mail1", type: "email", to: "me@x.de" }] });
  assert.equal(mail.status, 200);
  assert.equal((await call("POST", `/api/agents/${made.body.id}/integrations/int-mail1/test`, {})).status, 200);
  assert.equal((await call("POST", `/api/agents/${made.body.id}/integrations/nope/test`, {})).status, 404);
  server.close(); await fs.rm(dir, { recursive: true, force: true });
});
