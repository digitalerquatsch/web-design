// Agentenwerk builder. Talks to the server's admin API; everything that is
// rendered from agent data goes through textContent, never innerHTML.

import { mountAutopilot } from "./autopilot.js";
import { mountAcquisition } from "./acquisition.js";
import { mountUsers } from "./users.js";
import { renderAuth } from "./auth.js";
import { mountHome } from "./home.js";
import { mountAgents } from "./agents.js";
import { icon } from "./icons.js";
import { mountReview } from "./review.js";
import { mountSystem } from "./system.js";
import { mountJarvis } from "./jarvis.js";
import { mountWebsite } from "./website.js";
import { mountCustomers } from "./customers.js";
import { mountAccount, mountMentoring } from "./account.js";
import { TEMPLATES, TONES, GOALS, LEAD_FIELDS, COLORS, fromTemplate, withDefaults, buildPrompt, activePrompt } from "./prompt.js";

/* ---------- helpers ---------- */
const $ = (id) => document.getElementById(id);
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "text") el.textContent = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}
const clone = (o) => JSON.parse(JSON.stringify(o));
const local = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* private mode */ } },
};

/* ---------- API ---------- */
class AuthError extends Error {}
let token = local.get("agentenwerk.token") || "";
function headers() {
  const hd = { "content-type": "application/json", "x-agentenwerk": "1" };
  if (token) hd.authorization = "Bearer " + token;
  return hd;
}
async function failure(res) {
  const j = await res.json().catch(() => ({}));
  if (res.status === 401) { showGate(j.error); throw new AuthError(j.error); }
  if (res.status === 402 && typeof showView === "function") { setTimeout(() => showView("account"), 0); throw new Error(j.error || "Dein Abo ist nicht aktiv."); }
  if (res.status === 403 && /localhost|X-Agentenwerk/.test(j.error || "")) { showGate(j.error); throw new AuthError(j.error); }
  throw new Error(j.error || `Fehler ${res.status}`);
}
async function api(method, path, body) {
  const res = await fetch(path, { method, headers: headers(), body: body === undefined ? undefined : JSON.stringify(body) });
  if (!res.ok) await failure(res);
  return res.status === 204 ? null : res.json();
}
async function apiStream(path, body, onEvent, signal) {
  const res = await fetch(path, { method: "POST", headers: headers(), body: JSON.stringify(body), signal });
  if (!res.ok) await failure(res);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split("\n\n");
    buf = parts.pop();
    for (const chunk of parts) {
      let name = "message", data = "";
      for (const line of chunk.split("\n")) {
        if (line.startsWith("event: ")) name = line.slice(7);
        else if (line.startsWith("data: ")) data += line.slice(6);
      }
      if (data) onEvent(name, JSON.parse(data));
    }
  }
}

/* ---------- state ---------- */
let status = { aiConfigured: true, publicUrl: location.origin };
let agents = [];
let cfg = fromTemplate("blank");     // cfg.id is set once the server has stored it
let section = "basis";
let pendingTemplate = null;
let captured = [];
let conversations = [];
let importState = null;              // { running, log: [], error, result, applied }

/* ---------- login ---------- */
const me = () => status.me || {};
const isKunde = () => me().role === "kunde";
function showGate(message) {
  $("appRoot").hidden = true;
  $("gate").hidden = false;
  renderAuth({
    root: $("gate"), h, message: message === "Bitte anmelden." ? "" : message,
    onSuccess: () => { token = ""; local.set("agentenwerk.token", null); boot(); },
    onToken: (t) => { token = t.trim(); local.set("agentenwerk.token", token || null); boot(); },
  });
}
async function logout() {
  await flush().catch(() => {});
  await fetch("/api/auth/logout", { method: "POST", headers: headers() }).catch(() => {});
  token = ""; local.set("agentenwerk.token", null);
  location.reload();
}
let meOpen = false;
function renderMe() {
  const box = $("meBox");
  const u = me();
  const initials = String(u.name || "?").split(/\s+/).map((x) => x[0]).join("").slice(0, 2).toUpperCase();
  const roleName = { admin: "Admin", team: "Team", kunde: "Kunde" }[u.role] || "";
  const chipBtn = h("button", { type: "button", class: "me-chip", "aria-expanded": String(meOpen), onclick: () => { meOpen = !meOpen; renderMe(); } },
    h("span", { class: "avatar sm", text: initials }), h("span", { class: "me-name", text: u.name || "Konto" }), h("span", { class: "meta", text: roleName }));
  const parts = [chipBtn];
  if (meOpen) {
    const menu = h("div", { class: "me-menu panel" }, h("strong", { text: u.name }), u.email ? h("span", { class: "meta", text: u.email }) : null);
    if (u.id === "local") menu.append(h("p", { class: "hint", text: "Es gibt noch kein Konto. Lege unter „Nutzer“ deinen Admin-Zugang an, bevor der Server ins Netz geht." }));
    if (u.id && !["token", "local"].includes(u.id)) {
      const err = h("p", { class: "hint", role: "status" });
      const f = h("form", { class: "fields", style: "gap:8px" },
        h("span", { class: "lbl", text: "Passwort ändern" }),
        h("input", { class: "input", id: "pwCur", type: "password", placeholder: "Aktuelles Passwort", autocomplete: "current-password", required: true }),
        h("input", { class: "input", id: "pwNew", type: "password", placeholder: "Neues Passwort (mind. 10 Zeichen)", autocomplete: "new-password", minlength: "10", required: true }),
        h("button", { type: "submit", class: "btn", text: "Ändern" }), err);
      f.addEventListener("submit", async (e) => {
        e.preventDefault();
        try { await api("POST", "/api/auth/password", { current: $("pwCur").value, next: $("pwNew").value }); err.textContent = "Passwort geändert."; f.reset(); } catch (x) { err.textContent = x.message; }
      });
      menu.append(f);
    }
    menu.append(h("button", { type: "button", class: "btn ghost", text: u.id === "token" ? "Token vergessen" : "Abmelden", onclick: logout }));
    parts.push(menu);
  }
  box.replaceChildren(...parts);
}
document.addEventListener("click", (e) => { if (meOpen && !$("meBox").contains(e.target)) { meOpen = false; renderMe(); } });

/* ---------- persistence ---------- */
const saveEl = $("saveState");
function setSave(s, t) { saveEl.dataset.s = s; saveEl.textContent = t; }
let saveTimer = null, writing = null, writeAgain = false;
function scheduleSave() {
  setSave("saving", "Speichert …");
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 700);
}
const SECRET_KEYS = ["url", "secret", "token"];
// The server never echoes secrets: take over only the "is set" flags and drop what was sent.
function syncIntegrations(sent, saved) {
  let touched = false;
  for (const i of cfg.integrations || []) {
    const s0 = sent.find((x) => x.id === i.id), s1 = saved.find((x) => x.id === i.id);
    if (!s1) continue;
    for (const k of SECRET_KEYS) if (s0 && i[k] && i[k] === s0[k]) { i[k] = ""; touched = true; }
    i.has = s1.has; i.hint = s1.hint;
  }
  if (touched && section === "flow" && !document.activeElement?.closest?.("#form")) renderForm();
}
async function flush() {
  clearTimeout(saveTimer);
  if (writing) { writeAgain = true; return writing; }
  writing = (async () => {
    try {
      const sent = JSON.parse(JSON.stringify(cfg.integrations || []));
      const saved = cfg.id ? await api("PUT", `/api/agents/${cfg.id}`, cfg) : await api("POST", "/api/agents", cfg);
      syncIntegrations(sent, saved.integrations || []);
      if (!cfg.id) { cfg.id = saved.id; watchCaptured(); }
      const i = agents.findIndex((a) => a.id === saved.id);
      if (i >= 0) agents[i] = saved; else agents.unshift(saved);
      renderAgentSelect();
      setSave("saved", "Gespeichert");
    } catch (e) {
      if (!(e instanceof AuthError)) setSave("error", "Speichern fehlgeschlagen");
    }
  })();
  await writing;
  writing = null;
  if (writeAgain) { writeAgain = false; return flush(); }
}

async function refreshCaptured() {
  if (!cfg.id) { captured = []; conversations = []; renderCaptured(); return; }
  const id = cfg.id;
  try {
    const [c, v] = await Promise.all([api("GET", `/api/agents/${id}/captured`), api("GET", `/api/agents/${id}/conversations`)]);
    if (cfg.id !== id) return;
    captured = c; conversations = v;
  } catch { /* shown as empty */ }
  renderCaptured();
}
function watchCaptured() { refreshCaptured(); }

function loadAgent(a) {
  cfg = withDefaults(clone(a));
  pendingTemplate = null;
  importState = null;
  setSave("saved", "Gespeichert");
  renderAll();
  resetChat();
  watchCaptured();
}

/* ---------- agent switcher ---------- */
function renderAgentSelect() {
  $("newBtn").hidden = isKunde();
  const sel = $("agentSelect");
  sel.replaceChildren();
  const list = agents.slice();
  if (!cfg.id) list.unshift(cfg);
  for (const a of list) sel.append(h("option", { value: a.id || "", text: (a.name || "Ohne Namen") + (a.company ? ` · ${a.company}` : "") + (a.id ? "" : " (neu)") }));
  sel.value = cfg.id || "";
}
$("agentSelect").addEventListener("change", async (e) => {
  await flush();
  const a = agents.find((x) => x.id === e.target.value);
  if (a) loadAgent(a);
});
async function newAgent() {
  if (cfg.id) await flush();
  cfg = fromTemplate("blank");
  section = "basis"; importState = null; pendingTemplate = null;
  setSave("example", "Neu · wird beim ersten Bearbeiten gespeichert");
  if (typeof showView === "function" && currentView !== "builder") showView("builder");
  renderAll(); resetChat(); watchCaptured();
  $("f_importUrl")?.focus();
}
$("newBtn").addEventListener("click", newAgent);

