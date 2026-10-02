// Integrations: where an agent sends what it captures (lead, appointment).
// Every integration is outgoing only. Secrets (URLs, tokens) are write-only:
// the browser sees whether one is set, never the value.
import crypto from "node:crypto";
import { assertPublicHost } from "./crawl.js";

export const TYPES = {
  email: { label: "E-Mail", secret: [], needs: ["to"] },
  webhook: { label: "Webhook (Zapier, Make, n8n …)", secret: ["url", "secret"], needs: ["url"] },
  slack: { label: "Slack", secret: ["url"], needs: ["url"], host: /^hooks\.slack\.com$/ },
  discord: { label: "Discord", secret: ["url"], needs: ["url"], host: /^(discord|discordapp)\.com$/ },
  telegram: { label: "Telegram", secret: ["token"], needs: ["token", "chatId"] },
};
const EVENTS = ["lead", "termin"];
const SECRET_FIELDS = ["url", "secret", "token"];
const clip = (v, n) => String(v ?? "").trim().slice(0, n);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class IntegrationError extends Error {}

function urlProblem(type, url) {
  let u;
  try { u = new URL(url); } catch { return "Die Adresse ist ungültig."; }
  if (u.protocol !== "https:") return "Die Adresse muss mit https:// beginnen.";
  if (u.username || u.password) return "Die Adresse darf keine Zugangsdaten enthalten.";
  const rule = TYPES[type].host;
  if (rule && !rule.test(u.hostname)) return `Das ist keine ${TYPES[type].label}-Adresse.`;
  return "";
}

// incoming: from the browser; existing: what is stored. Empty secret = keep stored value.
export function sanitizeIntegrations(incoming, existing = []) {
  const old = new Map((existing || []).map((i) => [i.id, i]));
  const out = [];
  for (const raw of Array.isArray(incoming) ? incoming.slice(0, 12) : []) {
    if (!raw || !TYPES[raw.type]) continue;
    const id = /^[\w-]{4,30}$/.test(raw.id || "") ? raw.id : crypto.randomBytes(6).toString("base64url");
    const prev = old.get(id);
    const i = { id, type: raw.type, enabled: raw.enabled !== false, events: EVENTS.filter((e) => (raw.events || EVENTS).includes(e)) };
    i.label = clip(raw.label, 40);
    i.to = clip(raw.to, 200);
    i.chatId = clip(raw.chatId, 40);
    for (const f of SECRET_FIELDS) {
      const v = clip(raw[f], 500);
      i[f] = v || (prev?.type === raw.type ? prev[f] || "" : "");
    }
    // A webhook can also be a tool the agent calls itself, with fields it fills from the conversation.
    const t = raw.tool && typeof raw.tool === "object" ? raw.tool : (prev?.tool || {});
    if (raw.type === "webhook") {
      const seen = new Set();
      i.tool = {
        on: Boolean(t.on),
        description: clip(t.description, 300),
        returnResponse: Boolean(t.returnResponse),
        fields: (Array.isArray(t.fields) ? t.fields : []).slice(0, 12).map((f) => ({ key: clip(f?.key, 30).toLowerCase(), desc: clip(f?.desc, 200), fixed: clip(f?.fixed, 200) }))
          .filter((f) => /^[a-z][a-z0-9_]{0,29}$/.test(f.key) && !seen.has(f.key) && seen.add(f.key)),
      };
      if (i.tool.on) i.events = [];
    }
    if (i.type === "email" && i.to && !EMAIL.test(i.to)) throw new IntegrationError("Bitte eine gültige E-Mail-Adresse angeben.");
    if (i.url) { const p = urlProblem(i.type, i.url); if (p) throw new IntegrationError(p); }
    out.push(i);
  }
  return out;
}

export function maskIntegrations(list) {
  return (list || []).map((i) => {
    const m = { ...i, has: {}, hint: {} };
    for (const f of SECRET_FIELDS) { m.has[f] = Boolean(i[f]); m.hint[f] = i[f] ? `…${i[f].slice(-4)}` : ""; m[f] = ""; }
    return m;
  });
}

export const maskAgent = (agent) => (agent && agent.integrations ? { ...agent, integrations: maskIntegrations(agent.integrations) } : agent);

export const isTool = (i) => i.type === "webhook" && i.tool?.on && ready(i);
export const toolName = (i) => `hook_${i.id}`.replace(/[^\w-]/g, "_").slice(0, 60);

