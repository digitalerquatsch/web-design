// "Deine Website": a public agency page at /s/<slug>, built from a few
// settings. Everything is rendered on the server with every value escaped;
// the page itself runs no script except the optional chat widget.
export const NICHES = {
  allgemein: { label: "Allgemein", who: "lokale Unternehmen", pain: "Anfragen, die nachts und am Wochenende liegen bleiben", q: "Was kostet ein Assistent für meine Website?" },
  handwerk: { label: "Handwerk", who: "Handwerksbetriebe", pain: "Anfragen für Angebote, die zwischen Baustelle und Büro untergehen", q: "Kann der Assistent Anfragen für Angebote aufnehmen?" },
  praxen: { label: "Praxen & Gesundheit", who: "Praxen und Gesundheitsberufe", pain: "Terminanfragen am Telefon, die den Empfang blockieren", q: "Kann der Assistent Terminanfragen aufnehmen?" },
  auto: { label: "Autohaus & Werkstatt", who: "Autohäuser und Werkstätten", pain: "Fragen zu Terminen, Preisen und Fahrzeugen außerhalb der Öffnungszeiten", q: "Kann der Assistent Werkstatttermine vorbereiten?" },
  immobilien: { label: "Immobilien", who: "Makler und Hausverwaltungen", pain: "Interessenten, die auf Antworten zu Exposés warten", q: "Kann der Assistent Interessenten vorqualifizieren?" },
  gastro: { label: "Gastro & Hotel", who: "Restaurants und Hotels", pain: "Reservierungen und Fragen zu Öffnungszeiten, Karte und Zimmern", q: "Kann der Assistent Reservierungen annehmen?" },
  beauty: { label: "Beauty & Friseur", who: "Salons und Studios", pain: "Terminanfragen, die während der Behandlung nicht beantwortet werden können", q: "Kann der Assistent Termine vorschlagen?" },
  beratung: { label: "Beratung & Kanzlei", who: "Berater, Steuerbüros und Kanzleien", pain: "Erstanfragen, die erst qualifiziert werden müssen", q: "Wie geht der Assistent mit vertraulichen Anliegen um?" },
};
export const COUNTRIES = { DE: "Deutschland", AT: "Österreich", CH: "Schweiz" };
export const STYLES = ["signature", "editorial"];
export const SLUG = /^[a-z0-9](?:[a-z0-9-]{1,38})[a-z0-9]$/;
const RESERVED = new Set(["api", "admin", "login", "demo", "static", "assets", "www", "app", "d"]);
export const MAX_IMAGE = 400_000;

const clip = (v, n) => String(v ?? "").trim().slice(0, n);
export class SiteError extends Error {}

export const PLACEHOLDER = /\[[^\]]*ergänzen\]/i;

export function decodeImage(dataUrl) {
  const m = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ""));
  if (!m) throw new SiteError("Nur PNG, JPEG oder WebP sind erlaubt.");
  const buf = Buffer.from(m[2], "base64");
  if (buf.length > MAX_IMAGE) throw new SiteError("Das Bild ist zu groß (höchstens 400 KB).");
  const ok = m[1] === "image/png" ? buf.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    : m[1] === "image/jpeg" ? buf[0] === 0xff && buf[1] === 0xd8
    : buf.subarray(0, 4).toString() === "RIFF" && buf.subarray(8, 12).toString() === "WEBP";
  if (!ok) throw new SiteError("Die Datei ist kein gültiges Bild.");
  return { mime: m[1], buf };
}