/* ---------- form controls bound to cfg ---------- */
function changed(opts = {}) {
  scheduleSave();
  renderRail();
  applyWidgetLook();
  if (opts.rerender) renderForm();
  if (opts.prompt !== false) refreshPromptView();
}
function inputField(key, ph, type = "text") {
  return h("input", { class: "input", id: "f_" + key, type, value: cfg[key] || "", placeholder: ph, oninput: (e) => { cfg[key] = e.target.value; changed(); } });
}
function textField(key, ph, rows = 4, cls = "") {
  const t = h("textarea", { class: "textarea " + cls, id: "f_" + key, rows, placeholder: ph, oninput: (e) => { cfg[key] = e.target.value; changed(); } });
  t.value = cfg[key] || "";
  return t;
}
function field(label, hint, control, forKey) {
  return h("div", { class: "field" },
    forKey ? h("label", { for: "f_" + forKey, text: label }) : h("span", { class: "lbl", text: label }),
    hint ? h("p", { class: "hint", text: hint }) : null, control);
}
function chips(key, options, labels) {
  const wrap = h("div", { class: "chips", role: "group" });
  for (const o of options) {
    const b = h("button", { type: "button", class: "chip", "aria-pressed": String(cfg[key].includes(o)), text: labels ? labels[o] : o });
    b.addEventListener("click", () => {
      const on = cfg[key].includes(o);
      cfg[key] = on ? cfg[key].filter((x) => x !== o) : [...cfg[key], o];
      b.setAttribute("aria-pressed", String(!on));
      changed();
    });
    wrap.append(b);
  }
  return wrap;
}
function seg(key, options, rerender) {
  const wrap = h("div", { class: "seg", role: "group" });
  for (const [v, label] of options) {
    const b = h("button", { type: "button", "aria-pressed": String(cfg[key] === v), text: label });
    b.addEventListener("click", () => {
      cfg[key] = v;
      wrap.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      changed({ rerender });
    });
    wrap.append(b);
  }
  return wrap;
}
let flowSelected = null, flowAdding = false;
const integrationReady = (i) => i.enabled && (i.type === "email" ? i.to : i.type === "telegram" ? (i.has?.token || i.token) && i.chatId : (i.has?.url || i.url));
function toggleOf(obj, key, label) {
  const inp = h("input", { type: "checkbox", role: "switch" });
  inp.checked = !!obj[key];
  inp.addEventListener("change", () => { obj[key] = inp.checked; changed({ rerender: true, prompt: false }); });
  return h("label", { class: "switch" }, inp, label);
}
function toggle(key, label, rerender) {
  const inp = h("input", { type: "checkbox", id: "f_" + key, role: "switch" });
  inp.checked = !!cfg[key];
  inp.addEventListener("change", () => { cfg[key] = inp.checked; changed({ rerender }); });
  return h("label", { class: "switch", for: "f_" + key }, inp, label);
}

/* ---------- agent from a description ---------- */
const describeState = { text: "", busy: false, error: "", missing: [] };
function describeCard() {
  const box = h("div", { class: "import", id: "describeBox" });
  const t = h("textarea", { class: "textarea", id: "f_describe", rows: 3, maxlength: "1500", placeholder: "z. B. Ein freundlicher Assistent für meine Zahnarztpraxis in Köln, der Terminanfragen aufnimmt und Fragen zu Behandlungen beantwortet.", "aria-label": "Beschreibung des Agenten", disabled: describeState.busy, oninput: (e) => { describeState.text = e.target.value; } });
  t.value = describeState.text;
  const go = h("button", { type: "button", class: "btn primary", disabled: describeState.busy, text: describeState.busy ? "Baut …" : "Agent aus Beschreibung bauen", onclick: async () => {
    describeState.busy = true; describeState.error = ""; describeState.missing = []; renderForm();
    try {
      const r = await api("POST", "/api/agents/describe", { description: describeState.text });
      const keep = { id: cfg.id, allowedOrigins: cfg.allowedOrigins, integrations: cfg.integrations, sources: cfg.sources };
      cfg = { ...cfg, ...r.fields, ...keep };
      describeState.missing = r.missing || [];
      changed({ rerender: true }); resetChat(); renderAgentSelect();
    } catch (e) { if (!(e instanceof AuthError)) describeState.error = e.message; }
    describeState.busy = false; renderForm();
  } });
  box.append(h("strong", { text: "Oder beschreibe deinen Agenten" }), h("p", { class: "hint", text: "Ein, zwei Sätze reichen. Die KI richtet Ton, Ziel, Fragen und Begrüßung ein. Prüfe das Ergebnis danach und ergänze Fakten, die du nicht genannt hast." }), t, h("div", { class: "toolbar" }, go),
    describeState.error ? h("p", { class: "msg err", role: "alert", text: describeState.error }) : null,
    describeState.missing.length ? h("div", { class: "note" }, h("strong", { text: "Noch nicht beschrieben: " }), describeState.missing.join(" · ")) : null);
  return box;
}

/* ---------- sections ---------- */
const SECTIONS = [
  { id: "basis", title: "Grundlagen", lead: "Lies deine Website ein oder wähle eine Vorlage. Beides füllt alle Bereiche vor.", done: () => !!cfg.name.trim() && !!(cfg.company.trim() || cfg.industry.trim()) },
  { id: "stil", title: "Persönlichkeit", lead: "Wie klingt dein Agent? Ton, Anrede und Länge der Antworten.", done: () => cfg.tone.length > 0 },
  { id: "wissen", title: "Wissen", lead: "Alles, was der Agent über dein Unternehmen und deine Projekte wissen muss. Er nutzt nur, was hier steht.", done: () => cfg.knowledge.trim().length > 40 || cfg.faqs.length > 0 || cfg.projects.length > 0 || cfg.sources.length > 0 },
  { id: "ziele", title: "Ziel & Aktionen", lead: "Was soll am Ende einer Unterhaltung herauskommen?", done: () => !!cfg.goal && cfg.leadFields.length > 0 },
  { id: "regeln", title: "Regeln", lead: "Leitplanken: was der Agent immer tun soll und was nie.", done: () => !!(cfg.dos.trim() || cfg.donts.trim()) },
  { id: "design", title: "Widget", lead: "So erscheint der Chat auf deiner Website. Die Vorschau rechts zeigt es live.", done: () => !!cfg.welcome.trim() },
  { id: "phone", title: "Telefon", lead: "Derselbe Agent nimmt auch Anrufe an: Er versteht, was der Anrufer sagt, und antwortet mit Stimme.", done: () => cfg.phoneEnabled },
  { id: "flow", title: "Verbindungen", lead: "Wohin gehen Kontakte und Terminanfragen? Verbinde den Agenten mit E-Mail, Slack, Telegram oder über Webhook mit Zapier, Make und n8n.", done: () => cfg.integrations.some((i) => i.enabled) },
  { id: "prompt", title: "System-Prompt", lead: "Aus deinen Angaben entsteht dieser Prompt. Du kannst ihn auch von Hand anpassen.", done: () => true },
  { id: "embed", title: "Einbinden", lead: "Bau den Agenten mit einer Zeile Code in deine Website ein.", done: () => !!cfg.id },
];

function renderRail() {
  const rail = $("rail");
  rail.replaceChildren(h("div", { class: "rail-label", text: "Agent einrichten" }));
  SECTIONS.forEach((s, i) => {
    rail.append(h("button", { type: "button", "aria-current": s.id === section ? "step" : null, onclick: () => go(s.id) },
      h("span", { class: "num", text: String(i + 1).padStart(2, "0") }), s.title,
      h("span", { class: "dot" + (s.done() ? " done" : ""), title: s.done() ? "Erledigt" : "Offen" })));
  });
}
function go(id) {
  section = id; pendingTemplate = null;
  renderRail(); renderForm();
  if (window.matchMedia("(max-width: 820px)").matches) $("form").scrollIntoView({ block: "start" });
}

function renderForm() {
  const s = SECTIONS.find((x) => x.id === section);
  const i = SECTIONS.indexOf(s);
  const fields = h("div", { class: "fields" });
  BUILDERS[section](fields);
  $("form").replaceChildren(
    h("div", { class: "form-head" }, h("span", { class: "eyebrow", text: `Schritt ${i + 1} von ${SECTIONS.length}` }), h("h2", { text: s.title }), h("p", { text: s.lead })),
    fields,
    h("div", { class: "form-foot" },
      i > 0 ? h("button", { type: "button", class: "btn", onclick: () => go(SECTIONS[i - 1].id), text: "← " + SECTIONS[i - 1].title }) : h("span"),
      i < SECTIONS.length - 1 ? h("button", { type: "button", class: "btn primary", onclick: () => go(SECTIONS[i + 1].id), text: SECTIONS[i + 1].title + " →" }) : h("span")),
  );
}

/* ---------- website import ---------- */
const isBlank = () => !cfg.knowledge.trim() && !cfg.faqs.length && (cfg.template === "blank" || !cfg.template) && !cfg.source;

async function runImport(url) {
  importState = { running: true, log: [], error: "", result: null, applied: false };
  renderForm();
  try {
    await apiStream("/api/analyze", { url }, (name, data) => {
      if (name === "status") importState.log.push({ kind: "now", text: data.message });
      else if (name === "page") importState.log.push({ kind: "page", text: data.title, url: data.url });
      else if (name === "error") importState.error = data.message;
      else if (name === "result") importState.result = data;
      if (section === "basis") renderImportBox();
    });
    if (!importState.result && !importState.error) importState.error = "Die Analyse wurde abgebrochen. Bitte noch einmal versuchen.";
  } catch (e) {
    if (!(e instanceof AuthError)) importState.error = e.message;
  }
  importState.running = false;
  if (importState.result && isBlank()) applyImport();
  else if (section === "basis") renderImportBox();
}

function applyImport() {
  const r = importState.result;
  Object.assign(cfg, clone(r.fields));
  cfg.source = r.source;
  cfg.promptOverride = null;
  cfg.template = "website";
  importState.applied = true;
  changed({ rerender: true });
  resetChat();
  renderAgentSelect();
}

function renderImportBox() {
  const box = $("importBox");
  if (box) box.replaceWith(importBox());
}

