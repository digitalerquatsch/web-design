// Reads a public website so the analyzer can build an agent from it:
// the start page plus the handful of subpages that usually hold what a
// chatbot needs (contact, imprint, services, prices, FAQ, about).
//
// Every request goes through assertPublicHost, so a URL typed into the
// builder cannot make the server fetch localhost or the internal network.
// Redirects are followed by hand for the same reason.

import dns from "node:dns/promises";
import net from "node:net";

export class CrawlError extends Error {}

const USER_AGENT = "AgentenwerkBot/0.1 (+chatbot builder; reads public pages once on request)";
const SKIP_EXT = /\.(pdf|jpe?g|png|gif|webp|svg|ico|zip|rar|gz|mp4|mp3|mov|avi|docx?|xlsx?|pptx?|css|js|json|xml|rss|atom|woff2?|ttf|eot)$/i;

export function normalizeUrl(input) {
  let s = String(input ?? "").trim();
  if (!s) throw new CrawlError("Bitte eine Website-Adresse eingeben.");
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = "https://" + s;
  let u;
  try { u = new URL(s); } catch { throw new CrawlError("Das ist keine gültige Website-Adresse."); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new CrawlError("Nur http- und https-Adressen sind erlaubt.");
  if (u.username || u.password) throw new CrawlError("Adressen mit Zugangsdaten sind nicht erlaubt.");
  if (u.port && u.port !== "80" && u.port !== "443") throw new CrawlError("Nur die Standard-Ports 80 und 443 sind erlaubt.");
  if (!u.hostname.includes(".") && !net.isIP(u.hostname.replace(/^\[|\]$/g, ""))) throw new CrawlError("Bitte eine vollständige Domain angeben, z. B. beispiel.de.");
  u.hash = "";
  return u;
}

function ipv4ToInt(ip) {
  return ip.split(".").reduce((n, p) => (n << 8) + Number(p), 0) >>> 0;
}
const V4_BLOCKED = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
].map(([base, bits]) => [ipv4ToInt(base), bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0]);

export function isPrivateAddress(ip) {
  const addr = String(ip).replace(/^\[|\]$/g, "").toLowerCase();
  if (net.isIPv4(addr)) {
    const n = ipv4ToInt(addr);
    return V4_BLOCKED.some(([base, mask]) => ((n & mask) >>> 0) === base);
  }
  if (net.isIPv6(addr)) {
    if (addr === "::" || addr === "::1") return true;
    const mapped = addr.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    if (/^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(addr)) return true; // mapped v4 in hex form
    const first = parseInt(addr.split(":")[0] || "0", 16);
    if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
    if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link local
    if ((first & 0xff00) === 0xff00) return true; // multicast
    if (addr.startsWith("64:ff9b:") || addr.startsWith("2001:db8:")) return true;
    return false;
  }
  return true; // not an IP at all: refuse rather than guess
}

export async function assertPublicHost(hostname, lookup = dns.lookup) {
  const host = hostname.replace(/^\[|\]$/g, "");
  if (/^localhost$|\.localhost$|\.local$|\.internal$/i.test(host)) throw new CrawlError("Interne Adressen können nicht eingelesen werden.");
  const addrs = net.isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => {
    throw new CrawlError(`Die Domain ${host} wurde nicht gefunden.`);
  });
  if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) throw new CrawlError("Interne Adressen können nicht eingelesen werden.");
}

function charsetOf(contentType, bytes) {
  const fromHeader = /charset=["']?([\w-]+)/i.exec(contentType || "");
  if (fromHeader) return fromHeader[1];
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 2048));
  const fromMeta = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head);
  return fromMeta ? fromMeta[1] : "utf-8";
}

