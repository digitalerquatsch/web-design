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

function hostGet(port, host, p, ua = "Mozilla/5.0 Test") {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path: p, headers: { host, "user-agent": ua } }, (res) => {
      let b = ""; res.on("data", (c) => { b += c; }); res.on("end", () => resolve({ status: res.statusCode, body: b }));
    }).on("error", reject);
  });
}

test("reviews, text overrides, custom domain with CNAME check, domain-ok, views", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentenwerk-dom-"));
  let cname = [];
  const server = http.createServer(createApp({ dataDir: dir, publicUrl: "https://agentenwerk.example", resolveCname: async () => { if (!cname.length) throw new Error("ENODATA"); return cname; }, ai: { configured: true, provider: "mistral", model: "f", isApiError: () => false } }));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const base = `http://localhost:${port}`;
  let cookie = "";
  const call = async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: { ...H, ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = r.headers.get("set-cookie"); if (set) cookie = set.split(";")[0];
    const t = await r.text(); let b = t; try { b = JSON.parse(t); } catch { /* html */ } return { status: r.status, body: b };
  };
  await call("POST", "/api/auth/setup", { name: "A", email: "a@x.de", password: "sehr-sicheres-pw" });
  let r = await call("PUT", "/api/site", { slug: "firma", agencyName: "Firma", email: "a@b.de", imprint: "I", privacy: "P", online: true, heroTitle: "Mein Titel <b>", reviews: [{ name: "Eva", role: "Bäckerei", text: "Super <script>x</script>" }, { name: "", text: "ohne Name" }] });
  assert.equal(r.status, 200);
  assert.equal(r.body.reviews.length, 1, "reviews need name and text");
  const html = await (await fetch(`${base}/s/firma`)).text();
  assert.match(html, /Mein Titel &lt;b&gt;/);
  assert.match(html, /Stimmen/);
  assert.equal(html.includes("<script>x"), false);

  assert.equal((await call("PUT", "/api/site", { domain: "deine-agentur.de" })).status, 400, "apex domain is refused");
  assert.equal((await call("PUT", "/api/site", { domain: "agentenwerk.example" })).status, 400);
  r = await call("PUT", "/api/site", { domain: "WWW.Firma-Seite.de" });
  assert.equal(r.body.domain, "www.firma-seite.de");
  assert.equal(r.body.domainVerified, false);
  assert.equal(r.body.cnameTarget, "agentenwerk.example");
  assert.notEqual((await hostGet(port, "www.firma-seite.de", "/")).body.includes("Firma"), true, "unverified domain does not serve the page");
  assert.equal((await fetch(`${base}/api/public/domain-ok?domain=www.firma-seite.de`)).status, 404);
  r = await call("POST", "/api/site/domain/check", {});
  assert.equal(r.body.ok, false);
  cname = ["wrong.example."];
  assert.equal((await call("POST", "/api/site/domain/check", {})).body.ok, false);
  cname = ["Agentenwerk.example."];
  assert.equal((await call("POST", "/api/site/domain/check", {})).body.ok, true);
  assert.equal((await fetch(`${base}/api/public/domain-ok?domain=www.firma-seite.de`)).status, 200);
  assert.equal((await fetch(`${base}/api/public/domain-ok?domain=anders.example.de`)).status, 404);

  const root = await hostGet(port, "www.firma-seite.de", "/");
  assert.equal(root.status, 200);
  assert.match(root.body, /href="\/impressum"/);
  assert.match(root.body, /Mein Titel/);
  assert.match((await hostGet(port, "www.firma-seite.de", "/impressum")).body, /Impressum/);
  for (const p of ["/api/agents", "/api/status", "/api/public/plan", "/index.html", "/app.js"]) assert.equal((await hostGet(port, "www.firma-seite.de", p)).status, 404, `${p} must not be reachable on a customer domain`);
  await hostGet(port, "www.firma-seite.de", "/", "Googlebot/2.1");
  const views = (await call("GET", "/api/site")).body.views;
  assert.equal(views.today, 2, "counted: /s/firma once and the verified custom domain once; bots and legal pages are not");
  assert.equal(views.series.length, 30);
  r = await call("PUT", "/api/site", { domain: "" });
  assert.equal(r.body.domain, "");
  server.close(); await fs.rm(dir, { recursive: true, force: true });
});
