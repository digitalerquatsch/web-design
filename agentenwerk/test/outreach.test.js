import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/app.js";
import { toAgentPatch } from "../src/analyze.js";
import { composeEmail, followUpDue, summarizeLeads } from "../src/outreach.js";

const draft = (host) => ({
  company: `Firma ${host}`, industry: "Zahnarzt", name: "Ida", initials: "ZA", role: "r", address: "sie", tone: ["freundlich"], language: "de",
  knowledge: "Praxis", hours: "", services: "Prophylaxe – 89 €", goal: "booking", goalReason: "", leadFields: ["name"], bookingRules: "", handoff: "",
  faqs: [], quickReplies: ["Termin"], welcome: "Hallo", dos: "", donts: "", color: "#225588", missing: [],
});
const site = (url) => ({ url, pages: [{ url, title: "S", text: "x".repeat(300) }], failed: [], meta: { themeColor: "", privacyUrl: "", emails: [], phones: [], jsonLd: "[]", headings: [] } });

let dir, server, base, sent;
const parsePrompts = [];
const ai = {
  configured: true, provider: "mistral", keyName: "MISTRAL_API_KEY", model: "fake", isApiError: () => false,
  async parse({ messages }) { parsePrompts.push(messages[0].content); return { subject: "Ihre Praxis-Demo", body: "Guten Tag,\n\nwir haben etwas gebaut.\n{{DEMO_LINK}}\n\nPasst das?" }; },
};
const mailer = { from: "anna@agentur.de", dailyLimit: 3, async send(m) { sent.push(m); } };

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentenwerk-aq-"));
  sent = [];
  server = http.createServer(createApp({ dataDir: dir, ai, mailer, crawl: async (u) => site(u), analyze: async (s) => toAgentPatch(draft(new URL(s.url).hostname), s) }));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await fs.rm(dir, { recursive: true, force: true }); });

const admin = { "x-agentenwerk": "1", "content-type": "application/json" };
const j = async (method, p, body) => {
  const r = await fetch(base + p, { method, headers: admin, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: r.status === 204 ? null : await r.json() };
};
async function until(fn) {
  for (let i = 0; i < 150; i++) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 20)); }
  throw new Error("timeout");
}

test("full acquisition flow: autopilot -> leads -> draft -> send -> demo view -> unsubscribe", async () => {
  const csv = "Firma;Website;Ansprechpartner;E-Mail\nZahn Kraft;zahn-kraft.de;Dr. Mia Kraft;mia@zahn-kraft.de\nPraxis Ohne;praxis-ohne.de;;\n";
  const up = await fetch(`${base}/api/batches?filename=l.csv`, { method: "POST", headers: { "x-agentenwerk": "1" }, body: csv });
  assert.equal(up.status, 201);
  const leads = await until(async () => { const l = (await j("GET", "/api/leads")).body; return l.length === 2 && l; });
  const kraft = leads.find((l) => l.company === "Zahn Kraft");
  assert.equal(kraft.stage, "neu");
  assert.equal(kraft.email, "mia@zahn-kraft.de");
  assert.equal(kraft.unsubToken, undefined, "token never leaves the server");

  // Sending needs a draft and a complete sender.
  assert.equal((await j("POST", `/api/leads/${kraft.id}/send`)).status, 400);
  const d = await j("POST", `/api/leads/${kraft.id}/draft`, { kind: "first" });
  assert.equal(d.body.stage, "entwurf");
  assert.equal(d.body.draft.subject, "Ihre Praxis-Demo");
  assert.match(parsePrompts[0], /Dr\. Mia Kraft/);
  assert.match(parsePrompts[0], /Prophylaxe/);
  const noSender = await j("POST", `/api/leads/${kraft.id}/send`);
  assert.equal(noSender.status, 400);
  assert.match(noSender.body.error, /Absenderangaben/);

  await j("PUT", "/api/settings", { sender: { name: "Anna Berger", company: "Agentur Süd", email: "anna@agentur.de", address: "Hauptstr. 1, 80331 München" }, followUpDays: 3 });
  const ok = await j("POST", `/api/leads/${kraft.id}/send`);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.stage, "kontaktiert");
  assert.equal(ok.body.draft, null);
  assert.equal(sent.length, 1);
  const mail = sent[0];
  assert.equal(mail.to, "mia@zahn-kraft.de");
  assert.equal(mail.replyTo, "anna@agentur.de");
  assert.ok(mail.text.includes(`${base}/d/${kraft.agentId}`), "demo link filled in");
  assert.ok(!mail.text.includes("{{DEMO_LINK}}"));
  assert.match(mail.text, /Agentur Süd · Hauptstr\. 1, 80331 München/);
  const token = /abmelden\/([\w-]+)/.exec(mail.text)[1];
  assert.equal(mail.unsubscribeUrl, `${base}/api/public/unsubscribe/${token}`);

  // A lead without an address cannot be sent to.
  const ohne = leads.find((l) => l.company === "Praxis Ohne");
  await j("POST", `/api/leads/${ohne.id}/draft`, {});
  assert.match((await j("POST", `/api/leads/${ohne.id}/send`)).body.error, /keine gültige E-Mail/);

  // Opening the demo from the dashboard does not count; the prospect's visit does.
  await fetch(`${base}/api/public/agents/${kraft.agentId}/preview?intern=1`);
  assert.equal((await j("GET", `/api/leads/${kraft.id}`)).body.stage, "kontaktiert");
  await fetch(`${base}/api/public/agents/${kraft.agentId}/preview`);
  await fetch(`${base}/api/public/agents/${kraft.agentId}/preview`);
  const viewed = (await j("GET", `/api/leads/${kraft.id}`)).body;
  assert.equal(viewed.stage, "angesehen");
  assert.equal(viewed.events.filter((e) => e.type === "demo_view").length, 1, "repeat views within 30 min count once");

  const summary = (await j("GET", "/api/acquisition")).body;
  assert.equal(summary.summary.contacted, 1);
  assert.equal(summary.summary.viewedLeads, 1);
  assert.equal(summary.summary.reached.kontaktiert, 1);
  assert.equal(summary.mail.sentToday, 1);
  assert.deepEqual(summary.senderMissing, []);

  // Unsubscribe via the link blocks every further send to that address.
  const page = await fetch(`${base}/abmelden/${token}`);
  assert.match(await page.text(), /Abmelden/);
  assert.equal((await fetch(`${base}/api/public/unsubscribe/${token}`, { method: "POST" })).status, 200);
  const gone = (await j("GET", `/api/leads/${kraft.id}`)).body;
  assert.equal(gone.stage, "abgemeldet");
  await j("PATCH", `/api/leads/${kraft.id}`, { stage: "kontaktiert", draft: { subject: "x", body: "y {{DEMO_LINK}}" } });
  assert.match((await j("POST", `/api/leads/${kraft.id}/send`)).body.error, /abgemeldet/);
  assert.equal(sent.length, 1);
  assert.equal((await fetch(`${base}/api/public/unsubscribe/falsch-falsch`, { method: "POST" })).status, 404);
});