async function readCapped(res, maxBytes) {
  if (!res.body) return new Uint8Array(await res.arrayBuffer()).subarray(0, maxBytes);
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  while (total < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  reader.cancel().catch(() => {});
  const out = new Uint8Array(Math.min(total, maxBytes));
  let off = 0;
  for (const c of chunks) {
    const take = Math.min(c.length, out.length - off);
    out.set(c.subarray(0, take), off);
    off += take;
    if (off >= out.length) break;
  }
  return out;
}

export async function fetchPage(url, { fetchImpl = fetch, lookup = dns.lookup, timeoutMs = 12000, maxBytes = 2_000_000, accept = "text/html" } = {}) {
  let current = new URL(url);
  for (let hop = 0; hop < 6; hop++) {
    if (current.protocol !== "http:" && current.protocol !== "https:") throw new CrawlError("Weiterleitung auf ein nicht unterstütztes Protokoll.");
    if (current.port && current.port !== "80" && current.port !== "443") throw new CrawlError("Weiterleitung auf einen nicht erlaubten Port.");
    await assertPublicHost(current.hostname, lookup);
    let res;
    try {
      res = await fetchImpl(current.href, {
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
        headers: { "user-agent": USER_AGENT, accept: `${accept},*/*;q=0.5`, "accept-language": "de,en;q=0.7" },
      });
    } catch (e) {
      if (e?.name === "TimeoutError") throw new CrawlError(`${current.hostname} hat nicht rechtzeitig geantwortet.`);
      throw new CrawlError(`${current.hostname} ist nicht erreichbar.`);
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      current = new URL(res.headers.get("location"), current);
      current.hash = "";
      continue;
    }
    if (!res.ok) throw new CrawlError(`${current.href} antwortet mit Status ${res.status}.`);
    const type = res.headers.get("content-type") || "";
    if (accept === "text/html" && !/html|text\/plain/i.test(type)) throw new CrawlError(`${current.href} ist keine Webseite (${type || "unbekannter Typ"}).`);
    const bytes = await readCapped(res, maxBytes);
    let body;
    try { body = new TextDecoder(charsetOf(type, bytes)).decode(bytes); } catch { body = new TextDecoder("utf-8").decode(bytes); }
    return { url: current.href, body };
  }
  throw new CrawlError("Zu viele Weiterleitungen.");
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", auml: "ä", ouml: "ö", uuml: "ü", Auml: "Ä", Ouml: "Ö", Uuml: "Ü", szlig: "ß", euro: "€", ndash: "–", mdash: "—", hellip: "…", bdquo: "„", ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’", copy: "©", reg: "®", middot: "·", bull: "•", eacute: "é", egrave: "è", agrave: "à", ccedil: "ç" };
export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e] ?? m;
  });
}

export function htmlToText(html) {
  let s = String(html)
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template|iframe|canvas|select|head)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<(h[1-6])\b[^>]*>/gi, "\n\n## ")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<(br|hr)\b[^>]*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|header|footer|main|aside|nav|li|ul|ol|h[1-6]|tr|table|dl|dt|dd|blockquote|address|figure|form|fieldset)\s*>/gi, "\n")
    .replace(/<(td|th)\b[^>]*>/gi, " | ")
    .replace(/<[^>]+>/g, " ");
  s = decodeEntities(s);
  const lines = s.split("\n").map((l) => l.replace(/[ \t ​]+/g, " ").trim()).filter((l) => l && l !== "-" && l !== "##" && !/^[|\s]+$/.test(l));
  const out = [];
  for (const l of lines) if (out[out.length - 1] !== l) out.push(l);
  return out.join("\n");
}

function attr(tag, name) {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return m ? decodeEntities(m[2] ?? m[3] ?? m[4] ?? "") : null;
}
function metaContent(html, key) {
  const re = /<meta\b[^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const n = (attr(m[0], "name") || attr(m[0], "property") || "").toLowerCase();
    if (n === key) return (attr(m[0], "content") || "").trim();
  }
  return "";
}
const sameSite = (a, b) => a.replace(/^www\./, "") === b.replace(/^www\./, "");

