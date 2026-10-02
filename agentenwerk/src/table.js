// Reads the spreadsheet a user uploads to the autopilot: CSV (as exported by
// Excel, Numbers or Google Sheets, any delimiter) or XLSX. XLSX is read with
// a small ZIP reader on node:zlib, so no spreadsheet library is needed.

import zlib from "node:zlib";
import { decodeEntities, normalizeUrl } from "./crawl.js";

export class TableError extends Error {}

/* ---------- CSV ---------- */

function decodeText(buf) {
  let text = new TextDecoder("utf-8").decode(buf);
  // Excel on Windows still writes CSV as Windows-1252.
  if (text.includes("�")) text = new TextDecoder("windows-1252").decode(buf);
  return text.replace(/^﻿/, "");
}

function detectDelimiter(text) {
  const firstLine = text.split(/\r?\n/).find((l) => l.trim()) || "";
  const counts = [";", ",", "\t", "|"].map((d) => [d, firstLine.split(d).length - 1]);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ",";
}

export function parseCsv(text, delimiter = detectDelimiter(text)) {
  const rows = [];
  let row = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += ch;
    } else if (ch === '"' && field === "") quoted = true;
    else if (ch === delimiter) { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += ch;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows.map((r) => r.map((c) => c.trim())).filter((r) => r.some((c) => c));
}

/* ---------- XLSX ---------- */

export function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new TableError("Die Datei ist keine gültige Excel-Datei.");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new TableError("Die Excel-Datei ist beschädigt.");
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    files.set(name, () => {
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + compSize);
      if (method === 0) return data;
      if (method === 8) return zlib.inflateRawSync(data, { maxOutputLength: 50 * 1024 * 1024 });
      throw new TableError("Diese Excel-Datei nutzt ein nicht unterstütztes Format.");
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

const xmlText = (s) => decodeEntities(s.replace(/<[^>]+>/g, ""));

function colIndex(ref) {
  const letters = /^[A-Z]+/.exec(ref)?.[0] || "A";
  let n = 0;
  for (const c of letters) n = n * 26 + (c.charCodeAt(0) - 64);
  return n - 1;
}

export function parseXlsx(buf) {
  const files = readZip(buf);
  const read = (name) => files.get(name)?.().toString("utf8");
  const shared = [];
  const ss = read("xl/sharedStrings.xml");
  if (ss) for (const m of ss.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
    shared.push([...m[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => xmlText(t[1])).join(""));
  }
  // The first sheet in workbook order, falling back to sheet1.xml.
  let sheetPath = "xl/worksheets/sheet1.xml";
  const wb = read("xl/workbook.xml");
  const rels = read("xl/_rels/workbook.xml.rels");
  const firstRid = wb && /<sheet\b[^>]*r:id="([^"]+)"/.exec(wb)?.[1];
  if (firstRid && rels) {
    const target = new RegExp(`<Relationship\\b[^>]*Id="${firstRid}"[^>]*Target="([^"]+)"`).exec(rels)?.[1]
      || new RegExp(`<Relationship\\b[^>]*Target="([^"]+)"[^>]*Id="${firstRid}"`).exec(rels)?.[1];
    if (target) sheetPath = target.startsWith("/") ? target.slice(1) : "xl/" + target.replace(/^\.\//, "");
  }
  const sheet = read(sheetPath);
  if (!sheet) throw new TableError("In der Excel-Datei wurde kein Tabellenblatt gefunden.");
  const rows = [];
  for (const r of sheet.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const row = [];
    for (const c of r[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[1];
      const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1];
      const type = /\bt="(\w+)"/.exec(attrs)?.[1];
      const inner = c[2] || "";
      let val = "";
      if (type === "s") val = shared[Number(/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1])] ?? "";
      else if (type === "inlineStr") val = xmlText(/<is>([\s\S]*?)<\/is>/.exec(inner)?.[1] || "");
      else val = xmlText(/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] || "");
      row[ref ? colIndex(ref) : row.length] = val.trim();
    }
    rows.push(Array.from(row, (v) => v ?? ""));
  }
  return rows.filter((r) => r.some((c) => c));
}

