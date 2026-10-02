import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/app.js";
import { toAgentPatch } from "../src/analyze.js";

const draftFor = (host) => ({
  company: `Firma ${host}`, industry: "Handwerk", name: "Ida", initials: "FI", role: "r", address: "sie", tone: ["freundlich"], language: "de",
  knowledge: "Wissen", hours: "Mo–Fr 8–17", services: "Bad sanieren – ab 9.000 €\nHeizung warten – 129 €", goal: "leads", goalReason: "", leadFields: ["name", "phone"],
  bookingRules: "", handoff: "", faqs: [{ q: "Kommen Sie auch am Wochenende?", a: "Nur im Notfall." }], quickReplies: ["Angebot anfragen"], welcome: "Hallo!",
  dos: "", donts: "", color: "#aa3311", missing: ["Preise"],
});
const site = (url) => ({
  url, pages: [{ url, title: "Start", text: "x".repeat(400) }], failed: [],
  meta: { siteName: "Meister Bad", title: "Start", description: "Bäder aus einer Hand", headings: ["Bäder", "Heizung"], themeColor: "", privacyUrl: "", emails: [], phones: [], jsonLd: "[]" },
});

let dir, server, base;
const crawled = [];
before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentenwerk-ap-"));
  const handler = createApp({
    dataDir: dir,
    ai: { configured: true, model: "fake", isApiError: () => false },
    crawl: async (url) => {
      crawled.push(url);
      if (url.includes("kaputt")) { const { CrawlError } = await import("../src/crawl.js"); throw new CrawlError("kaputt.de ist nicht erreichbar."); }
      return site(url);
    },
    analyze: async (s) => toAgentPatch(draftFor(new URL(s.url).hostname), s),
    screenshotter: { capture: async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]) },
    agency: { name: "Webagentur Süd" },
  });
  server = http.createServer(handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await fs.rm(dir, { recursive: true, force: true }); });

const admin = { "x-agentenwerk": "1" };
async function waitDone(id) {
  for (let i = 0; i < 100; i++) {
    const b = await (await fetch(`${base}/api/batches/${id}`, { headers: admin })).json();
    if (b.status === "done") return b;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("batch did not finish");
}

test("upload a CSV: every row becomes an agent with a demo", async () => {
  const csv = "Firma;Website;Ansprechpartner;E-Mail\nBad Meister;meister-bad.de;Jan;jan@meister-bad.de\n;kaputt.de;;\nDoppelt;https://meister-bad.de/;;\n;heizung-profi.de;;\n";
  const res = await fetch(`${base}/api/batches?filename=liste.csv&name=Handwerk%20M%C3%BCnchen`, { method: "POST", headers: admin, body: csv });
  assert.equal(res.status, 201);
  const created = await res.json();
  assert.equal(created.total, 3);
  assert.equal(created.skipped.length, 1);
  assert.equal(created.name, "Handwerk München");

  const b = await waitDone(created.id);
  assert.deepEqual(b.rows.map((r) => r.status), ["done", "failed", "done"]);
  assert.equal(b.rows[1].error, "kaputt.de ist nicht erreichbar.");

  const first = b.rows[0];
  const agent = await (await fetch(`${base}/api/agents/${first.agentId}`, { headers: admin })).json();
  assert.equal(agent.company, "Bad Meister", "company from the table wins");
  assert.equal(agent.batchId, created.id);
  assert.equal(agent.prospect.email, "jan@meister-bad.de");
  assert.equal(agent.preview.screenshot, true);
  assert.equal(b.rows[2].company, "Firma heizung-profi.de", "falls back to the model's company name");

  // Demo page data is public, without admin header.
  const pv = await (await fetch(`${base}/api/public/agents/${first.agentId}/preview`)).json();
  assert.equal(pv.company, "Bad Meister");
  assert.equal(pv.screenshot, true);
  assert.equal(pv.title, "Meister Bad");
  assert.deepEqual(pv.services, ["Bad sanieren – ab 9.000 €", "Heizung warten – 129 €"]);
  assert.equal(pv.agency.name, "Webagentur Süd");
  assert.equal(pv.knowledge, undefined);
  const shot = await fetch(`${base}/api/public/agents/${first.agentId}/screenshot`);
  assert.equal(shot.headers.get("content-type"), "image/jpeg");
  const page = await fetch(`${base}/d/${first.agentId}`);
  assert.match(await page.text(), /noindex/);

  // Export lists demo links and embed code.
  const exp = await fetch(`${base}/api/batches/${created.id}/export`, { headers: admin });
  assert.match(exp.headers.get("content-disposition"), /Handwerk-München\.csv/);
  const text = await exp.text();
  assert.ok(text.includes(`${base}/d/${first.agentId}`));
  assert.ok(text.includes("Fehlgeschlagen"));
  assert.ok(text.includes("Fehlt auf der Website: Preise"));

  // Retry re-runs only the failed row.
  crawled.length = 0;
  await fetch(`${base}/api/batches/${created.id}/retry`, { method: "POST", headers: admin });
  await waitDone(created.id);
  assert.deepEqual(crawled, ["https://kaputt.de/"]);

  // Deleting the batch removes its agents and screenshots.
  assert.equal((await fetch(`${base}/api/batches/${created.id}`, { method: "DELETE", headers: admin })).status, 204);
  assert.equal((await fetch(`${base}/api/agents/${first.agentId}`, { headers: admin })).status, 404);
  await assert.rejects(fs.stat(path.join(dir, "screenshots", `${first.agentId}.jpg`)));
});

test("the demo page may chat even when the agent is locked to the customer's domain", async () => {
  const agent = await (await fetch(`${base}/api/agents`, { method: "POST", headers: { ...admin, "content-type": "application/json" }, body: JSON.stringify({ name: "X", allowedOrigins: ["https://kunde.de"] }) })).json();
  const self = await fetch(`${base}/api/public/agents/${agent.id}`, { headers: { origin: base } });
  assert.equal(self.status, 200);
  const foreign = await fetch(`${base}/api/public/agents/${agent.id}`, { headers: { origin: "https://fremd.de" } });
  assert.equal(foreign.status, 403);
});

test("bad uploads get a clear error", async () => {
  const r1 = await fetch(`${base}/api/batches?filename=x.csv`, { method: "POST", headers: admin, body: "Name;Ort\nA;B\n" });
  assert.equal(r1.status, 400);
  assert.match((await r1.json()).error, /Website/);
  const r2 = await fetch(`${base}/api/batches?filename=x.xlsx`, { method: "POST", headers: admin, body: "kein zip" });
  assert.equal(r2.status, 400);
  assert.equal((await fetch(`${base}/api/batches`, { method: "POST", body: "a" })).status, 403);
});

test("interrupted rows resume after a restart", async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), "agentenwerk-resume-"));
  await fs.writeFile(path.join(d, "batches.json"), JSON.stringify([{ id: "b1", name: "alt", createdAt: 1, rows: [
    { id: "r1", url: "https://alt.de/", status: "analyzing", claimed: true }, { id: "r2", url: "https://neu.de/", status: "done", agentId: "x" },
  ] }]));
  const seen = [];
  createApp({ dataDir: d, ai: { configured: true }, crawl: async (u) => { seen.push(u); return site(u); }, analyze: async (s) => toAgentPatch(draftFor("alt.de"), s) });
  for (let i = 0; i < 50 && !seen.length; i++) await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(seen, ["https://alt.de/"]);
  await new Promise((r) => setTimeout(r, 100));
  await fs.rm(d, { recursive: true, force: true });
});