// Strips fields the client must not set. `prev` keeps stored images unless a new one (or null) is sent.
export function sanitizeSite(input, prev = {}) {
  const i = input || {};
  const s = {
    id: prev.id, slug: prev.slug || "", online: false,
    niche: NICHES[i.niche] ? i.niche : (prev.niche || "allgemein"),
    style: STYLES.includes(i.style) ? i.style : (prev.style || "signature"),
    theme: i.theme === "hell" ? "hell" : i.theme === "dunkel" ? "dark" : (i.theme === "dark" || i.theme === "light" ? i.theme : (prev.theme || "dark")),
    color: /^#[0-9a-f]{6}$/i.test(i.color || "") ? i.color : (prev.color || "#ff2e93"),
    showIntegrations: i.showIntegrations !== undefined ? i.showIntegrations !== false : prev.showIntegrations !== false,
    logoSize: ["klein", "mittel", "gross"].includes(i.logoSize) ? i.logoSize : (prev.logoSize || "mittel"),
    country: COUNTRIES[i.country] ? i.country : (prev.country || "DE"),
    agencyName: clip(i.agencyName ?? prev.agencyName, 80), city: clip(i.city ?? prev.city, 80),
    email: clip(i.email ?? prev.email, 120), phone: clip(i.phone ?? prev.phone, 40),
    ctaText: clip(i.ctaText ?? prev.ctaText, 40) || "Kostenloses Erstgespräch",
    bookingUrl: clip(i.bookingUrl ?? prev.bookingUrl, 300),
    aboutEyebrow: clip(i.aboutEyebrow ?? prev.aboutEyebrow, 40), aboutHeading: clip(i.aboutHeading ?? prev.aboutHeading, 100), aboutText: clip(i.aboutText ?? prev.aboutText, 3000),
    imprint: String(i.imprint ?? prev.imprint ?? "").slice(0, 8000), privacy: String(i.privacy ?? prev.privacy ?? "").slice(0, 20000),
    agentId: clip(i.agentId ?? prev.agentId, 40),
    logo: prev.logo || null, photo: prev.photo || null, updatedAt: Date.now(),
  };
  if (s.email && !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(s.email)) throw new SiteError("Bitte eine gültige E-Mail-Adresse angeben.");
  if (s.bookingUrl && !/^https:\/\/[^\s"'<>]+$/i.test(s.bookingUrl)) throw new SiteError("Der Terminlink muss mit https:// beginnen.");
  for (const k of ["logo", "photo"]) {
    if (!(k in i)) continue;
    if (i[k] === null) { s[k] = null; continue; }
    if (typeof i[k] === "string" && i[k].startsWith("data:")) { const { mime, buf } = decodeImage(i[k]); s[k] = { mime, b64: buf.toString("base64") }; }
  }
  if (i.slug !== undefined) {
    const slug = clip(i.slug, 40).toLowerCase();
    if (!SLUG.test(slug) || RESERVED.has(slug)) throw new SiteError("Die Adresse darf 3 bis 40 Zeichen haben: Kleinbuchstaben, Ziffern und Bindestriche.");
    s.slug = slug;
  }
  return s;
}

export function readiness(s) {
  const missing = [];
  if (!s.slug) missing.push("Adresse");
  if (!s.agencyName) missing.push("Name der Agentur");
  if (!s.email) missing.push("E-Mail");
  if (!s.imprint.trim()) missing.push("Impressum");
  else if (PLACEHOLDER.test(s.imprint)) missing.push("Impressum (Platzhalter ausfüllen)");
  if (!s.privacy.trim()) missing.push("Datenschutzerklärung");
  else if (PLACEHOLDER.test(s.privacy)) missing.push("Datenschutzerklärung (Platzhalter ausfüllen)");
  return missing;
}

/* ---------- legal drafts: starting points, not legal advice ---------- */
export function legalDrafts(s) {
  const law = { DE: "§ 5 DDG", AT: "§ 5 ECG und § 14 UGB", CH: "Art. 3 Abs. 1 lit. s UWG" }[s.country] || "§ 5 DDG";
  const law2 = { DE: "DSGVO", AT: "DSGVO und DSG", CH: "DSG (und, soweit anwendbar, DSGVO)" }[s.country] || "DSGVO";
  const imprint = [
    `Angaben gemäß ${law}`, "",
    s.agencyName || "[Name oder Firma ergänzen]",
    "[Straße und Hausnummer ergänzen]",
    `[PLZ ergänzen] ${s.city || "[Ort ergänzen]"}`, "",
    "Kontakt", s.email ? `E-Mail: ${s.email}` : "E-Mail: [E-Mail ergänzen]", s.phone ? `Telefon: ${s.phone}` : "", "",
    "Umsatzsteuer-ID (falls vorhanden): [USt-IdNr. ergänzen]", "",
    "Dieser Text ist ein Entwurf und ersetzt keine Rechtsberatung. Bitte prüfe ihn und passe ihn an deine Situation an.",
  ].filter((l, i, a) => l !== "" || a[i - 1] !== "").join("\n");
  const privacy = [
    "Datenschutzerklärung", "",
    "Verantwortlich", `${s.agencyName || "[Name ergänzen]"}, ${s.city || "[Ort ergänzen]"}, ${s.email || "[E-Mail ergänzen]"}`, "",
    "Hosting und Server-Logdateien",
    "Beim Aufruf dieser Seite verarbeitet der Server technisch notwendige Daten (IP-Adresse, Zeitpunkt, aufgerufene Seite). Sie dienen dem sicheren Betrieb der Seite und werden nach kurzer Zeit gelöscht.", "",
    "Kontaktaufnahme",
    "Wenn du uns per E-Mail, Telefon oder über einen Terminlink kontaktierst, verarbeiten wir deine Angaben, um dein Anliegen zu bearbeiten.", "",
    "Chat-Assistent",
    "Falls auf dieser Seite ein KI-Assistent eingebunden ist: Deine Nachrichten werden zur Beantwortung an einen KI-Dienst (Mistral AI, Frankreich) übermittelt. Du chattest mit einer künstlichen Intelligenz, nicht mit einem Menschen. Gib keine sensiblen Daten ein.", "",
    "Deine Rechte",
    `Nach ${law2} hast du Rechte auf Auskunft, Berichtigung, Löschung, Einschränkung, Widerspruch und Datenübertragbarkeit. Du kannst dich außerdem bei einer Datenschutzaufsichtsbehörde beschweren.`, "",
    "Dieser Text ist ein Entwurf und ersetzt keine Rechtsberatung. Ergänze Dienste, die du zusätzlich einbindest (zum Beispiel einen Terminkalender-Anbieter).",
  ].join("\n");
  return { imprint, privacy };
}

/* ---------- rendering ---------- */
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const para = (t) => String(t || "").split(/\n{2,}/).map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`).join("");
function inkOn(hex) {
  const n = parseInt(hex.slice(1), 16), r = n >> 16 & 255, g = n >> 8 & 255, b = n & 255;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.6 ? "#111111" : "#ffffff";
}

const TOOLS = ["E-Mail", "Slack", "Telegram", "Discord", "Zapier", "Make", "n8n", "Kalender"];

function copy(s) {
  const n = NICHES[s.niche] || NICHES.allgemein;
  const a = s.agencyName || "Wir";
  return {
    h1: `Ein KI-Assistent, der für ${n.who} Anfragen beantwortet`,
    sub: `${a} baut Chat- und Telefon-Assistenten für ${n.who}: rund um die Uhr, freundlich und mit dem Wissen deines Unternehmens. Typisch dafür: ${n.pain}.`,
    benefits: [["Immer erreichbar", "Antworten in Sekunden, auch abends und am Wochenende."], ["Aus deiner Website gebaut", "Der Assistent lernt aus deinen Seiten und bleibt bei deinen Fakten."], ["Kontakte landen bei dir", "Anfragen und Terminwünsche kommen per E-Mail, Slack oder Telegram an."]],
    steps: [["Gespräch", "Wir klären, was dein Assistent können soll."], ["Aufbau", "Ich baue ihn aus deiner Website und teste ihn mit dir."], ["Live", "Eine Zeile Code, und er ist auf deiner Seite."]],
    faq: [[n.q, "Ja. Im Erstgespräch zeige ich dir, wie das für dein Unternehmen aussieht."], ["Wo liegen die Daten?", "Die Seite und die KI laufen in Europa. Der Assistent weist Besucher darauf hin, dass sie mit einer KI sprechen."], ["Wie lange dauert der Start?", "Meist wenige Tage, die Basis steht oft schon im Erstgespräch."], ["Kann ich den Assistenten selbst ändern?", "Ja, Wissen, Ton und Regeln lassen sich jederzeit im Browser anpassen."]],
  };
}

export function renderSite(s, { agent = null } = {}) {
  const c = copy(s);
  const dark = s.theme !== "light";
  const ink = inkOn(s.color);
  const ed = s.style === "editorial";
  const logoH = { klein: 28, mittel: 40, gross: 56 }[s.logoSize] || 40;
  const cta = s.bookingUrl || (s.email ? `mailto:${s.email}` : "#");
  const base = `/s/${s.slug}`;
  const css = `
:root{--bg:${dark ? "#0d0b12" : "#fbfaf8"};--card:${dark ? "#171320" : "#ffffff"};--ink:${dark ? "#f4eef8" : "#17141c"};--muted:${dark ? "#a99db5" : "#5f5868"};--line:${dark ? "#2c2538" : "#e4dfe8"};--accent:${s.color};--on:${ink};color-scheme:${dark ? "dark" : "light"}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 ${ed ? 'Georgia,"Times New Roman",serif' : 'system-ui,-apple-system,"Segoe UI",Roboto,sans-serif'}}
${!ed && dark ? "body{background:radial-gradient(900px 420px at 10% -10%,color-mix(in srgb,var(--accent) 22%,transparent),transparent 60%),var(--bg)}" : ""}
a{color:inherit}.wrap{max-width:${ed ? 760 : 1040}px;margin:0 auto;padding:0 20px}
header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:18px 0}
.brand{display:flex;align-items:center;gap:10px;font-weight:700;text-decoration:none}.brand img{height:${logoH}px;width:auto;max-width:180px;object-fit:contain}
.btn{display:inline-block;padding:12px 20px;border-radius:${ed ? "4px" : "999px"};background:var(--accent);color:var(--on);font:600 15px system-ui,sans-serif;text-decoration:none}
.btn.ghost{background:transparent;color:var(--ink);border:1px solid var(--line)}
.hero{padding:${ed ? "48px" : "64px"} 0 40px;${ed ? "" : "text-align:center"}}.hero h1{font-size:clamp(30px,6vw,${ed ? 44 : 54}px);line-height:1.12;margin:0 0 16px;${ed ? "font-weight:400" : ""}}
.hero p{color:var(--muted);font-size:18px;max-width:640px;${ed ? "" : "margin:0 auto 24px"}}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:16px}
.card{${ed ? "border-top:1px solid var(--line);padding:16px 0" : "background:var(--card);border:1px solid var(--line);border-radius:20px;padding:22px"}}.card h3{margin:0 0 6px;font-size:18px}.card p{margin:0;color:var(--muted)}
section{padding:36px 0}h2{font-size:26px;margin:0 0 18px;${ed ? "font-weight:400" : ""}}
.eyebrow{display:block;color:var(--accent);font:600 13px system-ui,sans-serif;letter-spacing:.06em;text-transform:uppercase;margin-bottom:6px}
.tools{display:flex;flex-wrap:wrap;gap:8px}.tools span{padding:6px 14px;border:1px solid var(--line);border-radius:999px;color:var(--muted);font:14px system-ui,sans-serif}
.about{display:grid;gap:20px;${s.photo ? "grid-template-columns:minmax(0,200px) 1fr;align-items:start" : ""}}.about img{width:100%;border-radius:${ed ? "4px" : "20px"};display:block}
@media(max-width:560px){.about{grid-template-columns:1fr}}@media(max-width:480px){header .btn{display:none}}
details{border-bottom:1px solid var(--line);padding:14px 0}summary{cursor:pointer;font-weight:600}details p{color:var(--muted);margin:8px 0 0}
.cta{text-align:center;padding:48px 0}footer{border-top:1px solid var(--line);padding:22px 0 40px;color:var(--muted);font:14px system-ui,sans-serif;display:flex;flex-wrap:wrap;gap:14px;justify-content:space-between}`;
  const head = `<header><a class="brand" href="${base}">${s.logo ? `<img src="${base}/logo" alt="">` : ""}<span>${esc(s.agencyName)}</span></a><a class="btn" href="${esc(cta)}">${esc(s.ctaText)}</a></header>`;
  const body = `${head}
