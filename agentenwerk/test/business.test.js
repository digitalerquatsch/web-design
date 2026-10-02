import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/app.js";
import { toAgentPatch } from "../src/analyze.js";
import { twilioSignature } from "../src/voice.js";
import { formEncode, verifyWebhook } from "../src/billing.js";
import { applySystemUpdate, maskedSystem } from "../src/system.js";

const H = { "x-agentenwerk": "1", "content-type": "application/json" };
const draft = { company: "Firma", industry: "Handwerk", name: "Ida", initials: "FI", role: "r", address: "sie", tone: ["freundlich"], language: "de", knowledge: "k", hours: "", services: "", goal: "leads", goalReason: "", leadFields: ["name", "phone"], bookingRules: "", handoff: "", faqs: [], quickReplies: [], welcome: "Hallo", dos: "", donts: "", color: "#225588", missing: [] };
const site = (url) => ({ url, pages: [{ url, title: "S", text: "x".repeat(400) }], failed: [], meta: { themeColor: "", privacyUrl: "", emails: [], phones: [], jsonLd: "[]", headings: [] } });

let dir, server, base, port;
const stripeCalls = [];
const ai = {
  configured: true, provider: "mistral", keyName: "MISTRAL_API_KEY", model: "fake", isApiError: () => false,
  async parse() { return { subject: "s", body: "b {{DEMO_LINK}}" }; },
  stream({ system }) {
    let cb = () => {};
    const phone = system.some((b) => /Telefongespräch/.test(b.text));
    const msg = phone && !this.toolDone
      ? (this.toolDone = true, { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "save_lead", input: { name: "Eva" } }] })
      : { stop_reason: "end_turn", content: [{ type: "text", text: phone ? "Gern, **Eva**. Wir rufen Sie an: https://x.de" : "Hallo zurück" }] };
    return { on(e, f) { if (e === "text") cb = f; return this; }, async finalMessage() { for (const b of msg.content) if (b.type === "text") cb(b.text); return msg; } };
  },
};
async function stripeFetch(url, init) {
  stripeCalls.push({ url, body: init.body });
  if (url.endsWith("/checkout/sessions")) return new Response(JSON.stringify({ id: "cs_1", url: "https://checkout.stripe.com/c/cs_1" }));
  if (url.includes("/subscriptions/")) return new Response(JSON.stringify({ id: "sub_1", status: "active", cancel_at_period_end: init.body.includes("cancel_at_period_end=true"), current_period_end: 1893456000 }));
  if (url.endsWith("/billing_portal/sessions")) return new Response(JSON.stringify({ url: "https://billing.stripe.com/p/1" }));
  return new Response("{}", { status: 404 });
}

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentenwerk-biz-"));
  server = http.createServer(createApp({ dataDir: dir, ai, stripeFetch, crawl: async (u) => site(u), analyze: async (s) => toAgentPatch(draft, s), mailer: { from: "a@b.de", dailyLimit: 5, async send() {} } }));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  port = server.address().port;
  base = `http://localhost:${port}`;
});
after(async () => { server.close(); await fs.rm(dir, { recursive: true, force: true }); });

function client() {
  let cookie = "";
  return async (method, p, body, extra = {}) => {
    const r = await fetch(base + p, { method, headers: { ...H, ...(cookie ? { cookie } : {}), ...extra }, body: body === undefined ? undefined : (typeof body === "string" ? body : JSON.stringify(body)) });
    const set = r.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    const text = await r.text();
    let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: r.status, body: json };
  };
}
const admin = client();
const sign = (payload, secret) => { const t = Math.floor(Date.now() / 1000); return `t=${t},v1=${crypto.createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex")}`; };

test("helpers: stripe form encoding, webhook verification, system masking", () => {
  assert.equal(formEncode({ a: 1, b: { c: [{ d: "x" }] } }).toString(), "a=1&b%5Bc%5D%5B0%5D%5Bd%5D=x");
  const body = JSON.stringify({ type: "x" });
  assert.equal(verifyWebhook(body, sign(body, "whsec"), "whsec").type, "x");
  assert.throws(() => verifyWebhook(body, sign(body, "falsch"), "whsec"), /Signatur/);
  assert.throws(() => verifyWebhook(body, "t=1,v1=abc", "whsec"), /zu alt/);
  const next = applySystemUpdate({ smtpPass: "alt" }, { smtpPass: "", mistralApiKey: "sk-neu-1234", instagram: "https://instagram.com/alex.ai/", planSeats: "5" });
  assert.equal(next.smtpPass, "alt", "empty secret keeps the stored one");
  assert.equal(next.instagram, "alex.ai");
  assert.equal(next.planSeats, 5);
  assert.equal(applySystemUpdate({ smtpPass: "alt" }, { smtpPass: null }).smtpPass, "");
  assert.throws(() => applySystemUpdate({}, { publicUrl: "bots.de" }), /http/);
  const m = maskedSystem({ ...next, stripeSecretKey: "" });
  assert.deepEqual(m.mistralApiKey, { set: true, hint: "…1234" });
  assert.equal(JSON.stringify(m).includes("sk-neu"), false);
});

