import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeUrl, isPrivateAddress, htmlToText, extractPage, rankLinks, crawlSite, fetchPage, CrawlError } from "../src/crawl.js";

test("normalizeUrl adds https and rejects unsafe input", () => {
  assert.equal(normalizeUrl("beispiel.de").href, "https://beispiel.de/");
  assert.equal(normalizeUrl(" http://www.beispiel.de/seite#x ").href, "http://www.beispiel.de/seite");
  for (const bad of ["", "ftp://x.de", "javascript:alert(1)", "https://user:pw@x.de", "https://x.de:8080", "intranet"]) {
    assert.throws(() => normalizeUrl(bad), CrawlError, bad);
  }
});

test("isPrivateAddress blocks internal ranges", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:7f00:1"]) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ["93.184.216.34", "8.8.8.8", "2a00:1450:4001::1", "172.32.0.1"]) {
    assert.equal(isPrivateAddress(ip), false, ip);
  }
});

test("htmlToText keeps readable structure and drops scripts", () => {
  const t = htmlToText(`<html><head><title>T</title><style>.a{}</style></head><body>
    <header><nav>Menü</nav></header><h1>Salon&nbsp;Grün</h1><p>Wir f&auml;rben &amp; schneiden.</p>
    <script>evil()</script><ul><li>Schnitt 30&#8364;</li><li>Farbe</li></ul></body></html>`);
  assert.match(t, /## Salon Grün/);
  assert.match(t, /Wir färben & schneiden\./);
  assert.match(t, /- Schnitt 30€/);
  assert.doesNotMatch(t, /evil|\.a\{\}/);
});

test("extractPage finds links, contacts, theme color and JSON-LD", () => {
  const html = `<html lang="de"><head><title>Praxis Dr. Weiß</title><meta name="theme-color" content="#1d5fa8">
    <meta name="description" content="Zahnarzt in Köln"><script type="application/ld+json">{"@type":"Dentist","telephone":"0221 123"}</script></head>
    <body><a href="/kontakt">Kontakt</a><a href="https://www.praxis.de/leistungen/">Leistungen</a><a href="https://andere.de/x">Fremd</a>
    <a href="/flyer.pdf">PDF</a><a href="mailto:info@praxis.de">Mail</a><a href="tel:+49221123456">Anrufen</a></body></html>`;
  const p = extractPage(html, "https://praxis.de/");
  assert.equal(p.title, "Praxis Dr. Weiß");
  assert.equal(p.themeColor, "#1d5fa8");
  assert.equal(p.description, "Zahnarzt in Köln");
  assert.equal(p.lang, "de");
  assert.deepEqual(p.links.map((l) => l.url), ["https://praxis.de/kontakt", "https://www.praxis.de/leistungen/"]);
  assert.deepEqual(p.emails, ["info@praxis.de"]);
  assert.deepEqual(p.phones, ["+49221123456"]);
  assert.equal(p.jsonLd[0]["@type"], "Dentist");
});

test("rankLinks prefers contact, services and FAQ over blog and legal", () => {
  const links = ["/blog/post-1", "/kontakt", "/datenschutz", "/leistungen", "/agb", "/faq", "/ueber-uns", "/kontakt/"].map((p) => ({ url: "https://x.de" + p, text: "" }));
  const ranked = rankLinks(links, "https://x.de/").map((l) => new URL(l.url).pathname);
  assert.equal(ranked[0], "/kontakt");
  assert.deepEqual(ranked.slice(1, 3).sort(), ["/faq", "/leistungen"]);
  assert.ok(ranked.includes("/leistungen") && ranked.includes("/ueber-uns"));
  assert.ok(!ranked.includes("/blog/post-1") && !ranked.includes("/datenschutz") && !ranked.includes("/agb"));
});

function fakeSite(pages) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const p = pages[url];
    if (!p) return new Response("nope", { status: 404, headers: { "content-type": "text/html" } });
    if (p.redirect) return new Response(null, { status: 301, headers: { location: p.redirect } });
    return new Response(p, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
  };
  return { fetchImpl, calls };
}
const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];

test("crawlSite reads the start page and the best subpages", async () => {
  const nav = `<a href="/kontakt">Kontakt</a><a href="/preise">Preise</a><a href="/blog">Blog</a><a href="/datenschutz">Datenschutz</a>`;
  const { fetchImpl, calls } = fakeSite({
    "https://shop.de/": `<title>Shop</title><meta name="theme-color" content="#123456">${nav}<p>Wir verkaufen Tee aus Darjeeling und Assam seit 1998.</p>`,
    "https://shop.de/kontakt": `<title>Kontakt</title>${nav}<p>Telefon 030 1234, Mo–Fr 9–18 Uhr</p>`,
    "https://shop.de/preise": `<title>Preise</title>${nav}<p>100 g ab 6,90 €</p>`,
  });
  const events = [];
  const site = await crawlSite("shop.de", { fetchImpl, lookup: publicLookup, onProgress: (e) => events.push(e) });
  assert.equal(site.pages.length, 3);
  assert.equal(site.meta.themeColor, "#123456");
  assert.equal(site.meta.privacyUrl, "https://shop.de/datenschutz");
  assert.ok(!calls.includes("https://shop.de/blog"), "blog is skipped");
  assert.ok(!calls.includes("https://shop.de/datenschutz"), "privacy page is linked, not read");
  assert.match(site.pages.map((p) => p.text).join("\n"), /6,90 €/);
  assert.equal(events.filter((e) => e.type === "page").length, 3);
});

test("fetchPage refuses internal hosts and redirects into them", async () => {
  await assert.rejects(fetchPage("http://localhost/", { lookup: publicLookup }), CrawlError);
  const privateLookup = async () => [{ address: "10.0.0.5", family: 4 }];
  await assert.rejects(fetchPage("https://intern.firma.de/", { lookup: privateLookup }), /Interne Adressen/);

  const { fetchImpl } = fakeSite({ "https://evil.de/": { redirect: "http://169.254.169.254/latest/meta-data" } });
  await assert.rejects(fetchPage("https://evil.de/", { fetchImpl, lookup: publicLookup }), /Interne Adressen/);
});

test("fetchPage rejects non-HTML responses", async () => {
  const fetchImpl = async () => new Response("%PDF", { status: 200, headers: { "content-type": "application/pdf" } });
  await assert.rejects(fetchPage("https://x.de/a", { fetchImpl, lookup: publicLookup }), /keine Webseite/);
});

test("findLogo prefers an image called logo, then the touch icon", async () => {
  const { findLogo } = await import("../src/crawl.js");
  const base = new URL("https://fahrschule.de/");
  assert.equal(findLogo('<img src="/hero.jpg"><a href="/"><img class="site-logo" src="/img/logo.svg" alt="Fahrschule"></a>', base), "https://fahrschule.de/img/logo.svg");
  assert.equal(findLogo('<img src="data:image/png;base64,xx" alt="logo"><link rel="apple-touch-icon" href="/apple.png">', base), "https://fahrschule.de/apple.png");
  assert.equal(findLogo('<img src="/hero.jpg">', base), "");
  assert.equal(findLogo('<img alt="Logo" src="javascript:alert(1)">', base), "");
});