export function parseTable(buf, filename = "") {
  if (!buf?.length) throw new TableError("Die Datei ist leer.");
  const isZip = buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50;
  if (isZip || /\.xlsx$/i.test(filename)) return parseXlsx(buf);
  if (/\.xls$/i.test(filename)) throw new TableError("Alte .xls-Dateien werden nicht unterstützt. Bitte als .xlsx oder .csv speichern.");
  return parseCsv(decodeText(buf));
}

/* ---------- column mapping ---------- */

const COLUMNS = {
  url: /^(website|webseite|url|domain|homepage|web|internetseite|internet|seite|link)$/,
  company: /^(firma|unternehmen|company|firmenname|name|kunde|betrieb|praxis|geschäft|geschaeft|organisation|organization)$/,
  email: /^(e-?mail|mail|email-adresse|e-mail-adresse)$/,
  contact: /^(ansprechpartner|ansprechpartnerin|kontakt|kontaktperson|contact|person|inhaber|inhaberin|vorname nachname)$/,
  phone: /^(telefon|tel|phone|telefonnummer|mobil|handy)$/,
  city: /^(ort|stadt|city|standort)$/,
};
const looksLikeUrl = (s) => /^(https?:\/\/)?([\w-]+\.)+[a-z]{2,}(\/\S*)?$/i.test(String(s).trim()) && !String(s).includes("@");

export function mapRows(rows, { maxRows = 200 } = {}) {
  if (!rows.length) throw new TableError("In der Tabelle stehen keine Zeilen.");
  const header = rows[0].map((h) => h.toLowerCase().replace(/[:*]/g, "").trim());
  const cols = {};
  header.forEach((h, i) => { for (const [key, re] of Object.entries(COLUMNS)) if (cols[key] == null && re.test(h)) cols[key] = i; });
  let body = rows.slice(1);
  if (cols.url == null) {
    // No recognizable header: find the column that holds URLs and treat every row as data.
    const width = Math.max(...rows.map((r) => r.length));
    let best = -1, bestHits = 0;
    for (let i = 0; i < width; i++) {
      const hits = rows.filter((r) => looksLikeUrl(r[i] || "")).length;
      if (hits > bestHits) { best = i; bestHits = hits; }
    }
    if (best < 0) throw new TableError("Keine Spalte mit Website-Adressen gefunden. Nenne die Spalte z. B. „Website“.");
    cols.url = best;
    if (looksLikeUrl(rows[0][best] || "")) body = rows;
  }
  const out = [];
  const seen = new Set();
  const skipped = [];
  for (const r of body) {
    const raw = (r[cols.url] || "").trim();
    if (!raw) continue;
    let url;
    try { url = normalizeUrl(raw); } catch (e) { skipped.push({ value: raw, reason: e.message }); continue; }
    const key = url.hostname.replace(/^www\./, "") + url.pathname.replace(/\/$/, "");
    if (seen.has(key)) { skipped.push({ value: raw, reason: "Doppelt in der Tabelle" }); continue; }
    seen.add(key);
    const get = (k) => (cols[k] != null ? (r[cols[k]] || "").trim().slice(0, 200) : "");
    out.push({ url: url.href, company: get("company"), email: get("email"), contact: get("contact"), phone: get("phone"), city: get("city") });
  }
  if (!out.length) throw new TableError("Keine gültigen Website-Adressen in der Tabelle gefunden.");
  if (out.length > maxRows) throw new TableError(`Die Tabelle hat ${out.length} Websites. Bitte höchstens ${maxRows} pro Durchlauf hochladen.`);
  return { rows: out, skipped, columns: Object.fromEntries(Object.entries(cols).map(([k, i]) => [k, rows[0][i] ?? `Spalte ${i + 1}`])) };
}

export function toCsv(rows) {
  const esc = (v) => {
    let s = String(v ?? "");
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // keep spreadsheet apps from running it as a formula
    return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  // Semicolons and a BOM: what German Excel opens correctly on double-click.
  return "﻿" + rows.map((r) => r.map(esc).join(";")).join("\r\n") + "\r\n";
}