function importBox() {
  const st = importState;
  const url = h("input", { class: "input", id: "f_importUrl", type: "text", inputmode: "url", autocomplete: "url", spellcheck: "false", placeholder: "www.deine-firma.de", value: cfg.source?.url || cfg.website || "", "aria-label": "Website-Adresse" });
  const go = h("button", { type: "submit", class: "btn primary", disabled: st?.running || null, text: st?.running ? "Liest …" : (cfg.source ? "Neu einlesen" : "Website einlesen") });
  const form = h("form", { class: "import-row" }, url, go);
  form.addEventListener("submit", (e) => { e.preventDefault(); if (url.value.trim()) runImport(url.value.trim()); });

  const box = h("div", { class: "import", id: "importBox" },
    h("h3", { text: "Aus deiner Website erstellen" }),
    h("p", { text: "Gib deine Adresse ein. Der Agent liest Startseite, Kontakt, Leistungen, Preise und FAQ, übernimmt die Fakten und schlägt passende Fragen für deine Besucher vor." }),
    form);
  if (!status.aiConfigured) box.append(h("div", { class: "err-box", text: `Für das Einlesen fehlt ${status.keyName} in der .env des Servers.` }));

  if (st && (st.running || st.log.length)) {
    const list = h("ul", { class: "progress" });
    st.log.forEach((l, i) => {
      const last = i === st.log.length - 1;
      list.append(h("li", { class: l.kind === "now" && last && st.running ? "now" : "" }, h("span", { text: l.text }), l.url ? h("span", { class: "meta", text: new URL(l.url).pathname }) : null));
    });
    if (!st.result || st.running) box.append(list);
  }
  if (st?.error) box.append(h("div", { class: "err-box", text: st.error }));

  if (st?.result) {
    const r = st.result;
    const f = r.fields;
    const found = h("div", { class: "found" });
    found.append(h("h4", { text: `${f.company || "Website"}${f.industry ? " · " + f.industry : ""}: ${r.source.pages.length} Seiten gelesen` }));
    found.append(h("p", { class: "hint", text: `Hauptziel: ${GOALS[f.goal][0]}. ${r.goalReason || ""}` }));
    const qs = [...new Set([...f.quickReplies, ...f.faqs.map((x) => x.q)])];
    if (qs.length) {
      found.append(h("h4", { text: "Vorgeschlagene Fragen für Besucher" }));
      found.append(h("div", { class: "chips" }, qs.slice(0, 12).map((q) => h("span", { class: "chip", text: q }))));
      found.append(h("p", { class: "hint", text: `Die ersten ${f.quickReplies.length} erscheinen als Buttons im Chat, ${f.faqs.length} Fragen mit Antworten stehen unter „Wissen“.` }));
    }
    if (r.source.missing?.length) {
      found.append(h("h4", { text: "Auf der Website nicht gefunden" }));
      found.append(h("ul", null, r.source.missing.map((m) => h("li", { text: m }))));
      found.append(h("p", { class: "hint", text: "Ergänze diese Punkte unter „Wissen“, damit der Agent sie beantworten kann." }));
    }
    found.append(h("details", null, h("summary", { class: "hint", text: "Gelesene Seiten" }),
      h("ul", null, r.source.pages.map((p) => h("li", null, h("a", { href: p.url, target: "_blank", rel: "noopener", text: p.title || p.url }))))));
    if (st.applied) {
      found.append(h("p", { class: "hint", text: "Übernommen. Prüfe die Bereiche links und teste den Agenten im Chat rechts." }));
    } else {
      found.append(h("div", { class: "confirm" },
        h("span", { text: "Übernehmen? Das ersetzt Grundlagen, Wissen, Ziel, Regeln und Widget-Texte dieses Agenten." }),
        h("button", { type: "button", class: "btn primary", text: "Übernehmen", onclick: applyImport }),
        h("button", { type: "button", class: "btn ghost", text: "Verwerfen", onclick: () => { importState = null; renderForm(); } })));
    }
    box.append(found);
  } else if (cfg.source && !st) {
    const d = new Date(cfg.source.importedAt).toLocaleString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
    box.append(h("p", { class: "hint", text: `Zuletzt eingelesen am ${d} aus ${cfg.source.pages.length} Seiten.` }));
  }
  return box;
}

/* ---------- projects: GitHub repositories the agent knows ---------- */
/* ---------- knowledge base dialog ---------- */
const kb = { mode: "file", url: "", thorough: false, busy: false, log: "", error: "" };
const kbChars = () => cfg.sources.reduce((n, x) => n + (x.chars || x.text?.length || 0), 0);

