import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/app.js";
import { sanitizeSite, readiness, legalDrafts, renderSite, decodeImage } from "../src/site.js";

const H = { "x-agentenwerk": "1", "content-type": "application/json" };
const PNG = "data:image/png;base64," + Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(40)]).toString("base64");

test("sanitize: slug rules, urls, images", () => {
  assert.throws(() => sanitizeSite({ slug: "Ab" }), /Adresse/);
  assert.throws(() => sanitizeSite({ slug: "api" }), /Adresse/);
  assert.throws(() => sanitizeSite({ bookingUrl: "javascript:alert(1)" }), /https/);
  assert.throws(() => sanitizeSite({ email: "kaputt" }), /E-Mail/);
  assert.equal(sanitizeSite({ slug: "Meine-Agentur" }).slug, "meine-agentur");
  assert.equal(sanitizeSite({ color: "red" }).color, "#ff2e93");
  assert.throws(() => decodeImage("data:image/svg+xml;base64,PHN2Zz4="), /PNG/);
  assert.throws(() => decodeImage("data:image/png;base64," + Buffer.from("kein bild").toString("base64")), /gültiges Bild/);
  assert.equal(decodeImage(PNG).mime, "image/png");
});

test("rendering escapes everything and legal drafts block publishing until filled", () => {
  const s = sanitizeSite({ slug: "x-agentur", agencyName: '<script>alert(1)</script>"', aboutText: "<img src=x onerror=1>\n\nZwei", email: "a@b.de" }, { id: "main" });
  const html = renderSite(s);
  assert.equal(html.includes("<script>alert"), false);
  assert.equal(html.includes("<img src=x"), false);
  assert.match(html, /&lt;script&gt;/);
  assert.equal(html.includes("<script"), false, "no script without a chat agent");
  assert.match(renderSite(s, { agent: { id: "abc123" } }), /data-agent="abc123"/);
  assert.ok(readiness(s).includes("Impressum"));
  const d = legalDrafts(s);
  s.imprint = d.imprint; s.privacy = d.privacy;
  assert.ok(readiness(s).some((x) => /Platzhalter/.test(x)), "template placeholders must be filled in");
  s.imprint = "Alexander Beispiel, Musterweg 1, 56000 Westerwald"; s.privacy = "Datenschutz ohne Platzhalter";
  assert.deepEqual(readiness(s), []);
});

test("API: save, publish gate, public page, images, uniqueness, workspace isolation", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentenwerk-site-"));
  const server = http.createServer(createApp({ dataDir: dir, ai: { configured: true, provider: "mistral", model: "f", isApiError: () => false } }));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://localhost:${server.address().port}`;
  let cookie = "";
  const call = async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: { ...H, ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = r.headers.get("set-cookie"); if (set) cookie = set.split(";")[0];
    const t = await r.text(); let b = t; try { b = JSON.parse(t); } catch { /* html */ } return { status: r.status, body: b, headers: r.headers };
  };
  await call("POST", "/api/auth/setup", { name: "A", email: "a@x.de", password: "sehr-sicheres-pw" });
  assert.equal((await fetch(`${base}/s/agentschmiede`)).status, 404, "unknown page");
  let r = await call("PUT", "/api/site", { slug: "agentschmiede", agencyName: "Agentschmiede", city: "Westerwald", email: "info@x.de", logo: PNG, aboutText: "Hallo" });
  assert.equal(r.status, 200);
  assert.match(r.body.logo, /^data:image\/png/);
  assert.equal(r.body.online, false);
  assert.equal((await call("PUT", "/api/site", { online: true })).status, 400, "needs legal texts");
  const legal = (await call("GET", "/api/site/legal")).body;
  assert.match(legal.imprint, /Agentschmiede/);
  r = await call("PUT", "/api/site", { imprint: "Impressum fertig", privacy: "Datenschutz fertig", online: true });
  assert.equal(r.body.online, true);
  r = await call("PUT", "/api/site", { ctaText: "Los" });
  assert.equal(r.body.online, true, "a normal save keeps the page online");
  const page = await fetch(`${base}/s/agentschmiede`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.match(await page.text(), /Agentschmiede/);
  assert.match(await (await fetch(`${base}/s/agentschmiede/impressum`)).text(), /Impressum fertig/);
  const logo = await fetch(`${base}/s/agentschmiede/logo`);
  assert.equal(logo.headers.get("content-type"), "image/png");
  assert.equal((await fetch(`${base}/s/agentschmiede/foto`)).status, 404);
  assert.equal((await call("PUT", "/api/site", { logo: "data:image/svg+xml;base64,PHN2Zz4=" })).status, 400);
  r = await call("PUT", "/api/site", { online: false });
  assert.equal((await fetch(`${base}/s/agentschmiede`)).status, 404, "offline pages are gone");
  // an abo workspace gets its own page and cannot take the same address
  const abo = await call("POST", "/api/users", { name: "Abo", email: "abo@x.de", role: "abo" });
  assert.equal(abo.status, 201);
  server.close(); await fs.rm(dir, { recursive: true, force: true });
});