test("bulk drafts run in the background and the daily limit stops sending", async () => {
  const leads = (await j("GET", "/api/leads")).body;
  // Make three fresh, sendable leads.
  const csv = "Website;E-Mail\neins.de;a@eins.de\nzwei.de;b@zwei.de\ndrei.de;c@drei.de\n";
  await fetch(`${base}/api/batches?filename=b.csv`, { method: "POST", headers: { "x-agentenwerk": "1" }, body: csv });
  const fresh = await until(async () => { const l = (await j("GET", "/api/leads")).body; return l.length === leads.length + 3 && l.filter((x) => x.stage === "neu" && x.email); });
  const ids = fresh.map((l) => l.id);
  const r = await j("POST", "/api/leads/bulk", { action: "draft", ids });
  assert.equal(r.status, 202);
  await until(async () => (await j("GET", "/api/leads")).body.filter((l) => ids.includes(l.id) && l.draft).length === 3);
  sent.length = 0;
  await j("POST", "/api/leads/bulk", { action: "send", ids });
  await until(async () => (await j("GET", "/api/acquisition")).body.tasks.length === 0);
  // One mail went out in the first test today, the limit is 3.
  assert.equal(sent.length, 2);
  const errs = (await j("GET", "/api/leads")).body.filter((l) => ids.includes(l.id) && l.events.some((e) => e.type === "error"));
  assert.equal(errs.length, 1);
  assert.match(errs[0].events.find((e) => e.type === "error").message, /Tageslimit/);

  const st = await j("POST", "/api/leads/bulk", { action: "stage", stage: "kunde", ids: [ids[0]] });
  assert.equal(st.body.updated, 1);
  assert.equal((await j("GET", `/api/leads/${ids[0]}`)).body.stage, "kunde");
});

test("deleting a batch removes its leads", async () => {
  const batches = (await j("GET", "/api/batches")).body;
  const before = (await j("GET", "/api/leads")).body.length;
  await j("DELETE", `/api/batches/${batches[0].id}`);
  assert.equal((await j("GET", "/api/leads")).body.length, before - 3);
});