export function extractPage(html, pageUrl) {
  const base = new URL(pageUrl);
  const title = decodeEntities((/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] || "").replace(/\s+/g, " ").trim());
  const jsonLd = [];
  const ldRe = /<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = ldRe.exec(html)) && jsonLd.length < 5) {
    try { jsonLd.push(JSON.parse(m[1].trim())); } catch { /* broken JSON-LD is common, skip it */ }
  }
  const links = [];
  const emails = new Set();
  const phones = new Set();
  const aRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  while ((m = aRe.exec(html))) {
    const href = attr(m[1], "href");
    if (!href) continue;
    if (/^mailto:/i.test(href)) { const e = decodeURIComponent(href.slice(7).split("?")[0]).trim(); if (e.includes("@")) emails.add(e); continue; }
    if (/^tel:/i.test(href)) { const p = decodeURIComponent(href.slice(4)).trim(); if (p.replace(/\D/g, "").length >= 6) phones.add(p); continue; }
    let u;
    try { u = new URL(href, base); } catch { continue; }
    if ((u.protocol !== "http:" && u.protocol !== "https:") || !sameSite(u.hostname, base.hostname) || SKIP_EXT.test(u.pathname)) continue;
    u.hash = "";
    const text = decodeEntities(m[2].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim().slice(0, 80);
    links.push({ url: u.href, text });
  }
  return {
    url: pageUrl,
    title,
    description: metaContent(html, "description") || metaContent(html, "og:description"),
    siteName: metaContent(html, "og:site_name"),
    themeColor: metaContent(html, "theme-color"),
    lang: (attr(/<html\b[^>]*>/i.exec(html)?.[0] || "", "lang") || "").slice(0, 10),
    jsonLd,
    links,
    emails: [...emails],
    phones: [...phones],
    text: htmlToText(html),
  };
}

const LINK_RULES = [
  [/kontakt|contact/, 10],
  [/impressum|imprint|legal-notice|anbieterkennzeichnung/, 9],
  [/faq|haeufige|häufige|fragen|hilfe|help|support/, 8],
  [/leistung|service|angebot|produkt|product|preis|price|pricing|tarif|kosten|menu|speisekarte|karte|sortiment|shop/, 8],
  [/ueber|über|about|wir|team|unternehmen|company|philosophie|geschichte/, 7],
  [/oeffnungszeit|öffnungszeit|anfahrt|standort|location|filiale/, 7],
  [/termin|buchen|booking|reserv|anfrage/, 7],
  [/versand|lieferung|shipping|rueckgabe|rückgabe|retoure|zahlung|payment/, 6],
  [/blog|news|aktuell|presse|karriere|jobs|stellen|login|anmelden|register|warenkorb|cart|checkout|account|konto|agb|cookie|sitemap|tag\/|category|kategorie|author|page\/\d/, -8],
];
const PRIVACY = /datenschutz|privacy|dsgvo|gdpr/;

