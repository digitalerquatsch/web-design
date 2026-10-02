// Integration symbols: simple pictograms in the brand colors, drawn here
// (no third-party requests). To use the original artwork, drop an SVG named
// like the key into public/logos/ (e.g. logos/gmail.svg); it takes over.

const NS = "http://www.w3.org/2000/svg";

// bg: tile color, fg: glyph color, draw: svg children as [tag, attrs]
const stroke = { fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round" };
export const BRANDS = {
  gmail: { label: "Gmail", bg: "#ffffff", fg: "#ea4335", draw: [["path", { d: "M3 7l9 6 9-6", ...stroke }], ["path", { d: "M3 7v10h4V10.5M21 7v10h-4V10.5", ...stroke }]] },
  kalender: { label: "Google Kalender", bg: "#4285f4", fg: "#fff", draw: [["rect", { x: "4", y: "5", width: "16", height: "15", rx: "2", ...stroke }], ["path", { d: "M4 10h16M9 3v4M15 3v4", ...stroke }], ["path", { d: "M9 15l2 2 4-4", ...stroke }]] },
  sheets: { label: "Google Sheets", bg: "#0f9d58", fg: "#fff", draw: [["rect", { x: "5", y: "4", width: "14", height: "16", rx: "2", ...stroke }], ["path", { d: "M5 10h14M5 15h14M11 10v10", ...stroke }]] },
  whatsapp: { label: "WhatsApp", bg: "#25d366", fg: "#fff", draw: [["path", { d: "M4 20l1.2-4A8 8 0 1 1 8 18.8L4 20z", ...stroke }], ["path", { d: "M9.5 9.5c.5 2 2 3.5 4 4l1-1 1.5.8-.4 1.2c-2.5.7-6-2.3-6.7-5.3l1.2-.4.8 1.5z", fill: "currentColor", stroke: "none" }]] },
  telegram: { label: "Telegram", bg: "#229ed9", fg: "#fff", draw: [["path", { d: "M20 4L3 11l6 2.5L11 20l3-4.5 4.5 3.5L20 4z", ...stroke }], ["path", { d: "M9 13.5L20 4", ...stroke }]] },
  slack: { label: "Slack", bg: "#4a154b", fg: "#fff", draw: [["path", { d: "M9 4L7.5 20M16.5 4L15 20M4 9h16M3.5 15h16", ...stroke }]] },
  discord: { label: "Discord", bg: "#5865f2", fg: "#fff", draw: [["path", { d: "M6 7c2-1 4-1.5 6-1.5S16 6 18 7c1.5 3 2 6 1.5 9-1.5 1-3 1.7-4.5 2l-1-2c-1.5.4-3.5.4-5 0l-1 2c-1.5-.3-3-1-4.5-2C4 13 4.5 10 6 7z", ...stroke }], ["circle", { cx: "9.5", cy: "12", r: "1.2", fill: "currentColor" }], ["circle", { cx: "14.5", cy: "12", r: "1.2", fill: "currentColor" }]] },
  hubspot: { label: "HubSpot", bg: "#ff7a59", fg: "#fff", draw: [["circle", { cx: "13", cy: "13", r: "3.5", ...stroke }], ["path", { d: "M13 9.5V5M10 10L6.5 7M16 15l3 2.5", ...stroke }], ["circle", { cx: "13", cy: "4", r: "1.3", fill: "currentColor" }], ["circle", { cx: "6", cy: "6.5", r: "1.3", fill: "currentColor" }]] },
  notion: { label: "Notion", bg: "#ffffff", fg: "#111111", draw: [["rect", { x: "4.5", y: "4.5", width: "15", height: "15", rx: "2", ...stroke }], ["path", { d: "M9 16V8l6 8V8", ...stroke }]] },
  zapier: { label: "Zapier", bg: "#ff4f00", fg: "#fff", draw: [["path", { d: "M12 4v16M4 12h16M6.3 6.3l11.4 11.4M17.7 6.3L6.3 17.7", ...stroke }]] },
  make: { label: "Make", bg: "#6d00cc", fg: "#fff", draw: [["path", { d: "M5 18V7l3.5 6L12 7v11M14 18l2-11M19 18l-2-11", ...stroke }]] },
  n8n: { label: "n8n", bg: "#ea4b71", fg: "#fff", draw: [["circle", { cx: "6", cy: "12", r: "2.2", ...stroke }], ["circle", { cx: "18", cy: "7", r: "2.2", ...stroke }], ["circle", { cx: "18", cy: "17", r: "2.2", ...stroke }], ["path", { d: "M8 11.3l8-3.4M8 12.7l8 3.4", ...stroke }]] },
  email: { label: "E-Mail", bg: "#6b7280", fg: "#fff", draw: [["rect", { x: "3", y: "6", width: "18", height: "12", rx: "2", ...stroke }], ["path", { d: "M3 8l9 6 9-6", ...stroke }]] },
  webhook: { label: "Webhook", bg: "#374151", fg: "#fff", draw: [["path", { d: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1", ...stroke }]] },
};

const ALIASES = { "google kalender": "kalender", "google calendar": "kalender", "google sheets": "sheets", "google tabellen": "sheets", "e-mail": "email", "mail": "email" };
const slug = (s) => String(s || "").trim().toLowerCase();

// Which symbol belongs to an integration: its name first, then its type.
export function brandKey(i) {
  const l = slug(i?.label);
  const k = ALIASES[l] || l;
  if (BRANDS[k]) return k;
  return BRANDS[i?.type] ? i.type : "webhook";
}

export function brandIcon(h, key, size = 24) {
  const b = BRANDS[key] || BRANDS.webhook;
  const wrap = h("span", { class: "brand-ic", title: b.label, style: `width:${size}px;height:${size}px;background:${b.bg};color:${b.fg}` });
  const glyph = () => {
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("width", String(Math.round(size * 0.66))); svg.setAttribute("height", String(Math.round(size * 0.66))); svg.setAttribute("aria-hidden", "true");
    for (const [tag, attrs] of b.draw) { const el = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v); svg.append(el); }
    return svg;
  };
  // Original artwork, if the operator added it; otherwise the drawn symbol.
  const img = h("img", { src: `/logos/${key}.svg`, alt: "", width: String(size), height: String(size), loading: "lazy" });
  img.addEventListener("error", () => wrap.replaceChildren(glyph()));
  img.addEventListener("load", () => { wrap.style.background = "transparent"; });
  wrap.append(img);
  return wrap;
}