export const ready = (i) => i.enabled && TYPES[i.type].needs.every((k) => i[k]);

const KIND = { lead: "Neuer Kontakt", termin: "Neue Terminanfrage" };
const LABEL = { name: "Name", email: "E-Mail", phone: "Telefon", leistung: "Leistung", datum: "Datum", uhrzeit: "Uhrzeit", message: "Nachricht", company: "Firma" };

export function describe(event) {
  const lines = Object.entries(event.data || {}).map(([k, v]) => `${LABEL[k] || k}: ${v}`);
  const head = `${KIND[event.type] || "Neuer Eintrag"} bei „${event.agentName || "Agent"}“`;
  return { head, lines, text: [head, ...lines].join("\n") };
}

// Sends one event to one integration. fetchImpl and lookup are injectable for tests.
export async function deliver(i, event, { mailer, fetchImpl = fetch, lookup, timeoutMs = 8000 } = {}) {
  const d = describe(event);
  if (i.type === "email") {
    if (!mailer) throw new IntegrationError("Der E-Mail-Versand ist unter System noch nicht eingerichtet.");
    await mailer.send({ to: i.to, subject: d.head, text: d.lines.join("\n") || d.head, transactional: true });
    return;
  }
  let url, init;
  if (i.type === "telegram") {
    url = `https://api.telegram.org/bot${i.token}/sendMessage`;
    init = { body: JSON.stringify({ chat_id: i.chatId, text: d.text }) };
  } else if (i.type === "slack") {
    url = i.url; init = { body: JSON.stringify({ text: `*${d.head}*\n${d.lines.join("\n")}` }) };
  } else if (i.type === "discord") {
    url = i.url; init = { body: JSON.stringify({ content: `**${d.head}**\n${d.lines.join("\n")}` }) };
  } else {
    url = i.url;
    const body = JSON.stringify({ event: event.type, agent: { id: event.agentId, name: event.agentName }, data: event.data, channel: event.channel || "web", at: new Date(event.at || Date.now()).toISOString() });
    init = { body };
    if (i.secret) init.signature = crypto.createHmac("sha256", i.secret).update(body).digest("hex");
  }
  const u = new URL(url);
  try { await assertPublicHost(u.hostname, lookup); } catch (e) { throw new IntegrationError(e.message); }
  const headers = { "content-type": "application/json", "user-agent": "Agentenwerk" };
  if (init.signature) headers["x-agentenwerk-signature"] = `sha256=${init.signature}`;
  const res = await fetchImpl(url, { method: "POST", headers, body: init.body, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
  if (res.status >= 300) throw new IntegrationError(`Das Ziel antwortete mit ${res.status}.`);
}

// The agent calls a webhook during a chat: returns the (capped) answer text. Values are untrusted model output.
export async function callHook(i, values, { agentId = "", agentName = "", fetchImpl = fetch, lookup, timeoutMs = 8000 } = {}) {
  const body = {};
  for (const f of i.tool.fields) body[f.key] = f.fixed || clip(values?.[f.key], 1000);
  const payload = JSON.stringify({ event: "tool", agent: { id: agentId, name: agentName }, data: body, at: new Date().toISOString() });
  const u = new URL(i.url);
  try { await assertPublicHost(u.hostname, lookup); } catch (e) { throw new IntegrationError(e.message); }
  const headers = { "content-type": "application/json", "user-agent": "Agentenwerk" };
  if (i.secret) headers["x-agentenwerk-signature"] = `sha256=${crypto.createHmac("sha256", i.secret).update(payload).digest("hex")}`;
  const res = await fetchImpl(i.url, { method: "POST", headers, body: payload, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
  if (res.status >= 300) throw new IntegrationError(`Das Ziel antwortete mit ${res.status}.`);
  if (!i.tool.returnResponse) return "Gesendet.";
  const text = (await res.text()).slice(0, 2000).trim();
  return text || "Gesendet (leere Antwort).";
}

// Fire-and-forget for the chat path: a broken integration never breaks the chat.
export async function dispatch(agent, event, deps = {}) {
  const results = [];
  for (const i of agent.integrations || []) {
    if (!ready(i) || isTool(i) || !i.events.includes(event.type)) continue;
    try { await deliver(i, { ...event, agentId: agent.id, agentName: agent.name }, deps); results.push({ id: i.id, ok: true }); }
    catch (e) { results.push({ id: i.id, ok: false, error: e?.message || String(e) }); }
  }
  return results;
}