test("system settings live in the browser, admin only, and rebuild services", async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), "agentenwerk-sys-"));
  const built = [];
  const s = http.createServer(createApp({ dataDir: d, ai, factories: { ai: (sys) => { built.push(sys.mistralApiKey); return { ...ai, configured: Boolean(sys.mistralApiKey) }; }, mailer: async (sys) => (sys.smtpHost ? { from: sys.smtpFrom, dailyLimit: sys.dailyLimit, send: async () => {} } : null) } }));
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const u = `http://localhost:${s.address().port}`;
  const get = async () => (await fetch(`${u}/api/system`, { headers: H })).json();
  assert.equal((await get()).ai, false);
  const put = await (await fetch(`${u}/api/system`, { method: "PUT", headers: H, body: JSON.stringify({ mistralApiKey: "mk-geheim-9876", smtpHost: "smtp.x.de", smtpFrom: "a@x.de", publicUrl: "https://bots.x.de" }) })).json();
  assert.equal(put.ai, true);
  assert.equal(put.mail, true);
  assert.equal(put.system.mistralApiKey.hint, "…9876");
  assert.equal(JSON.stringify(put).includes("mk-geheim"), false, "secret never goes back to the browser");
  assert.equal(built.at(-1), "mk-geheim-9876");
  assert.equal((await (await fetch(`${u}/api/status`, { headers: H })).json()).publicUrl, "https://bots.x.de");
  s.close();
  await fs.rm(d, { recursive: true, force: true });
});

test("workspaces, mentoring lock and quotas", async () => {
  await admin("POST", "/api/auth/setup", { name: "Alex Admin", email: "alex@agentur.de", password: "sehr-sicheres-pw" });
  await admin("PUT", "/api/system", { planMonthlyAnalyses: 2, planMonthlyChats: 2, instagram: "alex.ai" });
  const mainAgent = (await admin("POST", "/api/agents", { name: "Haus-Bot" })).body;

  const a = await admin("POST", "/api/users", { name: "Anna Abo", email: "anna@abo.de", role: "abo" });
  const b = await admin("POST", "/api/users", { name: "Ben Abo", email: "ben@abo.de", role: "abo" });
  const anna = client(), ben = client();
  await anna("POST", "/api/auth/login", { email: "anna@abo.de", password: a.body.password });
  await ben("POST", "/api/auth/login", { email: "ben@abo.de", password: b.body.password });

  const annaAgent = (await anna("POST", "/api/agents", { name: "Annas Bot", ownerId: "main" })).body;
  assert.equal(annaAgent.ownerId, a.body.user.id, "owner comes from the session, not the client");
  assert.deepEqual((await anna("GET", "/api/agents")).body.map((x) => x.name), ["Annas Bot"]);
  assert.equal((await admin("GET", "/api/agents")).body.some((x) => x.id === annaAgent.id), false, "admin's own workspace stays separate");
  assert.equal((await ben("GET", `/api/agents/${annaAgent.id}`)).status, 404);
  assert.equal((await ben("PUT", `/api/agents/${annaAgent.id}`, { name: "x" })).status, 404);
  assert.equal((await anna("GET", `/api/agents/${mainAgent.id}`)).status, 404);
  const moved = await anna("PUT", `/api/agents/${annaAgent.id}`, { ...annaAgent, ownerId: "main" });
  assert.equal(moved.body.ownerId, a.body.user.id, "cannot move an agent out of the workspace");

  // Locked until unlocked by an admin.
  const st = (await anna("GET", "/api/status")).body;
  assert.equal(st.me.autopilotAllowed, false);
  assert.equal(st.mentoring.url, "https://ig.me/m/alex.ai");
  const locked = await anna("POST", "/api/batches?filename=l.csv", "Website\nanna-kunde.de\n", { "content-type": "text/csv" });
  assert.equal(locked.status, 403);
  assert.match(locked.body.error, /Mentoring/);
  assert.equal((await anna("GET", "/api/leads")).status, 403);
  await admin("PATCH", `/api/users/${a.body.user.id}`, { autopilotUnlocked: true });
  const up = await anna("POST", "/api/batches?filename=l.csv", "Website\nanna-kunde.de\n", { "content-type": "text/csv" });
  assert.equal(up.status, 201);
  let leads;
  for (let i = 0; i < 100; i++) { leads = (await anna("GET", "/api/leads")).body; if (leads.length) break; await new Promise((r) => setTimeout(r, 20)); }
  assert.equal(leads[0].ownerId, a.body.user.id);
  assert.equal((await admin("GET", "/api/leads")).body.length, 0, "admin does not see Anna's leads");
  await admin("PATCH", `/api/users/${b.body.user.id}`, { autopilotUnlocked: true });
  assert.equal((await ben("GET", "/api/leads")).body.length, 0);
  assert.equal((await ben("GET", `/api/leads/${leads[0].id}`)).status, 404);
  assert.equal((await ben("GET", `/api/batches/${up.body.id}`)).status, 404);
  const bulk = await ben("POST", "/api/leads/bulk", { action: "stage", stage: "kunde", ids: [leads[0].id] });
  assert.equal(bulk.body.updated, 0, "foreign ids are ignored");

  // Per-workspace sender settings.
  await anna("PUT", "/api/settings", { sender: { name: "Anna", company: "Annas Agentur" } });
  assert.equal((await admin("GET", "/api/settings")).body.sender.company, "");
  const pv = await (await fetch(`${base}/api/public/agents/${leads[0].agentId}/preview?intern=1`)).json();
  assert.equal(pv.agency.name, "Annas Agentur", "demo page shows the subscriber's agency");

  // Quotas: the autopilot row used 1 of 2 analyses.
  const usage = (await anna("GET", "/api/account")).body.usage;
  assert.deepEqual([usage.analyses, usage.limits.analyses], [1, 2]);
  const chatOnce = () => fetch(`${base}/api/public/agents/${annaAgent.id}/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "Hi" }) });
  assert.equal((await chatOnce()).status, 200);
  assert.equal((await chatOnce()).status, 200);
  const third = await chatOnce();
  assert.equal(third.status, 429);
  assert.match((await third.json()).error, /kontingent/i);
  // The admin's workspace has no limit.
  for (let i = 0; i < 3; i++) assert.equal((await fetch(`${base}/api/public/agents/${mainAgent.id}/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "Hi" }) })).status, 200);
});

