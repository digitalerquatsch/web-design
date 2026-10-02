import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/app.js";
import { buildPrompt, fromTemplate, publicView } from "../public/prompt.js";
import { toAgentPatch } from "../src/analyze.js";

// A stand-in for createAi(): stream() replays scripted assistant messages.
function fakeAi(script) {
  const calls = [];
  return {
    configured: true,
    model: "fake",
    calls,
    isApiError: () => false,
    async parse() { throw new Error("not scripted"); },
    stream(params) {
      calls.push(params);
      const msg = script.shift();
      let onText = () => {};
      return {
        on(evt, cb) { if (evt === "text") onText = cb; return this; },
        async finalMessage() {
          for (const b of msg.content) if (b.type === "text") onText(b.text);
          return msg;
        },
      };
    },
  };
}

let dir, server, base, ai;
const draft = {
  company: "Teehaus Nord", industry: "Teeladen", name: "Ida", initials: "tn", role: "Du berätst zu Tee.", address: "du",
  tone: ["freundlich", "freundlich", "sachlich"], language: "de", knowledge: "Tee seit 1998.", hours: "Mo–Fr 9–18", services: "Darjeeling 100 g – 6,90 €",
  goal: "sales", goalReason: "Shop", leadFields: ["name", "email"], bookingRules: "", handoff: "", faqs: [{ q: "Versand?", a: "2 Tage." }, { q: " ", a: "" }],
  quickReplies: ["Welcher Tee passt zu mir?", "Versandkosten", "Angebote", "Geschenke", "zu viel"], welcome: "Hi, ich bin Ida!", dos: "", donts: "", color: "blau", missing: ["Öffnungszeiten am Wochenende"],
};
const crawlResult = { url: "https://teehaus.de/", pages: [{ url: "https://teehaus.de/", title: "Teehaus", text: "x".repeat(300) }], failed: [], meta: { themeColor: "#225544", privacyUrl: "https://teehaus.de/datenschutz", emails: [], phones: [], jsonLd: "[]" } };

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentenwerk-"));
  ai = fakeAi([]);
  const handler = createApp({
    dataDir: dir, ai,
    crawl: async (url, { onProgress }) => { onProgress({ type: "page", url, title: "Teehaus" }); return crawlResult; },
    analyze: async (site) => toAgentPatch(draft, site),
  });
  server = http.createServer(handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://localhost:${server.address().port}`;
});
after(async () => {
  server.close();
  await fs.rm(dir, { recursive: true, force: true });
});

const admin = { "content-type": "application/json", "x-agentenwerk": "1" };
async function events(res) {
  const text = await res.text();
  return text.split("\n\n").filter(Boolean).map((c) => ({ event: /event: (.*)/.exec(c)[1], data: JSON.parse(/data: (.*)/.exec(c)[1]) }));
}

test("admin API needs the custom header and a localhost Host", async () => {
  assert.equal((await fetch(`${base}/api/agents`)).status, 403);
  const res = await new Promise((resolve) => {
    http.get({ host: "127.0.0.1", port: server.address().port, path: "/api/agents", headers: { host: "evil.example:80", "x-agentenwerk": "1" } }, resolve);
  });
  assert.equal(res.statusCode, 403);
  assert.equal((await fetch(`${base}/api/agents`, { headers: admin })).status, 200);
});