function openKnowledge() {
  if (document.getElementById("kbOverlay")) return;
  const previous = document.activeElement;
  const body = h("div", { class: "kb-body" });
  const close = () => { overlay.remove(); document.removeEventListener("keydown", onKey); previous?.focus?.(); if (section === "wissen") renderForm(); renderRail(); };
  const onKey = (e) => { if (e.key === "Escape" && !kb.busy) close(); };
  const title = h("h3", { id: "kbTitle", text: "Wissensdatenbank" });
  const overlay = h("div", { class: "kb-overlay", id: "kbOverlay", role: "dialog", "aria-modal": "true", "aria-labelledby": "kbTitle" },
    h("div", { class: "kb-card" },
      h("div", { class: "kb-head" }, h("span", { class: "fnode-ic" }, icon("book", 22)),
        h("div", null, title, h("p", { class: "hint", text: "Inhalte werden eingelesen und dem Agenten beim Chatten zur Verfügung gestellt." })),
        h("button", { type: "button", class: "icon-btn", "aria-label": "Schließen", onclick: close }, icon("close", 18))),
      body,
      h("div", { class: "kb-foot" }, h("button", { type: "button", class: "btn primary", text: "Fertig", onclick: close }))));
  const addSources = (list) => { for (const x of list) cfg.sources.push({ id: x.id || (crypto.randomUUID?.() || String(Date.now() + Math.random())).replace(/-/g, "").slice(0, 12), kind: x.kind, name: x.name, url: x.url || "", text: x.text, chars: x.text.length, addedAt: x.addedAt || Date.now() }); changed({ prompt: true }); draw(); };

  async function importSite() {
    const url = kb.url.trim();
    if (!url || kb.busy) return;
    kb.busy = true; kb.error = ""; kb.log = "Verbindet …"; draw();
    let pages = 0;
    try {
      await apiStream("/api/sources/website", { url, thorough: kb.thorough }, (name, data) => {
        if (name === "status") kb.log = data.message;
        else if (name === "page") { pages++; kb.log = `${pages} Seiten gelesen: ${data.title}`; }
        else if (name === "error") kb.error = data.message;
        else if (name === "result") { addSources(data.sources); kb.url = ""; }
        const el = document.getElementById("kbLog"); if (el) el.textContent = kb.log;
      });
    } catch (e) { if (!(e instanceof AuthError)) kb.error = e.message; }
    kb.busy = false; kb.log = ""; draw();
  }

  function draw() {
    const file = h("input", { type: "file", id: "kb_file", accept: ".txt,.md,.csv,.json,.html,text/*", multiple: true, hidden: true });
    file.addEventListener("change", async () => {
      const added = [];
      for (const fl of [...file.files]) {
        if (fl.size > 2_000_000) { kb.error = `${fl.name} ist größer als 2 MB.`; continue; }
        let text = await fl.text();
        if (/\.html?$/i.test(fl.name)) text = new DOMParser().parseFromString(text, "text/html").body.textContent.replace(/\s+/g, " ");
        added.push({ kind: "file", name: fl.name, text: text.slice(0, 60000) });
      }
      file.value = "";
      if (added.length) { kb.error = ""; addSources(added); } else draw();
    });
    const tab = (m, ic, label) => h("button", { type: "button", class: "kb-tab", "aria-pressed": String(kb.mode === m), onclick: () => { kb.mode = m; kb.error = ""; draw(); } }, icon(ic, 18), label);
    const url = h("input", { class: "input", id: "kb_url", type: "text", inputmode: "url", autocomplete: "off", spellcheck: "false", placeholder: "https://kunden-website.de", value: kb.url, disabled: kb.busy,
      oninput: (e) => { kb.url = e.target.value; }, onkeydown: (e) => { if (e.key === "Enter") importSite(); } });
    const thorough = h("input", { type: "checkbox", id: "kb_deep", checked: kb.thorough, disabled: kb.busy, onchange: (e) => { kb.thorough = e.target.checked; } });
    const src = kb.mode === "file"
      ? h("div", { class: "kb-drop" }, h("button", { type: "button", class: "btn", onclick: () => file.click() }, icon("upload", 16), "Dateien auswählen"), file, h("p", { class: "hint", text: "Text, Markdown, CSV, JSON oder HTML, bis 2 MB je Datei. PDF und Word bitte vorher als Text speichern." }))
      : h("div", { class: "fields" },
        h("div", { class: "kb-url" }, url, h("button", { type: "button", class: "btn primary", text: kb.busy ? "Liest …" : "Import", disabled: kb.busy, onclick: importSite })),
        h("label", { class: "check", for: "kb_deep" }, thorough, h("span", null, h("strong", { text: "Gründlich einlesen. " }), "Liest bis zu 80 Seiten statt 8 und legt jede Unterseite einzeln ab. Für Shops und große Kataloge; dauert bis zu vier Minuten, lass das Fenster so lange offen.")),
        kb.busy ? h("p", { class: "hint", id: "kbLog", role: "status", text: kb.log }) : null);
    const list = cfg.sources.length
      ? h("ul", { class: "kb-list" }, cfg.sources.map((x) => h("li", null,
        h("span", { class: "fnode-ic sm" }, icon(x.kind === "website" ? "globe" : "book", 16)),
        h("span", { class: "kb-name" }, h("strong", { text: x.name || x.url || "Dokument" }), h("span", { class: "meta", text: `${(x.chars || 0).toLocaleString("de-DE")} Zeichen${x.url ? ` · ${x.url.replace(/^https?:\/\//, "").slice(0, 40)}` : ""}` })),
        h("button", { type: "button", class: "x", "aria-label": `${x.name || "Quelle"} entfernen`, text: "×", onclick: () => { cfg.sources = cfg.sources.filter((y) => y.id !== x.id); changed({ prompt: true }); draw(); } }))))
      : h("div", { class: "panel empty", text: "Noch keine Quellen." });
    const parts = [
      h("span", { class: "lbl", text: "Wissensquelle" }),
      h("div", { class: "kb-tabs" }, tab("file", "upload", "Datei hochladen"), tab("website", "globe", "Website importieren")),
      src,
      kb.error ? h("p", { class: "msg err", role: "alert", text: kb.error }) : null,
      h("h4", { text: `Gespeicherte Quellen (${cfg.sources.length})` }), list,
      h("p", { class: "hint", text: `${kbChars().toLocaleString("de-DE")} Zeichen gespeichert. Der Agent nutzt bis zu 150.000 Zeichen davon; Vektor-Suche für größere Mengen gibt es noch nicht.` }),
    ].filter(Boolean);
    body.replaceChildren(...parts);
  }
  draw();
  document.body.append(overlay);
  document.addEventListener("keydown", onKey);
  overlay.querySelector("button")?.focus();
}

let projectState = { busy: false, error: "", repoInput: "", suggestions: null };

function projectsCard() {
  const box = h("div", { class: "import", id: "projectsBox" });
  const redraw = () => box.replaceWith(projectsCard());
  const input = h("input", { class: "input", id: "f_repo", type: "text", inputmode: "url", autocomplete: "off", spellcheck: "false", placeholder: "digitalerquatsch/jarvis oder https://github.com/…", value: projectState.repoInput });
  input.addEventListener("input", () => { projectState.repoInput = input.value; });
  const run = async (repo) => {
    if (!repo || projectState.busy) return;
    projectState = { ...projectState, busy: true, error: "" }; redraw();
    try {
      const { project } = await api("POST", "/api/projects/import", { repo });
      const i = cfg.projects.findIndex((p) => p.repo.toLowerCase() === project.repo.toLowerCase());
      if (i >= 0) cfg.projects[i] = project; else cfg.projects.push(project);
      projectState.repoInput = "";
      changed({ rerender: false });
      resetChat();
    } catch (e) {
      if (!(e instanceof AuthError)) projectState.error = e.message;
    }
    projectState.busy = false;
    if (section === "wissen") renderForm();
  };
  const form = h("form", { class: "import-row" }, input, h("button", { type: "submit", class: "btn primary", disabled: projectState.busy || null, text: projectState.busy ? "Liest …" : "Projekt einlesen" }));
  form.addEventListener("submit", (e) => { e.preventDefault(); run(input.value.trim()); });
  box.append(h("h3", { text: "Deine Projekte" }),
    h("p", { text: "Gib ein GitHub-Repository an. Agentenwerk liest README und Struktur, fasst das Projekt zusammen und gibt es deinem Agenten als Wissen. Er kann dann erklären, was es ist, was es kann und wie man es benutzt." }), form);
  if (projectState.error) box.append(h("div", { class: "err-box", text: projectState.error }));
  if (projectState.busy) box.append(h("p", { class: "hint", text: "Repository wird gelesen und zusammengefasst, das dauert etwa eine halbe Minute …" }));
  if (cfg.projects.length) {
    box.append(h("div", { class: "proj-list" }, cfg.projects.map((p) => h("article", { class: "proj" },
      h("div", { class: "proj-top" }, h("div", null, h("strong", { text: p.name || p.repo }), h("a", { class: "meta", href: p.url, target: "_blank", rel: "noopener", text: p.repo + (p.private ? " · privat" : "") })),
        h("div", { class: "toolbar" },
          h("button", { type: "button", class: "btn ghost", disabled: projectState.busy || null, text: "Aktualisieren", onclick: () => run(p.repo) }),
          h("button", { type: "button", class: "btn ghost danger", text: "Entfernen", onclick: () => { cfg.projects = cfg.projects.filter((x) => x !== p); changed({ rerender: false }); resetChat(); renderForm(); } }))),
      h("p", { class: "proj-sum", text: p.summary }),
      p.features?.length ? h("div", { class: "tags" }, p.features.slice(0, 4).map((x) => h("span", { class: "tag", text: x.length > 48 ? x.slice(0, 46) + "…" : x }))) : null,
      h("span", { class: "meta", text: `${p.faqs?.length || 0} Fragen · eingelesen ${p.importedAt ? new Date(p.importedAt).toLocaleDateString("de-DE") : ""}` })))));
    box.append(h("p", { class: "hint", text: "Frag deinen Agenten im Testchat rechts zu einem Projekt, um zu prüfen, ob die Antworten stimmen. Nach Änderungen im Repository auf „Aktualisieren“ klicken." }));
  }
  return box;
}

const BUILDERS = {
  basis(f) {
    if (!isKunde()) f.append(importBox());
    if (!isKunde()) f.append(describeCard());
    const cards = h("div", { class: "cards" });
    for (const [key, t] of Object.entries(TEMPLATES)) {
      cards.append(h("button", { type: "button", class: "card", "aria-pressed": String(cfg.template === key),
        onclick: () => { pendingTemplate = key; renderForm(); } }, h("strong", { text: t.label }), h("span", { text: t.desc })));
    }
    f.append(field("Oder mit einer Vorlage starten", null, cards));
    if (pendingTemplate) {
      f.append(h("div", { class: "confirm" },
        h("span", { text: `„${TEMPLATES[pendingTemplate].label}“ übernehmen? Das ersetzt die aktuellen Angaben dieses Agenten.` }),
        h("button", { type: "button", class: "btn primary", text: "Übernehmen", onclick: () => {
          const keep = { id: cfg.id, allowedOrigins: cfg.allowedOrigins };
          cfg = { ...fromTemplate(pendingTemplate), ...keep }; pendingTemplate = null; importState = null;
          changed({ rerender: true }); resetChat(); renderAgentSelect();
        } }),
        h("button", { type: "button", class: "btn ghost", text: "Abbrechen", onclick: () => { pendingTemplate = null; renderForm(); } })));
    }
    const nameIn = inputField("name", "z. B. Lina");
    nameIn.addEventListener("input", renderAgentSelect);
    f.append(h("div", { class: "row2" }, field("Name des Agenten", null, nameIn, "name"), field("Unternehmen", null, inputField("company", "z. B. Salon Lindgrün"), "company")));
    f.append(h("div", { class: "row2" }, field("Branche", null, inputField("industry", "z. B. Friseursalon"), "industry"), field("Website", null, inputField("website", "beispiel.de"), "website")));
    f.append(field("Aufgabe", "Ein, zwei Sätze: Was macht der Agent für deine Besucher?", textField("role", "Du beantwortest Fragen zu …", 3), "role"));
  },
  stil(f) {
    f.append(field("Tonalität", "Mehrere möglich.", chips("tone", TONES)));
    f.append(h("div", { class: "row2" },
      field("Anrede", null, seg("address", [["sie", "Sie"], ["du", "Du"]])),
      field("Antwortlänge", null, seg("length", [["kurz", "Kurz"], ["mittel", "Mittel"], ["lang", "Ausführlich"]]))));
    f.append(field("Sprache", null, seg("language", [["de", "Deutsch"], ["en", "Englisch"], ["auto", "Wie der Besucher"]])));
    f.append(toggle("emojis", "Emojis erlauben"));
  },
  wissen(f) {
    f.append(h("div", { class: "import kb-card-link" },
      h("div", null, h("strong", { text: "Wissensdatenbank" }), h("p", { class: "hint", text: cfg.sources.length ? `${cfg.sources.length} Quellen, ${kbChars().toLocaleString("de-DE")} Zeichen.` : "Lade Dateien hoch oder lies ganze Websites ein, auch mit vielen Unterseiten." })),
      h("button", { type: "button", class: "btn primary", onclick: openKnowledge }, icon("book", 16), "Quellen verwalten")));
    f.append(projectsCard());
    if (cfg.source?.missing?.length) {
      f.append(h("div", { class: "note" }, h("strong", { text: "Auf der Website fehlte: " }), cfg.source.missing.join(" · ")));
    }
    const kn = textField("knowledge", "Wer seid ihr, was bietet ihr an, was unterscheidet euch? Je konkreter, desto besser.", 10);
    const meta = h("span", { class: "meta" });
    const upd = () => { meta.textContent = `${cfg.knowledge.length.toLocaleString("de-DE")} Zeichen`; };
    kn.addEventListener("input", upd); upd();
    const file = h("input", { type: "file", id: "f_upload", accept: ".txt,.md,.csv,.json,text/*", hidden: true });
    file.addEventListener("change", () => {
      const fl = file.files && file.files[0]; if (!fl) return;
      const r = new FileReader();
      r.onload = () => { cfg.knowledge = (cfg.knowledge.trim() ? cfg.knowledge.trim() + "\n\n" : "") + `[${fl.name}]\n` + String(r.result).slice(0, 60000); kn.value = cfg.knowledge; upd(); changed(); };
      r.readAsText(fl); file.value = "";
    });
    f.append(field("Über das Unternehmen", null, h("div", { class: "fields", style: "gap:8px" }, kn,
      h("div", { class: "toolbar" }, h("button", { type: "button", class: "btn", text: "Textdatei einfügen", onclick: () => file.click() }), file, meta)), "knowledge"));
    f.append(field("Öffnungszeiten & Kontakt", null, textField("hours", "Mo–Fr 9–18 Uhr, Telefon …", 3), "hours"));
    f.append(field("Leistungen & Preise", "Eine pro Zeile, gern mit Dauer und Preis.", textField("services", "Herrenhaarschnitt – 30 Min – 32 €", 5), "services"));

    const list = h("div", { class: "list" });
    const renderFaqs = () => {
      list.replaceChildren();
      cfg.faqs.forEach((fq, idx) => {
        const q = h("input", { class: "input", id: `faq_q_${idx}`, value: fq.q, placeholder: "Frage", "aria-label": "Frage", oninput: (e) => { fq.q = e.target.value; changed(); } });
        const a = h("textarea", { class: "textarea", id: `faq_a_${idx}`, rows: 2, placeholder: "Antwort", "aria-label": "Antwort", style: "min-height:56px", oninput: (e) => { fq.a = e.target.value; changed(); } });
        a.value = fq.a;
        list.append(h("div", { class: "faq" }, q, h("button", { type: "button", class: "x", "aria-label": "Frage entfernen", text: "×", onclick: () => { cfg.faqs.splice(idx, 1); renderFaqs(); changed(); } }), a));
      });
      list.append(h("div", null, h("button", { type: "button", class: "btn", text: "+ Frage hinzufügen", onclick: () => { cfg.faqs.push({ q: "", a: "" }); renderFaqs(); changed(); list.querySelector(`#faq_q_${cfg.faqs.length - 1}`)?.focus(); } })));
    };
    renderFaqs();
    f.append(field("Häufige Fragen", "Frage-Antwort-Paare, die der Agent wörtlich kennen soll.", list));
  },
  ziele(f) {
    const cards = h("div", { class: "cards" });
    for (const [k, [t, d]] of Object.entries(GOALS)) {
      cards.append(h("button", { type: "button", class: "card", "aria-pressed": String(cfg.goal === k), onclick: () => { cfg.goal = k; changed({ rerender: true }); } }, h("strong", { text: t }), h("span", { text: d })));
    }
    f.append(field("Hauptziel", null, cards));
    if (cfg.goal === "booking") f.append(field("Buchungsregeln", null, textField("bookingRules", "z. B. frühestens am nächsten Werktag", 2), "bookingRules"));
    f.append(field("Diese Angaben erfasst der Agent", "Sie landen rechts unter „Erfasst“.", chips("leadFields", Object.keys(LEAD_FIELDS), LEAD_FIELDS)));
    f.append(field("Übergabe an einen Menschen", "Wann soll der Agent an dein Team verweisen, und wie ist es erreichbar?", textField("handoff", "Bei Beschwerden: Telefon …", 3), "handoff"));
  },
  regeln(f) {
    f.append(field("Immer", "Eine Regel pro Zeile.", textField("dos", "Nenne immer die Dauer der Leistung.", 4), "dos"));
    f.append(field("Niemals", "Eine Regel pro Zeile.", textField("donts", "Keine Rabatte versprechen.", 4), "donts"));
    f.append(toggle("privacy", "Vor dem Erfassen von Kontaktdaten auf den Datenschutz hinweisen (DSGVO)", true));
    if (cfg.privacy) f.append(field("Link zur Datenschutzerklärung", "Erscheint auch im Widget.", inputField("privacyUrl", "https://beispiel.de/datenschutz", "url"), "privacyUrl"));
  },
  design(f) {
    const sw = h("div", { class: "swatches" });
    const picker = h("input", { type: "color", id: "f_color", value: cfg.color, "aria-label": "Eigene Farbe" });
    const paint = () => sw.querySelectorAll(".sw").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.c === cfg.color)));
    for (const c of COLORS) sw.append(h("button", { type: "button", class: "sw", "data-c": c, style: `background:${c}`, "aria-label": `Farbe ${c}`, onclick: () => { cfg.color = c; picker.value = c; paint(); changed({ prompt: false }); } }));
    picker.addEventListener("input", () => { cfg.color = picker.value; paint(); changed({ prompt: false }); });
    sw.append(picker); paint();
    f.append(field("Farbe", null, sw));
    const ini = inputField("initials", "SL"); ini.maxLength = 2;
    f.append(h("div", { class: "row2" },
      field("Kürzel im Avatar", "Zwei Buchstaben.", ini, "initials"),
      field("Position auf der Seite", null, seg("position", [["right", "Unten rechts"], ["left", "Unten links"]]))));
    f.append(h("div", { class: "row2" },
      field("Chat-Titel", "Steht im Kopf des Chats, z. B. „Fragen zum Führerschein?“", (() => { const i = inputField("widgetTitle", "Name · Firma"); i.maxLength = 40; return i; })(), "widgetTitle"),
      field("Darstellung", null, seg("widgetTheme", [["light", "Hell"], ["dark", "Dunkel"]]))));
    f.append(field("Logo (Bild-Adresse)", "Wird beim Einlesen der Website gesucht. Leer lassen zeigt das Kürzel.", inputField("logoUrl", "https://firma.de/logo.png", "url"), "logoUrl"));
    const w = textField("welcome", "Hallo! Wie kann ich helfen?", 2);
    w.addEventListener("input", () => { if (!started) resetChat(); });
    f.append(field("Begrüßung", "Die erste Nachricht, die Besucher sehen.", w, "welcome"));

    const list = h("div", { class: "list" });
    const renderQr = () => {
      list.replaceChildren();
      cfg.quickReplies.forEach((q, idx) => list.append(h("div", { class: "qr" },
        h("input", { class: "input", id: `qr_${idx}`, value: q, maxlength: 40, "aria-label": "Schnellantwort", oninput: (e) => { cfg.quickReplies[idx] = e.target.value; changed({ prompt: false }); renderQuick(); } }),
        h("button", { type: "button", class: "x", "aria-label": "Entfernen", text: "×", onclick: () => { cfg.quickReplies.splice(idx, 1); renderQr(); changed({ prompt: false }); renderQuick(); } }))));
      if (cfg.quickReplies.length < 5) list.append(h("div", null, h("button", { type: "button", class: "btn", text: "+ Schnellantwort", onclick: () => { cfg.quickReplies.push(""); renderQr(); list.querySelector(`#qr_${cfg.quickReplies.length - 1}`)?.focus(); } })));
    };
    renderQr();
    f.append(field("Schnellantworten", "Bis zu 5 Buttons unter der Begrüßung.", list));
  },
  phone(f) {
    if (!status.phone?.enabled) f.append(h("div", { class: "note" }, h("strong", { text: "Noch nicht eingerichtet. " }),
      me().role === "admin" ? h("span", null, "Trage Twilio unter ", h("button", { type: "button", class: "linkish", text: "System", onclick: () => showView("system") }), " ein.") : "Der Telefon-Bot ist auf diesem Server noch nicht freigeschaltet."));
    f.append(toggle("phoneEnabled", "Anrufe mit diesem Agenten beantworten", true));
    const g = textField("phoneGreeting", cfg.welcome || "Guten Tag, wie kann ich Ihnen helfen?", 3);
    const said = h("p", { class: "hint" });
    const upd = () => {
      const base = (cfg.phoneGreeting || cfg.welcome || "Wie kann ich Ihnen helfen?").trim();
      said.textContent = "Am Telefon hört man: „" + (/\b(KI|künstliche|digitale[rn]?|virtuelle[rn]?)\b/i.test(base) ? base : `Sie sprechen mit dem KI-Assistenten von ${cfg.company || "uns"}. ${base}`) + "“";
    };
    g.addEventListener("input", upd); upd();
    f.append(field("Begrüßung am Telefon", "Leer lassen nimmt die Begrüßung aus dem Widget. Der Hinweis auf den KI-Assistenten kommt automatisch davor (Pflicht nach EU AI Act).", h("div", { class: "fields", style: "gap:6px" }, g, said), "phoneGreeting"));
    if (!cfg.id) { f.append(h("div", { class: "note", text: "Speichere den Agenten zuerst, dann erscheint hier die Adresse für Twilio." })); return; }
    const url = `${status.publicUrl.replace(/\/$/, "")}/api/public/voice/${cfg.id}`;
    f.append(field("Adresse für Twilio", null, h("div", { class: "fields", style: "gap:8px" }, h("pre", { class: "code", text: url }), h("div", { class: "toolbar" }, copyBtn("Adresse kopieren", () => url)))));
    f.append(h("ol", { class: "steps-list" },
      h("li", { text: "Bei Twilio (twilio.com) anmelden und eine deutsche Telefonnummer kaufen. Für deutsche Nummern verlangt Twilio einen Adressnachweis." }),
      h("li", { text: "Phone Numbers → deine Nummer → Voice Configuration → „A call comes in“: Webhook, HTTP POST, die Adresse oben einfügen, speichern." }),
      h("li", { text: "Die Nummer anrufen. Termine und Rückrufwünsche landen wie im Chat unter „Erfasst“, mit der Nummer des Anrufers." }),
      h("li", { text: "Auf deiner Website oder im Google-Profil kannst du die Nummer als „KI-Telefon“ angeben oder Anrufe außerhalb der Öffnungszeiten dorthin umleiten." })));
    if (/localhost|127\.0\.0\.1/.test(url)) f.append(h("div", { class: "note", text: "Der Server läuft lokal. Twilio braucht eine öffentliche https-Adresse (unter System → Öffentliche Adresse)." }));
  },
  flow(f) {
    const INT = { email: ["E-Mail", "mail"], webhook: ["Webhook", "link"], slack: ["Slack", "chat"], discord: ["Discord", "chat"], telegram: ["Telegram", "send"] };
    const node = (ic, title, sub, opts = {}) => h(opts.onclick ? "button" : "div", { type: opts.onclick ? "button" : null, class: "fnode" + (opts.on ? " on" : "") + (opts.off ? " off" : "") + (opts.active ? " active" : ""), onclick: opts.onclick },
      h("span", { class: "fnode-ic" }, icon(ic, 22)), h("strong", { text: title }), h("span", { class: "meta", text: sub }));
    const rerender = () => renderForm();
    const sel = cfg.integrations.find((i) => i.id === flowSelected);
    const triggers = [node("chat", "Chat-Widget", "Website", { on: true })];
    if (cfg.phoneEnabled) triggers.push(node("phone", "Telefon", "Anrufe", { on: true }));
    const sources = (cfg.faqs.length ? 1 : 0) + (cfg.knowledge.trim() ? 1 : 0) + cfg.projects.length + cfg.sources.length;
    const outs = [
      node("book", "Wissen", `${sources} Quellen`, { onclick: () => go("wissen"), on: sources > 0 }),
      node("phone", "Telefon", cfg.phoneEnabled ? "aktiv" : "aus", { onclick: () => go("phone"), off: !cfg.phoneEnabled }),
      ...cfg.integrations.map((i) => node(INT[i.type][1], i.label || INT[i.type][0], i.enabled ? (integrationReady(i) ? "verbunden" : "unvollständig") : "pausiert", { onclick: () => { flowSelected = i.id; flowAdding = false; rerender(); }, active: i.id === flowSelected, off: !i.enabled, on: i.enabled && integrationReady(i) })),
      h("button", { type: "button", class: "fnode add", onclick: () => { flowAdding = !flowAdding; rerender(); } }, h("span", { class: "fnode-ic" }, icon("plus", 22)), h("strong", { text: "Verbindung" }), h("span", { class: "meta", text: "hinzufügen" })),
    ];
    f.append(h("div", { class: "flow" },
      h("div", { class: "flow-row" }, triggers), h("div", { class: "flow-line" }),
      h("div", { class: "fnode agent" }, h("span", { class: "fnode-ic" }, icon("bot", 22)), h("strong", { text: cfg.name || "KI-Agent" }), h("span", { class: "meta", text: status.model || "KI" })),
      h("div", { class: "flow-line" }), h("div", { class: "flow-row wrap" }, outs)));
    if (flowAdding) {
      f.append(field("Neue Verbindung", "Was soll bei einem neuen Kontakt oder einer Terminanfrage passieren?", h("div", { class: "chips" }, Object.entries(INT).map(([type, [label]]) =>
        h("button", { type: "button", class: "chip", text: label, onclick: () => {
          const id = (crypto.randomUUID?.() || String(Date.now())).replace(/-/g, "").slice(0, 12);
          cfg.integrations.push({ id, type, enabled: true, label: "", events: ["lead", "termin"], to: "", chatId: "", url: "", secret: "", token: "", tool: { on: false, description: "", returnResponse: false, fields: [] }, has: {}, hint: {} });
          flowSelected = id; flowAdding = false; changed({ rerender: true });
        } })))));
    }
    if (!sel) { f.append(h("p", { class: "hint", text: cfg.integrations.length ? "Wähle eine Verbindung, um sie einzurichten." : "Noch keine Verbindung. Lege eine an, damit dich neue Kontakte sofort erreichen." })); return; }
    const sv = (k, label, ph, hint, type = "text") => {
      const set = sel.has?.[k];
      const inp = h("input", { class: "input", type: set || type === "password" ? "password" : type, autocomplete: "off", spellcheck: "false", value: sel[k] || "", placeholder: set ? `gespeichert (${sel.hint?.[k]}) · neu eingeben zum Ändern` : ph, oninput: (e) => { sel[k] = e.target.value; changed({ prompt: false }); }, onchange: settle });
      return field(label, hint, inp);
    };
    // After a field is committed: save, then redraw so status and "Test senden" are current.
    const settle = () => flush().then(() => { if (section === "flow") renderForm(); });
    const fields = [];
    if (sel.type === "email") {
      fields.push(field("Empfänger", "Hierhin geht jede neue Anfrage.", h("input", { class: "input", type: "email", value: sel.to || "", placeholder: "du@firma.de", oninput: (e) => { sel.to = e.target.value; changed({ prompt: false }); }, onchange: settle })));
      fields.push(h("div", { class: "note", text: status.mail ? "Der Versand läuft über die E-Mail-Einstellungen unter System. Mit Gmail: smtp.gmail.com, Port 587 und ein App-Passwort deines Google-Kontos." : "Der E-Mail-Versand ist unter System noch nicht eingerichtet." }));
    }
    if (sel.type === "webhook") {
      sel.tool ||= { on: false, description: "", returnResponse: false, fields: [] };
      const BRANDS = ["Gmail", "Google Kalender", "Google Sheets", "WhatsApp", "Telegram", "HubSpot", "Notion", "Zapier", "Make", "n8n"];
      const TEMPLATES = {
        "Termin prüfen oder buchen": [["datum", "Wunschdatum"], ["uhrzeit", "Wunschuhrzeit"], ["name", "Name des Kunden"], ["email", "E-Mail-Adresse des Kunden"], ["leistung", "Gewünschte Leistung"]],
        "Kontakt anlegen": [["vorname", "Vorname des Kunden"], ["nachname", "Nachname des Kunden"], ["email", "E-Mail-Adresse des Kunden"], ["telefon", "Telefonnummer des Kunden"]],
        "Nachricht senden": [["text", "Inhalt der Nachricht"]],
      };
      fields.push(h("div", { class: "field" }, h("span", { class: "lbl", text: "Integration" }), h("div", { class: "chips" }, BRANDS.map((b) => h("button", { type: "button", class: "chip", "aria-pressed": String(sel.label === b), text: b, onclick: () => { sel.label = sel.label === b ? "" : b; changed({ rerender: true, prompt: false }); } })))));
      fields.push(field("Name (wird im Ablauf angezeigt)", null, h("input", { class: "input", value: sel.label || "", placeholder: "z. B. Gmail", oninput: (e) => { sel.label = e.target.value; changed({ prompt: false }); }, onchange: settle })));
      fields.push(sv("url", "Webhook-URL (https)", "https://hook.eu.make.com/…", "Make, Zapier oder n8n geben dir so eine Adresse. Von dort geht es weiter zu Google Kalender, Sheets, HubSpot und mehr."));
      fields.push(toggleOf(sel.tool, "on", "Der Agent darf diesen Webhook im Gespräch selbst aufrufen"));
      if (sel.tool.on) {
        const desc = h("textarea", { class: "textarea", rows: 2, placeholder: "Was macht dieser Webhook? Wann soll der Agent ihn nutzen?", oninput: (e) => { sel.tool.description = e.target.value; changed({ prompt: false }); } });
        desc.value = sel.tool.description || "";
        fields.push(field("Beschreibung", "Das liest der Agent, um zu entscheiden, wann er den Webhook aufruft.", desc));
        fields.push(toggleOf(sel.tool, "returnResponse", "Antwort zurück in den KI-Kontext geben"));
        const rows = h("div", { class: "fields" }, sel.tool.fields.map((fl, idx) => h("div", { class: "ws-field-row" },
          h("input", { class: "input mono", "aria-label": "Schlüssel", placeholder: "schluessel", value: fl.key, oninput: (e) => { fl.key = e.target.value; changed({ prompt: false }); } }),
          h("input", { class: "input", "aria-label": "Beschreibung oder fester Wert", placeholder: "Was der Agent einträgt", value: fl.desc, oninput: (e) => { fl.desc = e.target.value; changed({ prompt: false }); } }),
          h("input", { class: "input", "aria-label": "Fester Wert", placeholder: "fester Wert (optional)", value: fl.fixed || "", oninput: (e) => { fl.fixed = e.target.value; changed({ prompt: false }); } }),
          h("button", { type: "button", class: "x", "aria-label": "Feld entfernen", text: "×", onclick: () => { sel.tool.fields.splice(idx, 1); changed({ rerender: true, prompt: false }); } }))));
        const tpl = h("select", { class: "input select", "aria-label": "Vorlage", onchange: (e) => { const t = TEMPLATES[e.target.value]; if (t) { sel.tool.fields = t.map(([key, desc]) => ({ key, desc, fixed: "" })); changed({ rerender: true, prompt: false }); } } }, h("option", { value: "", text: "Vorlage für Felder …" }), Object.keys(TEMPLATES).map((k) => h("option", { value: k, text: k })));
        fields.push(field("Felder", "Diese Schlüssel füllt der Agent aus dem Gespräch. Trag rechts einen festen Wert ein, wenn er immer gleich ist.", h("div", { class: "fields" }, tpl, rows,
          h("div", null, h("button", { type: "button", class: "btn", onclick: () => { sel.tool.fields.push({ key: "", desc: "", fixed: "" }); changed({ rerender: true, prompt: false }); } }, icon("plus", 16), "Feld hinzufügen")))));
        fields.push(h("div", { class: "note", text: "Im Testchat wird der Webhook nicht aufgerufen. „Test senden“ schickt Beispieldaten an die Adresse. Die Antwort des Dienstes gilt für den Agenten als Daten, nicht als Anweisung." }));
      }
      fields.push(sv("secret", "Signatur-Schlüssel (optional)", "beliebiges Geheimnis", "Mit diesem Schlüssel signieren wir jede Anfrage (Header X-Agentenwerk-Signature, HMAC-SHA256)."));
    }
    if (sel.type === "slack") fields.push(sv("url", "Slack Webhook-Adresse", "https://hooks.slack.com/services/…", "In Slack: App „Incoming Webhooks“ aktivieren und einen Kanal wählen."));
    if (sel.type === "discord") fields.push(sv("url", "Discord Webhook-Adresse", "https://discord.com/api/webhooks/…", "Kanal-Einstellungen → Integrationen → Webhooks."));
    if (sel.type === "telegram") {
      fields.push(sv("token", "Bot-Token", "123456:ABC…", "Bei @BotFather in Telegram einen Bot anlegen."));
      fields.push(field("Chat-ID", "Schreibe deinem Bot eine Nachricht und rufe https://api.telegram.org/bot<Token>/getUpdates auf, dort steht die ID.", h("input", { class: "input", value: sel.chatId || "", placeholder: "123456789", oninput: (e) => { sel.chatId = e.target.value; changed({ prompt: false }); }, onchange: settle })));
    }
    const ev = (k, label) => { const b = h("button", { type: "button", class: "chip", "aria-pressed": String(sel.events.includes(k)), text: label });
      b.addEventListener("click", () => { sel.events = sel.events.includes(k) ? sel.events.filter((x) => x !== k) : [...sel.events, k]; b.setAttribute("aria-pressed", String(sel.events.includes(k))); changed({ prompt: false }); }); return b; };
    const testMsg = h("span", { class: "hint", role: "status" });
    const testBtn = h("button", { type: "button", class: "btn", text: "Test senden", disabled: !cfg.id });
    testBtn.addEventListener("click", async () => {
      testMsg.textContent = "Sendet …";
      try { await flush(); await api("POST", `/api/agents/${cfg.id}/integrations/${sel.id}/test`, {}); testMsg.textContent = "Test gesendet."; }
      catch (e) { testMsg.textContent = e.message; }
    });
    f.append(h("div", { class: "panel inner" },
      h("h3", { text: sel.label || INT[sel.type][0] }), ...fields,
      sel.type === "webhook" && sel.tool?.on ? null : field("Auslöser", null, h("div", { class: "chips" }, ev("lead", "Neuer Kontakt"), ev("termin", "Terminanfrage"))),
      toggleOf(sel, "enabled", "Verbindung aktiv"),
      h("div", { class: "toolbar" }, testBtn,
        h("button", { type: "button", class: "btn ghost", text: "Entfernen", onclick: () => { cfg.integrations = cfg.integrations.filter((x) => x.id !== sel.id); flowSelected = null; changed({ rerender: true }); } }), testMsg),
      cfg.id ? null : h("p", { class: "hint", text: "Speichere den Agenten zuerst (er speichert automatisch), dann kannst du testen." })));
  },
  prompt(f) {
    const manual = cfg.promptOverride != null;
    const meta = h("span", { class: "meta", id: "promptMeta", text: promptMeta() });
    const ta = h("textarea", { class: "textarea mono", id: "f_prompt", rows: 24, readonly: manual ? null : true, oninput: (e) => { cfg.promptOverride = e.target.value; meta.textContent = promptMeta(); changed({ prompt: false }); } });
    ta.value = activePrompt(cfg);
    f.append(h("div", { class: "toolbar" },
      manual
        ? h("button", { type: "button", class: "btn", text: "Zurück zum generierten Prompt", onclick: () => { cfg.promptOverride = null; changed({ rerender: true }); } })
        : h("button", { type: "button", class: "btn", text: "Von Hand bearbeiten", onclick: () => { cfg.promptOverride = buildPrompt(cfg); changed({ rerender: true }); } }),
      copyBtn("Kopieren", () => activePrompt(cfg)), meta));
    if (manual) f.append(h("div", { class: "note" }, h("strong", { text: "Manueller Modus. " }), "Änderungen in den anderen Bereichen wirken sich nicht mehr auf den Prompt aus, bis du zum generierten Prompt zurückkehrst."));
    f.append(ta);
  },
  embed(f) {
    if (!cfg.id) {
      f.append(h("div", { class: "note", text: "Der Agent ist noch nicht gespeichert. Ändere ein Feld, dann erscheint hier der Einbau-Code." }));
    } else {
      const base = status.publicUrl.replace(/\/$/, "");
      const snippet = `<script src="${base}/widget.js" data-agent="${cfg.id}" defer></script>`;
      f.append(field("Einbau-Code", "Füge diese Zeile vor dem schließenden </body> deiner Website ein. Das funktioniert auch in WordPress, Wix, Jimdo oder Shopify über ein HTML-Element.",
        h("div", { class: "fields", style: "gap:8px" }, h("pre", { class: "code", text: snippet }), h("div", { class: "toolbar" }, copyBtn("Code kopieren", () => snippet),
          h("a", { class: "btn", href: `/demo.html?agent=${encodeURIComponent(cfg.id)}`, target: "_blank", rel: "noopener", text: "Auf Testseite ansehen" })))));
      if (/localhost|127\.0\.0\.1/.test(base)) f.append(h("div", { class: "note" }, h("strong", { text: "Hinweis: " }), "Der Server läuft lokal. Damit Besucher deiner Website chatten können, muss er öffentlich erreichbar sein (PUBLIC_URL in der .env setzen)."));
      const origins = h("textarea", { class: "textarea", id: "f_origins", rows: 3, placeholder: "https://www.deine-firma.de" });
      origins.value = cfg.allowedOrigins.join("\n");
      origins.addEventListener("input", () => { cfg.allowedOrigins = origins.value.split("\n").map((x) => x.trim()).filter(Boolean); changed({ prompt: false }); });
      f.append(field("Erlaubte Websites", "Eine Adresse pro Zeile, mit https://. Leer lassen erlaubt jede Website. Empfohlen: nur deine eigene Domain eintragen.", origins, "origins"));
    }

    const json = () => JSON.stringify({ format: "agentenwerk/1", ...Object.fromEntries(Object.entries(cfg).filter(([k]) => !["id", "createdAt", "updatedAt"].includes(k))), systemPrompt: activePrompt(cfg) }, null, 2);
    const pre = h("textarea", { class: "textarea mono", id: "f_json", rows: 10, readonly: true });
    pre.value = json();
    f.append(field("Konfiguration (JSON)", "Enthält alle Einstellungen und den fertigen System-Prompt.", h("div", { class: "fields", style: "gap:8px" }, h("div", { class: "toolbar" }, copyBtn("JSON kopieren", json)), pre)));

    const imp = h("textarea", { class: "textarea mono", id: "f_import", rows: 4, placeholder: "JSON eines exportierten Agenten hier einfügen" });
    const msg = h("p", { class: "hint" });
    f.append(field("Agent importieren", "Legt einen neuen Agenten aus einer exportierten Konfiguration an.", h("div", { class: "fields", style: "gap:8px" }, imp,
      h("div", { class: "toolbar" }, h("button", { type: "button", class: "btn", text: "Importieren", onclick: async () => {
        let o;
        try { o = JSON.parse(imp.value); if (!o || typeof o !== "object") throw 0; } catch { msg.textContent = "Das ist kein gültiges JSON. Füge die komplette Konfiguration aus „JSON kopieren“ ein."; return; }
        delete o.systemPrompt; delete o.format; delete o.id;
        if (cfg.id) await flush();
        cfg = withDefaults(o); importState = null; section = "basis";
        scheduleSave(); renderAll(); resetChat(); watchCaptured();
      } }), msg))));

    if (isKunde()) return;
    const del = h("div", { class: "toolbar" });
    const renderDel = (ask) => {
      del.replaceChildren();
      if (!ask) del.append(h("button", { type: "button", class: "btn danger", text: "Agent löschen", disabled: !cfg.id || null, onclick: () => renderDel(true) }));
      else del.append(h("span", { text: `„${cfg.name || "Ohne Namen"}“, alle Leads und Gespräche endgültig löschen?` }),
        h("button", { type: "button", class: "btn danger", text: "Ja, löschen", onclick: deleteAgent }),
        h("button", { type: "button", class: "btn ghost", text: "Abbrechen", onclick: () => renderDel(false) }));
    };
    renderDel(false);
    f.append(field("Agent entfernen", null, del));
  },
};
function promptMeta() { const p = activePrompt(cfg); return `${p.length.toLocaleString("de-DE")} Zeichen · ca. ${Math.ceil(p.length / 3.6).toLocaleString("de-DE")} Tokens`; }
function refreshPromptView() {
  if (section === "prompt" && cfg.promptOverride == null) { const t = $("f_prompt"); if (t) t.value = buildPrompt(cfg); const m = $("promptMeta"); if (m) m.textContent = promptMeta(); }
}
function copyBtn(label, get) {
  const b = h("button", { type: "button", class: "btn", text: label });
  b.addEventListener("click", () => {
    const done = (t) => { b.textContent = t; setTimeout(() => (b.textContent = label), 1600); };
    if (!navigator.clipboard) return done("Bitte manuell markieren");
    navigator.clipboard.writeText(get()).then(() => done("Kopiert"), () => done("Bitte manuell markieren"));
  });
  return b;
}

async function deleteAgent() {
  clearTimeout(saveTimer);
  try { await api("DELETE", `/api/agents/${cfg.id}`); } catch (e) { if (!(e instanceof AuthError)) setSave("error", "Löschen fehlgeschlagen"); return; }
  agents = agents.filter((a) => a.id !== cfg.id);
  if (agents.length) loadAgent(agents[0]);
  else { cfg = fromTemplate("blank"); section = "basis"; importState = null; setSave("example", "Neu"); renderAll(); resetChat(); watchCaptured(); }
}

/* ---------- widget preview + test chat ---------- */
function inkFor(hex) {
  const n = parseInt(hex.slice(1), 16), r = n >> 16 & 255, g = n >> 8 & 255, b = n & 255;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.6 ? "#111" : "#fff";
}
function applyWidgetLook() {
  const w = $("widget");
  w.style.setProperty("--w", cfg.color);
  w.style.setProperty("--w-ink", inkFor(cfg.color));
  $("wName").textContent = cfg.widgetTitle || (cfg.name || "Agent") + (cfg.company ? ` · ${cfg.company}` : "");
  $("wAv").textContent = (cfg.initials || cfg.name.slice(0, 2) || "A").toUpperCase();
  $("wFoot").textContent = `Testmodus · Widget ${cfg.position === "left" ? "unten links" : "unten rechts"}`;
}

let conversationId = null, started = false, busy = false, controller = null;
function bubble(cls, text) {
  const el = h("div", { class: "msg " + cls, text });
  $("wBody").append(el);
  $("wBody").scrollTop = $("wBody").scrollHeight;
  return el;
}
function eventChip(text) { $("wBody").append(h("div", { class: "event", text })); $("wBody").scrollTop = $("wBody").scrollHeight; }
function renderQuick() {
  const q = $("wQuick"); q.replaceChildren();
  if (started) return;
  cfg.quickReplies.filter((x) => x.trim()).forEach((x) => q.append(h("button", { type: "button", text: x, onclick: () => send(x) })));
}
function resetChat() {
  if (controller) controller.abort();
  conversationId = null; started = false; busy = false;
  $("wBody").replaceChildren();
  bubble("bot", cfg.welcome || "Hallo!");
  renderQuick(); applyWidgetLook();
  $("wSend").disabled = false;
}
$("resetChat").addEventListener("click", resetChat);
$("wForm").addEventListener("submit", (e) => { e.preventDefault(); const v = $("wInput").value.trim(); if (v) { $("wInput").value = ""; send(v); } });

async function send(text) {
  if (busy) return;
  started = true; renderQuick();
  bubble("user", text);
  busy = true; $("wSend").disabled = true;
  const out = bubble("bot typing", "schreibt …");
  let got = "";
  if (!cfg.id) await flush();
  controller = new AbortController();
  try {
    await apiStream("/api/test-chat", { agent: cfg, conversationId, message: text }, (name, data) => {
      if (name === "conversation") conversationId = data.id;
      else if (name === "text") { got += data.delta; out.className = "msg bot"; out.textContent = got; $("wBody").scrollTop = $("wBody").scrollHeight; }
      else if (name === "replace") { got = data.text; out.className = "msg bot"; out.textContent = got; }
      else if (name === "captured") { eventChip(data.type === "termin" ? "Terminanfrage gespeichert" : "Kontakt gespeichert"); refreshCaptured(); }
      else if (name === "error") throw new Error(data.message);
    }, controller.signal);
    if (!got.trim()) { out.className = "msg bot"; out.textContent = "…"; }
  } catch (e) {
    if (e.name === "AbortError") return;
    if (!got) out.remove();
    bubble("err", e instanceof AuthError ? "Bitte erneut anmelden." : e.message);
  } finally {
    if (controller && !controller.signal.aborted) { busy = false; $("wSend").disabled = false; }
    controller = null;
    refreshCaptured();
  }
}

/* ---------- captured list ---------- */
const FIELD_LABELS = { ...LEAD_FIELDS, leistung: "Leistung", datum: "Datum", uhrzeit: "Uhrzeit", notiz: "Notiz" };
const fmt = (t) => new Date(t).toLocaleString("de-DE", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
function renderCaptured() {
  $("capCount").textContent = String(captured.length);
  const v = $("capView"); v.replaceChildren();
  v.append(h("div", { class: "toolbar" }, h("button", { type: "button", class: "btn", text: "Aktualisieren", onclick: refreshCaptured })));
  v.append(h("div", { class: "cap-section", text: "Leads & Terminanfragen" }));
  if (!captured.length) {
    v.append(h("div", { class: "empty" }, h("strong", { text: "Noch nichts erfasst" }), cfg.goal === "booking" ? "Buche im Testchat einen Termin. Die Anfrage erscheint dann hier." : "Hinterlass im Testchat deine Kontaktdaten. Sie erscheinen dann hier."));
  }
  for (const c of captured) {
    const dl = h("dl");
    for (const [k, val] of Object.entries(c.data || {})) dl.append(h("dt", { text: FIELD_LABELS[k] || k }), h("dd", { text: val }));
    v.append(h("div", { class: "cap" },
      h("div", { class: "cap-top" },
        h("span", null, h("span", { class: "badge " + (c.type === "termin" ? "termin" : "lead"), text: c.type === "termin" ? "Terminanfrage" : "Kontakt" }), c.test ? " " : null, c.test ? h("span", { class: "badge test", text: "Test" }) : null),
        h("span", { class: "meta", text: fmt(c.at) })),
      dl));
  }
  if (conversations.length) {
    v.append(h("div", { class: "cap-section", text: `Letzte Gespräche (${conversations.length})` }));
    for (const c of conversations.slice(0, 30)) {
      const first = c.messages.find((m) => m.role === "user");
      const det = h("details", { class: "conv" },
        h("summary", null, h("span", { class: "meta", text: fmt(c.lastAt || c.startedAt) + (c.test ? " · Test" : "") + (c.channel === "telefon" ? ` · Telefon${c.from ? " " + c.from : ""}` : "") + ` · ${c.messages.length} Nachrichten` }), h("p", { text: first ? first.text.slice(0, 120) : "" })));
      for (const m of c.messages) det.append(h("p", null, h("span", { class: "who", text: m.role === "user" ? "Besucher: " : (cfg.name || "Agent") + ": " }), m.text));
      v.append(det);
    }
  }
}

/* ---------- tabs ---------- */
function sideTab(which) {
  $("tChat").setAttribute("aria-selected", String(which === "chat"));
  $("tCap").setAttribute("aria-selected", String(which === "cap"));
  $("chatView").hidden = which !== "chat";
  $("capView").hidden = which !== "cap";
  if (which === "cap") refreshCaptured();
}
$("tChat").addEventListener("click", () => sideTab("chat"));
$("tCap").addEventListener("click", () => sideTab("cap"));
function mobileView(v) {
  $("bench").dataset.mview = v;
  $("mBuild").setAttribute("aria-selected", String(v === "build"));
  $("mTest").setAttribute("aria-selected", String(v === "test"));
}
$("mBuild").addEventListener("click", () => mobileView("build"));
$("mTest").addEventListener("click", () => mobileView("test"));
window.addEventListener("beforeunload", () => { if (saveEl.dataset.s === "saving") flush(); });

/* ---------- views ---------- */
async function openAgentById(id) {
  await flush();
  try { agents = await api("GET", "/api/agents"); } catch { return; }
  const a = agents.find((x) => x.id === id);
  if (a) { showView("builder"); section = "basis"; loadAgent(a); }
}
const reviewView = mountReview({ root: $("reviewView"), api, h, icon, getStatus: () => status, onExit: () => showView(reviewReturn), openAgent: openAgentById });
let reviewReturn = "acquisition";
async function startReview({ leadIds, start = 0, label, from = "acquisition" }) {
  reviewReturn = from;
  showView("review");
  await reviewView.open({ leadIds, start, label });
}
const autopilotView = mountAutopilot({ root: $("autopilotView"), api, h, headers, getStatus: () => status, openAgent: openAgentById, onReview: (o) => startReview({ ...o, from: "autopilot" }) });
const acquisitionView = mountAcquisition({ root: $("acquisitionView"), api, h, getStatus: () => status, openAgent: openAgentById, onReview: (o) => startReview({ ...o, from: "acquisition" }) });
const usersView = mountUsers({ root: $("usersView"), api, h, getStatus: () => status, onChange: refreshStatus });
const homeView = mountHome({ root: $("homeView"), api, h, icon, getStatus: () => status, go: (v) => showView(v), onNew: newAgent, onEdit: openAgentById });
// A ready-made agent that knows the seven GitHub projects (public/examples/mein-agent.json).
async function seedProjectsAgent() {
  try {
    const res = await fetch("/examples/mein-agent.json");
    if (!res.ok) throw new Error("Die Vorlage wurde nicht gefunden.");
    const o = await res.json();
    delete o.format; delete o.id;
    const saved = await api("POST", "/api/agents", withDefaults(o));
    agents = await api("GET", "/api/agents");
    await openAgentById(saved.id);
    section = "wissen"; renderRail(); renderForm();
  } catch (e) {
    if (!(e instanceof AuthError)) alert_(e.message);
  }
}
function alert_(text) { const b = $("banner"); b.replaceChildren(h("p", { text })); b.hidden = false; }
const agentsView = mountAgents({ root: $("agentsView"), api, h, icon, getStatus: () => status, onNew: newAgent, onEdit: openAgentById, onSeed: seedProjectsAgent });

const customersView = mountCustomers({ root: $("customersView"), api, h, icon, getStatus: () => status });
const websiteView = mountWebsite({ root: $("websiteView"), api, h, icon });
const jarvisView = mountJarvis({ root: $("jarvisView"), api, h, icon });
const systemView = mountSystem({ root: $("systemView"), api, h, icon, onSaved: refreshStatus });
const accountView = mountAccount({ root: $("accountView"), api, h, icon, getStatus: () => status });
const mentoringView = mountMentoring({ root: $("mentoringView"), h, icon, getStatus: () => status });

// Navigation: one entry per page, filtered by role.
const PAGES = [
  { id: "home", label: "Start", icon: "home", el: "homeView", ctl: homeView },
  { id: "agents", label: "Agenten", icon: "bot", el: "agentsView", ctl: agentsView },
  { id: "builder", label: "Editor", icon: "edit", el: "bench" },
  { id: "autopilot", label: "Autopilot", icon: "upload", el: "autopilotView", ctl: autopilotView, staff: true, locked: true },
  { id: "acquisition", label: "Akquise", icon: "send", el: "acquisitionView", ctl: acquisitionView, staff: true, glow: true, locked: true },
  { id: "customers", label: "Kunden", icon: "users", el: "customersView", ctl: customersView, staff: true },
  { id: "website", label: "Deine Website", icon: "globe", el: "websiteView", ctl: websiteView, staff: true },
  { id: "mentoring", label: "1:1 Mentoring", icon: "spark", el: "mentoringView", ctl: mentoringView, abo: true, glow: true },
  { id: "users", label: "Nutzer", icon: "users", el: "usersView", ctl: usersView, admin: true },
  { id: "jarvis", label: "JARVIS", icon: "rocket", el: "jarvisView", ctl: jarvisView, admin: true },
  { id: "system", label: "System", icon: "settings", el: "systemView", ctl: systemView, admin: true },
  { id: "account", label: "Konto", icon: "card", el: "accountView", ctl: accountView },
  { id: "review", label: "Durchgehen", icon: "send", el: "reviewView", ctl: reviewView, staff: true, hiddenInNav: true, locked: true },
];
const billingBlocked = () => Boolean(status.billing) && !["active", "trialing", "past_due"].includes(status.billing.status);
const isLocked = (p) => p.locked && me().role === "abo" && !me().autopilotAllowed;
let currentView = "home";
const viewAllowed = (v) => {
  const p = PAGES.find((x) => x.id === v);
  if (!p) return false;
  if (billingBlocked()) return v === "account";
  if (p.admin) return me().role === "admin";
  if (p.abo) return me().role === "abo";
  if (p.staff) return !isKunde();
  return true;
};
function renderNav() {
  const list = $("navList");
  list.replaceChildren(...PAGES.filter((p) => viewAllowed(p.id) && !p.hiddenInNav).map((p) => {
    const b = h("button", { type: "button", class: "nav-item" + (p.glow ? " glow" : "") + (isLocked(p) ? " locked" : ""), "aria-current": p.id === currentView || (p.id === reviewReturn && currentView === "review") ? "page" : null, onclick: () => { showView(p.id); closeNav(); } },
      icon(p.icon, 20), h("span", { text: p.label }));
    if (p.locked && me().role === "abo") b.append(h("span", { class: "nav-lock", title: isLocked(p) ? "Wird im Mentoring freigeschaltet" : "Freigeschaltet" }, icon(isLocked(p) ? "lock" : "unlock", 16)));
    if (p.id === "users" && status.pendingUsers) b.append(h("span", { class: "count", text: String(status.pendingUsers) }));
    return b;
  }));
  $("navFoot").replaceChildren(h("button", { type: "button", class: "nav-item", onclick: logout }, icon("logout", 20), h("span", { text: "Abmelden" })));
}
function openNav() { $("sidenav").classList.add("open"); $("navBackdrop").hidden = false; $("navOpen").setAttribute("aria-expanded", "true"); $("navClose").focus(); }
function closeNav() { $("sidenav").classList.remove("open"); $("navBackdrop").hidden = true; $("navOpen").setAttribute("aria-expanded", "false"); }
$("navOpen").append(icon("menu", 22));
$("navClose").append(icon("close", 22));
$("logoutTop").append(icon("logout", 20));
$("navOpen").addEventListener("click", openNav);
$("navClose").addEventListener("click", closeNav);
$("navBackdrop").addEventListener("click", closeNav);
$("logoutTop").addEventListener("click", logout);
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && $("sidenav").classList.contains("open")) closeNav(); });