test("paid self-signup: 5 seats, checkout, webhook, cancel, waitlist", async () => {
  await admin("PUT", "/api/system", { stripeSecretKey: "sk_test_x", stripeWebhookSecret: "whsec_test", planSeats: 1, planPrice: 30, termsUrl: "https://agentur.de/agb" });
  const state = await (await fetch(`${base}/api/auth/state`, { headers: H })).json();
  assert.equal(state.plan.enabled, true);
  assert.equal(state.plan.seatsLeft, 1);

  const carl = client();
  assert.equal((await carl("POST", "/api/auth/register", { name: "Carl", email: "carl@x.de", password: "carls-passwort" })).status, 400, "terms must be accepted");
  const reg = await carl("POST", "/api/auth/register", { name: "Carl", email: "carl@x.de", password: "carls-passwort", acceptTerms: true });
  assert.equal(reg.status, 201);
  assert.equal(reg.body.checkoutUrl, "https://checkout.stripe.com/c/cs_1");
  const co = stripeCalls.find((c) => c.url.endsWith("/checkout/sessions"));
  assert.match(co.body, /mode=subscription/);
  assert.match(co.body, /unit_amount%5D=3000/);
  assert.match(co.body, /interval%5D=month/);

  // Logged in, but until paid only status and account work.
  assert.equal((await carl("GET", "/api/agents")).status, 402);
  const st = (await carl("GET", "/api/status")).body;
  assert.equal(st.billing.status, "checkout");

  const carlId = st.me.id;
  const evt = JSON.stringify({ type: "checkout.session.completed", data: { object: { client_reference_id: carlId, customer: "cus_1", subscription: "sub_1" } } });
  assert.equal((await fetch(`${base}/api/public/stripe/webhook`, { method: "POST", headers: { "stripe-signature": sign(evt, "falsch") }, body: evt })).status, 400);
  assert.equal((await fetch(`${base}/api/public/stripe/webhook`, { method: "POST", headers: { "stripe-signature": sign(evt, "whsec_test") }, body: evt })).status, 200);
  assert.equal((await carl("GET", "/api/agents")).status, 200, "paid: full access");
  assert.equal((await carl("GET", "/api/status")).body.me.autopilotAllowed, false, "autopilot still needs the mentoring");

  // The only seat is taken: next signup goes to the waitlist.
  assert.equal((await fetch(`${base}/api/public/plan`).then((r) => r.json())).seatsLeft, 0);
  const full = await client()("POST", "/api/auth/register", { name: "Dora", email: "dora@x.de", password: "doras-passwort", acceptTerms: true });
  assert.equal(full.status, 409);
  assert.equal((await fetch(`${base}/api/public/waitlist`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Dora", email: "dora@x.de" }) })).status, 201);
  assert.equal((await admin("GET", "/api/users")).body.waitlist[0].email, "dora@x.de");

  // Cancel at period end, resume, portal.
  const cancel = await carl("POST", "/api/billing/cancel");
  assert.equal(cancel.body.billing.cancelAtPeriodEnd, true);
  assert.ok(stripeCalls.some((c) => c.url.endsWith("/subscriptions/sub_1") && c.body.includes("cancel_at_period_end=true")));
  assert.equal((await carl("POST", "/api/billing/resume")).body.billing.cancelAtPeriodEnd, false);
  assert.equal((await carl("POST", "/api/billing/portal")).body.url, "https://billing.stripe.com/p/1");

  // Subscription ends: access stops, the seat frees up.
  const del = JSON.stringify({ type: "customer.subscription.deleted", data: { object: { id: "sub_1", customer: "cus_1", status: "canceled" } } });
  await fetch(`${base}/api/public/stripe/webhook`, { method: "POST", headers: { "stripe-signature": sign(del, "whsec_test") }, body: del });
  assert.equal((await carl("GET", "/api/agents")).status, 402);
  assert.equal((await fetch(`${base}/api/public/plan`).then((r) => r.json())).seatsLeft, 1);
});

test("phone bot: signed Twilio webhooks, AI disclosure, speech turn with lead capture", async () => {
  await admin("PUT", "/api/system", { twilioAccountSid: "AC1", twilioAuthToken: "tw-token", publicUrl: base });
  const agent = (await admin("POST", "/api/agents", { name: "Ida", company: "Fahrschule Nord", phoneEnabled: true, welcome: "Wie kann ich helfen?", goal: "leads", leadFields: ["name", "phone"] })).body;
  const call = async (p, params, token = "tw-token") => {
    const body = new URLSearchParams(params).toString();
    const sig = twilioSignature(token, base + p, params);
    const r = await fetch(base + p, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": sig }, body });
    return { status: r.status, text: await r.text() };
  };
  const p = `/api/public/voice/${agent.id}`;
  assert.equal((await call(p, { CallSid: "CA1", From: "+4917012345" }, "falscher-token")).status, 403);
  const first = await call(p, { CallSid: "CA1", From: "+4917012345" });
  assert.equal(first.status, 200);
  assert.match(first.text, /<Gather input="speech" language="de-DE"/);
  assert.match(first.text, /Sie sprechen mit dem KI-Assistenten von Fahrschule Nord\. Wie kann ich helfen\?/);
  assert.match(first.text, new RegExp(`action="${base}/api/public/voice/${agent.id}/turn"`));

  const turn = await call(`${p}/turn`, { CallSid: "CA1", From: "+4917012345", SpeechResult: "Ich heiße Eva und möchte einen Rückruf." });
  assert.match(turn.text, /<Say language="de-DE" voice="Polly.Vicki-Neural">Gern, Eva\. Wir rufen Sie an: auf unserer Website<\/Say>/, "markdown and links removed for speech");
  const captured = (await admin("GET", `/api/agents/${agent.id}/captured`)).body;
  assert.equal(captured[0].data.phone, "+4917012345", "caller's number is attached");
  assert.equal(captured[0].channel, "telefon");
  const convs = (await admin("GET", `/api/agents/${agent.id}/conversations`)).body;
  assert.equal(convs[0].channel, "telefon");

  const silent1 = await call(`${p}/turn`, { CallSid: "CA1", SpeechResult: "" });
  assert.match(silent1.text, /nicht verstanden/);
  const silent2 = await call(`${p}/turn`, { CallSid: "CA1", SpeechResult: "" });
  assert.match(silent2.text, /<Hangup\/>/);

  const off = (await admin("POST", "/api/agents", { name: "Aus" })).body;
  assert.match((await call(`/api/public/voice/${off.id}`, { CallSid: "CA2" })).text, /nicht erreichbar.*<Hangup\/>/);
});