<main><div class="hero"><h1>${esc(c.h1)}</h1><p>${esc(c.sub)}</p><a class="btn" href="${esc(cta)}">${esc(s.ctaText)}</a></div>
<section><div class="grid">${c.benefits.map(([t, d]) => `<div class="card"><h3>${esc(t)}</h3><p>${esc(d)}</p></div>`).join("")}</div></section>
<section><h2>So läuft es ab</h2><div class="grid">${c.steps.map(([t, d], i) => `<div class="card"><h3>${i + 1}. ${esc(t)}</h3><p>${esc(d)}</p></div>`).join("")}</div></section>
${s.showIntegrations ? `<section><h2>Verbindet sich mit deinen Werkzeugen</h2><div class="tools">${TOOLS.map((t) => `<span>${esc(t)}</span>`).join("")}</div></section>` : ""}
${s.aboutText.trim() ? `<section><div class="about">${s.photo ? `<img src="${base}/foto" alt="">` : ""}<div>${s.aboutEyebrow ? `<span class="eyebrow">${esc(s.aboutEyebrow)}</span>` : ""}<h2>${esc(s.aboutHeading || `Wer hinter ${s.agencyName} steht`)}</h2>${para(s.aboutText)}</div></div></section>` : ""}
<section><h2>Häufige Fragen</h2>${c.faq.map(([q, a]) => `<details><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join("")}</section>
<div class="cta"><h2>Bereit für den ersten Assistenten?</h2><a class="btn" href="${esc(cta)}">${esc(s.ctaText)}</a></div></main>
<footer><span>© ${new Date().getFullYear()} ${esc(s.agencyName)}${s.city ? `, ${esc(s.city)}` : ""}</span><span><a href="${base}/impressum">Impressum</a> · <a href="${base}/datenschutz">Datenschutz</a></span></footer>`;
  const widget = agent ? `<script src="/widget.js" data-agent="${esc(agent.id)}" defer></script>` : "";
  return shell(s, `<div class="wrap">${body}</div>${widget}`, css, `${s.agencyName} – KI-Assistenten für ${(NICHES[s.niche] || NICHES.allgemein).who}`, c.sub);
}

export function renderLegal(s, kind) {
  const css = `body{margin:0;background:#fbfaf8;color:#17141c;font:16px/1.65 system-ui,sans-serif}main{max-width:720px;margin:0 auto;padding:32px 20px 60px}a{color:#17141c}p{margin:0 0 14px}`;
  const title = kind === "impressum" ? "Impressum" : "Datenschutzerklärung";
  const text = kind === "impressum" ? s.imprint : s.privacy;
  return shell(s, `<main><p><a href="/s/${s.slug}">← ${esc(s.agencyName)}</a></p><h1>${title}</h1>${para(text)}</main>`, css, `${title} – ${s.agencyName}`, "");
}

function shell(s, inner, css, title, description) {
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>${description ? `<meta name="description" content="${esc(description.slice(0, 160))}">` : ""}<meta name="theme-color" content="${esc(s.color)}"><style>${css}</style></head><body>${inner}</body></html>`;
}

export const PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8", "cache-control": "no-cache", "x-content-type-options": "nosniff", "referrer-policy": "strict-origin-when-cross-origin",
  "content-security-policy": "default-src 'none'; img-src 'self' https: data:; style-src 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};