test("helpers: follow-up timing, funnel, composed e-mail", () => {
  const now = Date.now();
  const lead = { stage: "kontaktiert", sent: [{ at: now - 4 * 86_400_000 }], events: [] };
  assert.equal(followUpDue(lead, { followUpDays: 3 }, now), true);
  assert.equal(followUpDue(lead, { followUpDays: 5 }, now), false);
  assert.equal(followUpDue(lead, { followUpDays: 0 }, now), false);
  assert.equal(followUpDue({ ...lead, stage: "kunde" }, { followUpDays: 3 }, now), false);

  const s = summarizeLeads([{ ...lead, stage: "angesehen", events: [{ type: "demo_view", at: now }] }, { stage: "neu", sent: [], events: [] }], { followUpDays: 3 }, now);
  assert.equal(s.reached.neu, 2);
  assert.equal(s.reached.kontaktiert, 1);
  assert.equal(s.reached.angesehen, 1);
  assert.equal(s.viewedLeads, 1);

  const text = composeEmail({ draft: { body: "Hallo\n{{DEMO_LINK}}" }, sender: { name: "Anna", company: "Agentur", email: "a@b.de", address: "Weg 1\n12345 Ort" }, demoUrl: "https://x/d/1", unsubscribeUrl: "https://x/abmelden/t" });
  assert.match(text, /^Hallo\nhttps:\/\/x\/d\/1\n\nViele Grüße\nAnna\nAgentur\na@b\.de/);
  assert.match(text, /Agentur · Weg 1 · 12345 Ort/);
  assert.match(text, /Ein Klick genügt: https:\/\/x\/abmelden\/t$/);
});

test("HTML e-mail: sample chat in brand colors, everything escaped", async () => {
  const { composeHtml, sampleDialogue } = await import("../src/outreach.js");
  const agent = { name: "Ida", company: "Fahrschule <Schlachter>", color: "#f0c040", website: "fahrschule.de", welcome: "Willkommen!", logoUrl: "https://fahrschule.de/logo.png",
    faqs: [{ q: "Kann ich B197 machen?", a: "Ja, bei uns geht B197 mit <Automatik> und Schaltung." }], widgetTitle: "Fragen zum Führerschein?" };
  const d = sampleDialogue(agent);
  assert.deepEqual(d.map((m) => m.from), ["bot", "user", "bot"]);
  assert.equal(d[1].text, "Kann ich B197 machen?");
  const html = composeHtml({ draft: { subject: "Demo", body: "Guten Tag,\n\nkurz.\n\n{{DEMO_LINK}}\n\nInteresse?" }, sender: { name: "Anna", company: "Agentur", email: "a@b.de", address: "Weg 1" }, demoUrl: "https://x/d/1", unsubscribeUrl: "https://x/abmelden/t", agent });
  assert.ok(html.includes("&lt;Automatik&gt;"), "answers are escaped");
  assert.ok(!html.includes("<Schlachter>"));
  assert.ok(html.includes("background:#f0c040"), "brand color used");
  assert.ok(html.includes("color:#111111"), "dark text on a light brand color");
  assert.ok(html.includes('href="https://x/d/1"'));
  assert.ok(html.includes("Fragen zum Führerschein?"));
  assert.ok(html.includes("https://fahrschule.de/logo.png"));
  assert.ok(html.includes('href="https://x/abmelden/t"'));
  assert.ok(!html.includes("{{DEMO_LINK}}"));
});

test("test-send goes to the sender only, skip marks the lead", async () => {
  const csv = "Website;E-Mail\nvorschau-test.de;kunde@vorschau-test.de\n";
  await fetch(`${base}/api/batches?filename=v.csv`, { method: "POST", headers: { "x-agentenwerk": "1" }, body: csv });
  const lead = await until(async () => (await j("GET", "/api/leads")).body.find((l) => l.url.includes("vorschau-test")));
  await j("POST", `/api/leads/${lead.id}/draft`, {});
  sent.length = 0;
  const r = await j("POST", `/api/leads/${lead.id}/test-send`);
  assert.equal(r.status, 200);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, "anna@agentur.de");
  assert.match(sent[0].subject, /^\[Vorschau\]/);
  assert.match(sent[0].html, /Demo selbst ausprobieren/);
  const after = (await j("GET", `/api/leads/${lead.id}`)).body;
  assert.equal(after.sent.length, 0, "a preview is not a send");
  assert.ok(after.draft, "draft stays");
  const sk = await j("POST", `/api/leads/${lead.id}/skip`);
  assert.equal(sk.body.skipped, true);
  const pv = await j("GET", `/api/leads/${lead.id}/preview-email`);
  assert.match(pv.body.html, /<!doctype html>/);
});

test("demo page may be framed by the builder only", async () => {
  const leads = (await j("GET", "/api/leads")).body;
  const r = await fetch(`${base}/d/${leads[0].agentId}`);
  assert.equal(r.headers.get("x-frame-options"), "SAMEORIGIN");
  assert.match(r.headers.get("content-security-policy"), /frame-ancestors 'self'/);
  assert.equal((await fetch(`${base}/`)).headers.get("x-frame-options"), "DENY");
});
