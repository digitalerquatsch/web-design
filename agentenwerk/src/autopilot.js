// The autopilot: one uploaded table in, one finished agent plus a shareable
// demo per row out. Rows run in a small pool; every state change is written
// to the store first, so the builder's polling and a restart both see the
// truth. Rows that were mid-flight when the server stopped start over.

import fs from "node:fs/promises";
import path from "node:path";
import { newId } from "./store.js";
import { CrawlError } from "./crawl.js";
import { withDefaults } from "../public/prompt.js";

export const ROW_STEPS = {
  queued: "Wartet",
  crawling: "Liest Website",
  analyzing: "Baut Agent",
  screenshot: "Erstellt Vorschau",
  done: "Fertig",
  failed: "Fehlgeschlagen",
};
const ACTIVE = new Set(["crawling", "analyzing", "screenshot"]);

export function summarize(batch) {
  const counts = Object.fromEntries(Object.keys(ROW_STEPS).map((k) => [k, 0]));
  for (const r of batch.rows) counts[r.status]++;
  const finished = counts.done + counts.failed;
  return {
    id: batch.id, name: batch.name, createdAt: batch.createdAt, total: batch.rows.length, counts,
    status: finished === batch.rows.length ? "done" : "running",
  };
}

export function createAutopilot({ store, crawl, analyze, ai, screenshotter = null, screenshotDir, concurrency = 2 }) {
  let active = 0;
  let stopped = false;
  const listeners = new Set();

  async function saveRow(batchId, rowId, patch) {
    const batch = await store.get("batches", batchId);
    if (!batch) return null;
    const row = batch.rows.find((r) => r.id === rowId);
    if (!row) return null;
    Object.assign(row, patch, { updatedAt: Date.now() });
    await store.put("batches", batch);
    for (const fn of listeners) fn(batch, row);
    return row;
  }

  async function nextRow() {
    const batches = await store.list("batches");
    batches.sort((a, b) => a.createdAt - b.createdAt);
    for (const b of batches) {
      const r = b.rows.find((x) => x.status === "queued" && !x.claimed);
      if (r) { r.claimed = true; return { batch: b, row: r }; }
    }
    return null;
  }

  async function processRow(batchId, row) {
    try {
      if (!ai.configured) throw new CrawlError("ANTHROPIC_API_KEY fehlt in der .env.");
      await saveRow(batchId, row.id, { status: "crawling", error: "" });
      const site = await crawl(row.url, {});
      if (!site.pages.some((p) => p.text.length > 200)) throw new CrawlError("Kaum Text auf der Website (wird sie per JavaScript aufgebaut?).");

      await saveRow(batchId, row.id, { status: "analyzing", pages: site.pages.length });
      const result = await analyze(site, { ai });
      const fields = { ...result.fields };
      if (row.company) fields.company = row.company; // the table wins over the model's guess
      const existing = row.agentId ? await store.get("agents", row.agentId) : null;
      const agent = {
        ...withDefaults({ ...fields, template: "website", source: result.source }),
        id: existing?.id || newId(),
        batchId,
        prospect: { contact: row.contact, email: row.email, phone: row.phone, city: row.city },
        createdAt: existing?.createdAt || Date.now(),
        updatedAt: Date.now(),
      };
      await store.put("agents", agent);
      await saveRow(batchId, row.id, { status: "screenshot", agentId: agent.id, company: row.company || fields.company });

      let screenshot = false;
      if (screenshotter) {
        try {
          const img = await screenshotter.capture(site.url);
          await fs.mkdir(screenshotDir, { recursive: true });
          await fs.writeFile(path.join(screenshotDir, `${agent.id}.jpg`), img);
          screenshot = true;
        } catch (e) {
          console.warn(`screenshot ${row.url}:`, e?.message || e);
        }
      }
      agent.preview = { screenshot, at: Date.now() };
      await store.put("agents", agent);
      await saveRow(batchId, row.id, { status: "done", screenshot, claimed: false });
    } catch (err) {
      const message = err instanceof CrawlError ? err.message : (err?.code === "refusal" ? err.message : "Unerwarteter Fehler bei der Verarbeitung.");
      if (!(err instanceof CrawlError)) console.error(`autopilot ${row.url}:`, err?.message || err);
      await saveRow(batchId, row.id, { status: "failed", error: message, claimed: false });
    }
  }

  async function pump() {
    while (!stopped && active < concurrency) {
      const next = await nextRow();
      if (!next) return;
      active++;
      processRow(next.batch.id, next.row).finally(() => { active--; pump(); });
    }
  }

  return {
    async resume() {
      for (const b of await store.list("batches")) {
        let dirty = false;
        for (const r of b.rows) if (ACTIVE.has(r.status) || r.claimed) { r.status = "queued"; r.claimed = false; dirty = true; }
        if (dirty) await store.put("batches", b);
      }
      pump();
    },

    async createBatch({ name, rows, skipped = [] }) {
      const batch = {
        id: newId(),
        name: name || `Autopilot ${new Date().toLocaleString("de-DE", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Berlin" })}`,
        createdAt: Date.now(),
        skipped,
        rows: rows.map((r) => ({ id: newId(), ...r, status: "queued", error: "", agentId: null })),
      };
      await store.put("batches", batch);
      pump();
      return batch;
    },

    async retry(batchId) {
      const batch = await store.get("batches", batchId);
      if (!batch) return null;
      for (const r of batch.rows) if (r.status === "failed") { r.status = "queued"; r.error = ""; r.claimed = false; }
      await store.put("batches", batch);
      pump();
      return batch;
    },

    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    get active() { return active; },
    stop() { stopped = true; },
  };
}