function renderSupportBar() {
  const bar = $("supportBar");
  const sup = status.me?.support;
  bar.hidden = !sup;
  if (!sup) return;
  bar.replaceChildren(h("span", { text: `Support-Modus für ${status.me.name} bis ${new Date(sup.until).toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" })}. Löschen und Abrechnung sind gesperrt, jeder Zugriff wird protokolliert.` }),
    h("button", { type: "button", class: "btn", text: "Support beenden", onclick: async () => { try { await api("POST", "/api/support/stop", {}); } finally { location.reload(); } } }));
}
async function refreshStatus() {
  try { status = await api("GET", "/api/status"); } catch { return; }
  renderSupportBar();
  renderNav();
  renderUsage();
}
// Like a credit counter: what is left of this month's plan.
function renderUsage() {
  const chip = $("usageChip");
  const u = status.usage;
  if (!u?.limits) { chip.hidden = true; return; }
  chip.hidden = false;
  chip.replaceChildren(icon("spark", 16), h("span", { text: `${Math.max(0, u.limits.chats - u.chats).toLocaleString("de-DE")}` }), h("span", { class: "meta", text: "Nachrichten frei" }));
  chip.title = `Diesen Monat: ${u.analyses}/${u.limits.analyses} Analysen, ${u.chats}/${u.limits.chats} Chat-Nachrichten`;
  chip.onclick = () => showView("account");
}
function showView(v) {
  const target = PAGES.find((p) => p.id === v);
  if (target && isLocked(target)) v = "mentoring";
  if (!viewAllowed(v)) v = billingBlocked() ? "account" : "home";
  const prev = PAGES.find((p) => p.id === currentView);
  if (prev?.ctl && prev.id !== v) prev.ctl.hide();
  currentView = v;
  for (const p of PAGES) $(p.el).hidden = p.id !== v;
  $("agentSwitch").hidden = v !== "builder";
  const page = PAGES.find((p) => p.id === v);
  $("pageTitle").textContent = page.label;
  document.title = `${page.label} · Agentenwerk`;
  page.ctl?.show();
  if (v === "builder") api("GET", "/api/agents").then((a) => { agents = a; renderAgentSelect(); }).catch(() => {});
  renderNav();
  if (v !== "review") local.set("agentenwerk.view", v);
  window.scrollTo(0, 0);
}

