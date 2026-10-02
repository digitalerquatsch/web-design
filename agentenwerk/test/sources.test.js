import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/app.js";
import { buildPrompt } from "../public/prompt.js";

const H = { "x-agentenwerk": "1", "content-type": "application/json" };
const long = (t) => `${t} `.repeat(60);

test("prompt includes knowledge sources and caps them", () => {
  const p = buildPrompt({ name: "Ida", sources: [{ id: "s1", kind: "file", name: "preise.txt", text: "Haarschnitt 32 Euro" }, { id: "s2", kind: "website", name: "Start", url: "https://x.de", text: "y".repeat(200000) }, { id: "s3", kind: "file", name: "spät", text: "zzz" }] });
  assert.match(p, /Quelle: preise\.txt/);
  assert.match(p, /Haarschnitt 32 Euro/);
  assert.match(p, /1 weitere Quellen passen nicht/);
});

test("website source import: single source, thorough = one per page; sources survive saves and are capped", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentenwerk-src-"));
  const seen = [];
  const crawl = async (url, opts) => { seen.push(opts); opts.onProgress({ type: "page", url, title: "Start" }); return { url: "https://x.de/", pages: [{ url: "https://x.de/", title: "Start", text: long("Start") }, { url: "https://x.de/a", title: "Preise", text: long("Preise") }, { url: "https://x.de/leer", title: "Leer", text: "kurz" }], failed: [{ url: "q", reason: "r" }], meta: {} }; };
  const server = http.createServer(createApp({ dataDir: dir, ai: { configured: true, provider: "mistral", model: "f", isApiError: () => false }, crawl }));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://localhost:${server.address().port}`;
  let cookie = "";
  const raw = async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: { ...H, ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = r.headers.get("set-cookie"); if (set) cookie = set.split(";")[0];
    return { status: r.status, text: await r.text() };
  };
  const result = (text) => JSON.parse(/event: result\ndata: (.*)/.exec(text)[1]);
  await raw("POST", "/api/auth/setup", { name: "A", email: "a@x.de", password: "sehr-sicheres-pw" });
  const one = result((await raw("POST", "/api/sources/website", { url: "x.de" })).text);
  assert.equal(one.sources.length, 1);
  assert.equal(one.sources[0].name, "x.de");
  assert.equal(seen[0].maxPages, 8);
  const deep = result((await raw("POST", "/api/sources/website", { url: "x.de", thorough: true })).text);
  assert.deepEqual(deep.sources.map((s) => s.name), ["Start", "Preise"], "short pages are dropped, one source per page");
  assert.equal(seen[1].maxPages, 80);
  assert.equal(seen[1].deep, true);
  const made = JSON.parse((await raw("POST", "/api/agents", { name: "Bot", sources: [...deep.sources, { kind: "file", name: "x".repeat(500), text: "t".repeat(70000) }, { kind: "file", name: "leer", text: "  " }] })).text);
  assert.equal(made.sources.length, 3);
  assert.equal(made.sources[2].text.length, 60000);
  assert.equal(made.sources[2].name.length, 160);
  const put = JSON.parse((await raw("PUT", `/api/agents/${made.id}`, made)).text);
  assert.equal(put.sources.length, 3);
  const many = JSON.parse((await raw("POST", "/api/agents", { name: "Viele", sources: Array.from({ length: 30 }, (_, i) => ({ kind: "file", name: `f${i}`, text: "t".repeat(60000) })) })).text);
  assert.equal(many.sources.length, 20, "total size is capped at 1.2 million characters");
  server.close(); await fs.rm(dir, { recursive: true, force: true });
});