export function rankLinks(links, homeUrl, limit = 7) {
  const home = new URL(homeUrl);
  const seen = new Set([home.pathname.replace(/\/$/, "") || "/"]);
  const scored = [];
  for (const l of links) {
    const u = new URL(l.url);
    const key = u.pathname.replace(/\/$/, "") || "/";
    if (seen.has(key) || u.search.length > 40) continue;
    seen.add(key);
    const hay = (decodeURIComponent(u.pathname) + " " + l.text).toLowerCase();
    if (PRIVACY.test(hay)) continue;
    let score = 0;
    for (const [re, pts] of LINK_RULES) if (re.test(hay)) score += pts;
    const depth = key.split("/").filter(Boolean).length;
    score += Math.max(0, 3 - depth);
    if (score > 0) scored.push({ ...l, score });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}

export function findPrivacyUrl(links) {
  return links.find((l) => PRIVACY.test((decodeURIComponent(new URL(l.url).pathname) + " " + l.text).toLowerCase()))?.url || "";
}

export function sitemapLinks(xml, homeUrl) {
  const home = new URL(homeUrl);
  const out = [];
  const re = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;
  let m;
  while ((m = re.exec(xml)) && out.length < 500) {
    try {
      const u = new URL(decodeEntities(m[1]));
      if (sameSite(u.hostname, home.hostname) && !SKIP_EXT.test(u.pathname)) out.push({ url: u.href, text: "" });
    } catch { /* ignore */ }
  }
  return out;
}

// Lines that repeat on most pages are navigation, cookie banners and
// footers. Keep them once (the start page) and drop them elsewhere.
function dropBoilerplate(pages) {
  if (pages.length < 3) return pages;
  const counts = new Map();
  for (const p of pages) for (const l of new Set(p.text.split("\n"))) counts.set(l, (counts.get(l) || 0) + 1);
  const threshold = Math.max(3, Math.ceil(pages.length * 0.6));
  return pages.map((p, i) => i === 0 ? p : { ...p, text: p.text.split("\n").filter((l) => (counts.get(l) || 0) < threshold).join("\n") });
}

export async function crawlSite(input, { maxPages = 8, perPageChars = 12000, totalChars = 70000, onProgress = () => {}, fetchImpl = fetch, lookup = dns.lookup } = {}) {
  const start = normalizeUrl(input);
  const opts = { fetchImpl, lookup };
  onProgress({ type: "status", message: `Lade ${start.hostname} …` });
  const first = await fetchPage(start.href, opts);
  const home = extractPage(first.body, first.url);
  onProgress({ type: "page", url: home.url, title: home.title || home.url });

  let candidates = rankLinks(home.links, home.url, maxPages - 1);
  let privacyUrl = findPrivacyUrl(home.links);
  if (candidates.length < 3) {
    try {
      const sm = await fetchPage(new URL("/sitemap.xml", home.url).href, { ...opts, accept: "application/xml", maxBytes: 1_000_000 });
      const extra = rankLinks([...home.links, ...sitemapLinks(sm.body, home.url)], home.url, maxPages - 1);
      if (extra.length > candidates.length) candidates = extra;
    } catch { /* no sitemap, fine */ }
  }
  if (candidates.length) onProgress({ type: "status", message: `${candidates.length} passende Unterseiten gefunden …` });

  const pages = [home];
  const failed = [];
  const queue = candidates.slice();
  async function worker() {
    while (queue.length) {
      const c = queue.shift();
      try {
        const r = await fetchPage(c.url, opts);
        const p = extractPage(r.body, r.url);
        if (pages.some((x) => x.url === p.url)) continue;
        pages.push(p);
        if (!privacyUrl) privacyUrl = findPrivacyUrl(p.links);
        onProgress({ type: "page", url: p.url, title: p.title || p.url });
      } catch (e) {
        failed.push({ url: c.url, reason: e instanceof CrawlError ? e.message : "Fehler beim Laden" });
      }
    }
  }
  await Promise.all([worker(), worker(), worker()]);

  const cleaned = dropBoilerplate(pages);
  let budget = totalChars;
  const outPages = [];
  for (const p of cleaned) {
    if (budget <= 0) break;
    const text = p.text.slice(0, Math.min(perPageChars, budget));
    budget -= text.length;
    outPages.push({ url: p.url, title: p.title, description: p.description, text });
  }
  return {
    url: home.url,
    pages: outPages,
    failed,
    meta: {
      siteName: home.siteName,
      title: home.title,
      description: home.description,
      themeColor: /^#[0-9a-f]{3,8}$/i.test(home.themeColor) ? home.themeColor : "",
      headings: [...new Set(home.text.split("\n").filter((l) => l.startsWith("## ")).map((l) => l.slice(3).trim()).filter((l) => l.length > 2 && l.length < 90))].slice(0, 6),
      lang: home.lang,
      privacyUrl,
      emails: [...new Set(pages.flatMap((p) => p.emails))].slice(0, 5),
      phones: [...new Set(pages.flatMap((p) => p.phones))].slice(0, 5),
      jsonLd: JSON.stringify(pages.flatMap((p) => p.jsonLd)).slice(0, 6000),
    },
  };
}