/* ---------- boot ---------- */
function renderAll() { renderRail(); renderForm(); applyWidgetLook(); renderAgentSelect(); }

async function boot() {
  try {
    status = await api("GET", "/api/status");
    agents = billingBlocked() ? [] : await api("GET", "/api/agents");
  } catch (e) {
    if (!(e instanceof AuthError)) showGate("Fehler beim Laden: " + e.message);
    return;
  }
  $("gate").hidden = true;
  $("appRoot").hidden = false;
  renderMe();
  renderUsage();
  renderNav();
  const params = new URLSearchParams(location.search);
  const checkout = params.get("checkout");
  const wantAccount = params.get("view") === "account";
  if (checkout || params.get("view")) history.replaceState(null, "", "/");
  if (checkout === "success" && billingBlocked()) {
    // Stripe's webhook may arrive a moment after the redirect back.
    for (let i = 0; i < 10 && billingBlocked(); i++) { await new Promise((r) => setTimeout(r, 1500)); await refreshStatus(); }
    if (!billingBlocked()) agents = await api("GET", "/api/agents").catch(() => []);
  }
  const banner = $("banner");
  const notes = [];
  if (!status.aiConfigured && me().role === "admin") notes.push(h("p", null, `${status.keyName} fehlt noch. `, h("button", { type: "button", class: "linkish", text: "Unter System eintragen", onclick: () => showView("system") })));
  if (me().id === "local") notes.push(h("p", null, "Noch kein Konto angelegt. ", h("button", { type: "button", class: "linkish", text: "Jetzt Admin-Zugang anlegen", onclick: () => showView("users") })));
  if (checkout === "success") notes.push(h("p", { text: billingBlocked() ? "Danke! Die Zahlung wird noch bestätigt. Lade die Seite in einer Minute neu." : "Danke! Dein Abo ist aktiv. Leg los mit deinem ersten Agenten." }));
  if (checkout === "cancel") notes.push(h("p", { text: "Die Bezahlung wurde abgebrochen. Du kannst sie unter Konto jederzeit nachholen." }));
  banner.replaceChildren(...notes);
  banner.hidden = !notes.length;
  if (agents.length) loadAgent(agents[0]);
  else { cfg = fromTemplate("blank"); setSave("example", "Neu · wird beim ersten Bearbeiten gespeichert"); renderAll(); resetChat(); renderCaptured(); }
  showView(billingBlocked() || wantAccount ? "account" : checkout === "success" ? "home" : (local.get("agentenwerk.view") || "home"));
}
boot();