test("ADMIN_TOKEN is enforced when set", async () => {
  const handler = createApp({ dataDir: dir, ai, adminToken: "geheim" });
  const s = http.createServer(handler);
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${s.address().port}/api/agents`;
  assert.equal((await fetch(url, { headers: admin })).status, 401);
  assert.equal((await fetch(url, { headers: { ...admin, authorization: "Bearer falsch" } })).status, 401);
  assert.equal((await fetch(url, { headers: { ...admin, authorization: "Bearer geheim" } })).status, 200);
  s.close();
});

test("analyze streams progress and returns a cleaned agent draft", async () => {
  const res = await fetch(`${base}/api/analyze`, { method: "POST", headers: admin, body: JSON.stringify({ url: "teehaus.de" }) });
  const ev = await events(res);
  assert.deepEqual(ev.map((e) => e.event), ["page", "status", "result"]);
  const { fields, source } = ev.at(-1).data;
  assert.equal(fields.company, "Teehaus Nord");
  assert.equal(fields.initials, "TN");
  assert.deepEqual(fields.tone, ["freundlich", "sachlich"]);
  assert.equal(fields.faqs.length, 1, "empty FAQ dropped");
  assert.equal(fields.quickReplies.length, 4);
  assert.equal(fields.color, "#225544", "invalid color falls back to theme-color");
  assert.equal(fields.privacyUrl, "https://teehaus.de/datenschutz");
  assert.equal(fields.website, "teehaus.de");
  assert.deepEqual(source.missing, ["Öffnungszeiten am Wochenende"]);
});

test("agents CRUD, public view and widget chat with a captured lead", async () => {
  const created = await (await fetch(`${base}/api/agents`, { method: "POST", headers: admin, body: JSON.stringify({ ...fromTemplate("leads"), id: "ignored", allowedOrigins: ["https://kunde.de/", "kein-url"] }) })).json();
  assert.notEqual(created.id, "ignored");
  assert.deepEqual(created.allowedOrigins, ["https://kunde.de"]);

  const pub = await fetch(`${base}/api/public/agents/${created.id}`, { headers: { origin: "https://kunde.de" } });
  assert.equal(pub.status, 200);
  assert.equal(pub.headers.get("access-control-allow-origin"), "https://kunde.de");
  const view = await pub.json();
  assert.deepEqual(Object.keys(view).sort(), Object.keys(publicView(created)).sort());
  assert.equal(view.knowledge, undefined, "no prompt or knowledge leaks to the widget");

  assert.equal((await fetch(`${base}/api/public/agents/${created.id}`, { headers: { origin: "https://fremd.de" } })).status, 403);

  ai.calls.length = 0;
  const script = [
    { stop_reason: "tool_use", content: [{ type: "text", text: "Danke, ich notiere das." }, { type: "tool_use", id: "t1", name: "save_lead", input: { name: "Eva", email: "eva@example.de", budget: "300.000 €" } }] },
    { stop_reason: "end_turn", content: [{ type: "text", text: "Wir melden uns innerhalb eines Tages." }] },
  ];
  ai.stream = fakeAi(script).stream.bind({});
  const orig = ai.stream;
  ai.stream = (p) => { ai.calls.push(p); return orig(p); };

  const res = await fetch(`${base}/api/public/agents/${created.id}/chat`, { method: "POST", headers: { "content-type": "application/json", origin: "https://kunde.de" }, body: JSON.stringify({ message: "Ich suche eine Wohnung." }) });
  assert.equal(res.headers.get("access-control-allow-origin"), "https://kunde.de");
  const ev = await events(res);
  assert.deepEqual(ev.map((e) => e.event), ["conversation", "text", "captured", "text", "text", "done"]);
  const second = ai.calls[1];
  assert.equal(second.messages.length, 3, "user, assistant tool_use, user tool_result");
  assert.equal(second.messages[2].content[0].type, "tool_result");
  assert.match(second.system[0].text, /Lead-Qualifizierung|Interessenten|sammeln/);

  const captured = await (await fetch(`${base}/api/agents/${created.id}/captured`, { headers: admin })).json();
  assert.equal(captured.length, 1);
  assert.deepEqual(captured[0].data, { name: "Eva", email: "eva@example.de", budget: "300.000 €" });
  assert.equal(captured[0].test, false);

  // Follow-up turn continues the same conversation, append-only.
  const convId = ev[0].data.id;
  ai.calls.length = 0;
  const follow = fakeAi([{ stop_reason: "end_turn", content: [{ type: "text", text: "Gern." }] }]).stream;
  ai.stream = (p) => { ai.calls.push(p); return follow(p); };
  await events(await fetch(`${base}/api/public/agents/${created.id}/chat`, { method: "POST", headers: { "content-type": "application/json", origin: "https://kunde.de" }, body: JSON.stringify({ message: "Danke!", conversationId: convId }) }));
  assert.equal(ai.calls[0].messages.length, 5);
  assert.equal(ai.calls[0].messages[0].content, "Ich suche eine Wohnung.");

  const convs = await (await fetch(`${base}/api/agents/${created.id}/conversations`, { headers: admin })).json();
  assert.equal(convs[0].messages.length, 4);

  assert.equal((await fetch(`${base}/api/agents/${created.id}`, { method: "DELETE", headers: admin })).status, 204);
  assert.equal((await (await fetch(`${base}/api/agents/${created.id}/captured`, { headers: admin })).status), 404);
});

test("invalid tool input is reported back to the model, not saved", async () => {
  const agent = await (await fetch(`${base}/api/agents`, { method: "POST", headers: admin, body: JSON.stringify(fromTemplate("termin")) })).json();
  const calls = [];
  const s = fakeAi([
    { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "book_appointment", input: { name: "Tom" } }] },
    { stop_reason: "end_turn", content: [{ type: "text", text: "Welche Leistung und wann?" }] },
  ]).stream;
  ai.stream = (p) => { calls.push(p); return s(p); };
  await events(await fetch(`${base}/api/public/agents/${agent.id}/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "Termin bitte" }) }));
  assert.equal(calls[1].messages[2].content[0].is_error, true);
  const captured = await (await fetch(`${base}/api/agents/${agent.id}/captured`, { headers: admin })).json();
  assert.equal(captured.length, 0);
  assert.ok(calls[0].tools.some((t) => t.name === "book_appointment"));
});

test("refused turns are not appended and the visitor gets a neutral reply", async () => {
  const agent = await (await fetch(`${base}/api/agents`, { method: "POST", headers: admin, body: JSON.stringify(fromTemplate("support")) })).json();
  ai.stream = fakeAi([{ stop_reason: "refusal", content: [{ type: "text", text: "teil" }] }]).stream;
  const ev = await events(await fetch(`${base}/api/public/agents/${agent.id}/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "?" }) }));
  assert.ok(ev.some((e) => e.event === "replace"));
});

test("chat rejects empty and oversized messages", async () => {
  const agent = await (await fetch(`${base}/api/agents`, { method: "POST", headers: admin, body: JSON.stringify(fromTemplate("support")) })).json();
  const post = (message) => fetch(`${base}/api/public/agents/${agent.id}/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message }) });
  assert.equal((await post("")).status, 400);
  assert.equal((await post("x".repeat(2001))).status, 400);
});

test("static files: builder, widget with CORS, no path traversal", async () => {
  const idx = await fetch(`${base}/`);
  assert.equal(idx.status, 200);
  assert.match(idx.headers.get("content-type"), /text\/html/);
  const w = await fetch(`${base}/widget.js`);
  assert.equal(w.headers.get("access-control-allow-origin"), "*");
  assert.equal((await fetch(`${base}/..%2fpackage.json`)).status, 404);
  assert.equal((await fetch(`${base}/../src/app.js`)).status, 404);
});

test("buildPrompt covers goal, knowledge and privacy rule", () => {
  const p = buildPrompt(fromTemplate("termin"));
  assert.match(p, /book_appointment/);
  assert.match(p, /Balayage/);
  assert.match(p, /„du“/);
  assert.match(p, /personenbezogene Daten/);
  assert.equal(buildPrompt({ ...fromTemplate("termin"), privacy: false }).includes("personenbezogene"), false);
});
