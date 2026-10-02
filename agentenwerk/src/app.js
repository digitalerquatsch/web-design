import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Store, newId } from "./store.js";
import { crawlSite, CrawlError } from "./crawl.js";
import { analyzeSite } from "./analyze.js";
import { runTurn } from "./chat.js";
import { checkAdmin, clientIp, RateLimiter, originAllowed } from "./security.js";
import { withDefaults, publicView } from "../public/prompt.js";
import { parseTable, mapRows, toCsv, TableError } from "./table.js";
import { createAutopilot, summarize, ROW_STEPS } from "./autopilot.js";
import { STAGES, FUNNEL, DEFAULT_SETTINGS, addEvent, summarizeLeads, followUpDue, generateDraft, composeEmail, senderComplete, isEmail } from "./outreach.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(here, "..", "public");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".ico": "image/x-icon" };

const MAX_MESSAGE = 2000;
const MAX_TURNS = 40;
const CONV_TTL = 6 * 3600 * 1000;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function send(res, status, body, headers = {}) {
  const data = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, { "content-type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
  res.end(data);
}

async function readJson(req, limit = 400_000) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new HttpError(413, "Die Anfrage ist zu groß.");
    chunks.push(c);
  }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new HttpError(400, "Ungültiges JSON."); }
}

async function readRaw(req, limit) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new HttpError(413, `Die Datei ist zu groß (höchstens ${Math.round(limit / 1e6)} MB).`);
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

function sse(res, headers = {}) {
  res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no", connection: "keep-alive", ...headers });
  let open = true;
  res.on("close", () => { open = false; });
  return {
    get open() { return open; },
    event(name, data) { if (open) res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`); },
    end() { if (open) res.end(); open = false; },
  };
}

// Strips fields a client must not set and fills defaults.
function sanitizeAgent(input, id) {
  const a = withDefaults(input);
  a.id = id;
  a.promptOverride = typeof input.promptOverride === "string" ? input.promptOverride.slice(0, 60000) : null;
  a.knowledge = a.knowledge.slice(0, 80000);
  a.allowedOrigins = a.allowedOrigins.filter((o) => typeof o === "string").map((o) => o.trim().replace(/\/+$/, "")).filter((o) => /^https?:\/\/[^/\s]+$/i.test(o)).slice(0, 20);
  a.quickReplies = a.quickReplies.filter((q) => typeof q === "string").slice(0, 5).map((q) => q.slice(0, 40));
  a.color = /^#[0-9a-f]{6}$/i.test(a.color) ? a.color : "#3a46c9";
  return a;
}

export function createApp({ dataDir, ai, adminToken = "", publicUrl = "", crawl = crawlSite, analyze = analyzeSite, screenshotter = null, autopilotConcurrency = 2, agency = {}, mailer = null } = {}) {
  const store = new Store(dataDir);
  const screenshotDir = path.join(dataDir, "screenshots");
  const autopilot = createAutopilot({ store, crawl, analyze, ai, screenshotter, screenshotDir, concurrency: autopilotConcurrency });
  autopilot.resume().catch((e) => console.error("autopilot resume:", e));
  const baseUrl = (req) => publicUrl || `http://${req.headers.host}`;
  const conversations = new Map(); // id -> { agentId, messages, turns, lastAt, test }
  const chatLimit = new RateLimiter(20, 60_000);
  const analyzeLimit = new RateLimiter(6, 60_000);

  function pruneConversations(now = Date.now()) {
    for (const [id, c] of conversations) if (now - c.lastAt > CONV_TTL) conversations.delete(id);
  }

  async function logMessage(conv, role, text) {
    const row = (await store.get("conversations", conv.id)) || { id: conv.id, agentId: conv.agentId, test: conv.test, startedAt: Date.now(), messages: [] };
    row.messages.push({ role, text, at: Date.now() });
    row.lastAt = Date.now();
    await store.put("conversations", row);
  }

  // Shared by the public widget and the builder's test chat.
  async function chat(req, res, agent, body, { test = false, corsHeaders = {} } = {}) {
    if (!ai.configured) throw new HttpError(503, `${ai.keyName || "Der KI-Schlüssel"} fehlt. Trage ihn in die .env ein und starte den Server neu.`);
    const text = String(body.message || "").trim();
    if (!text) throw new HttpError(400, "Die Nachricht ist leer.");
    if (text.length > MAX_MESSAGE) throw new HttpError(400, `Die Nachricht ist zu lang (höchstens ${MAX_MESSAGE} Zeichen).`);
    if (!chatLimit.allow(clientIp(req))) throw new HttpError(429, "Zu viele Nachrichten. Bitte kurz warten.");

    pruneConversations();
    let conv = typeof body.conversationId === "string" ? conversations.get(body.conversationId) : null;
    if (!conv || conv.agentId !== agent.id) {
      conv = { id: newId(), agentId: agent.id, messages: [], turns: 0, lastAt: Date.now(), test };
      conversations.set(conv.id, conv);
      if (!test) leadEvent(agent.id, "demo_chat");
    }
    if (conv.turns >= MAX_TURNS) throw new HttpError(429, "Diese Unterhaltung ist sehr lang geworden. Bitte eine neue beginnen.");
    if (conv.busy) throw new HttpError(409, "Die vorige Nachricht wird noch beantwortet.");
    conv.busy = true;
    conv.turns++;
    conv.lastAt = Date.now();

    const out = sse(res, corsHeaders);
    out.event("conversation", { id: conv.id });
    try {
      await logMessage(conv, "user", text);
      const { reply, refused } = await runTurn({
        agent, messages: conv.messages, text, ai,
        onText: (delta) => out.event("text", { delta }),
        onCapture: async (type, data) => {
          await store.put("captured", { id: newId(), agentId: agent.id, conversationId: conv.id, type, data, test, at: Date.now() });
          out.event("captured", { type });
          if (!test) leadEvent(agent.id, "demo_lead", { kind: type });
        },
      });
      if (refused) {
        const fallback = "Dabei kann ich leider nicht helfen. Kann ich etwas anderes für Sie tun?";
        out.event("replace", { text: fallback });
        await logMessage(conv, "assistant", fallback);
      } else {
        await logMessage(conv, "assistant", reply);
      }
      out.event("done", {});
    } catch (err) {
      console.error("chat error:", err?.message || err);
      out.event("error", { message: err?.status === 429 ? "Der Dienst ist gerade ausgelastet. Bitte gleich noch einmal versuchen." : "Die Antwort konnte nicht erzeugt werden. Bitte noch einmal versuchen." });
    } finally {
      conv.busy = false;
      out.end();
    }
  }

  async function adminRoute(req, res, url) {
    const auth = checkAdmin(req, adminToken);
    if (!auth.ok) throw new HttpError(auth.status, auth.message);
    const p = url.pathname;
    const m = p.match(/^\/api\/agents\/([\w-]+)(\/[a-z-]+)?$/);

    if (p === "/api/status" && req.method === "GET") {
      return send(res, 200, { aiConfigured: ai.configured, provider: ai.provider || "", keyName: ai.keyName || "KI-Schlüssel", model: ai.model, publicUrl: baseUrl(req), screenshots: Boolean(screenshotter), steps: ROW_STEPS });
    }
    const b = p.match(/^\/api\/batches(?:\/([\w-]+)(\/[a-z]+)?)?$/);
    if (b) return batchRoute(req, res, url, b[1], b[2]);
    if (p === "/api/settings") return settingsRoute(req, res);
    if (p === "/api/acquisition") return send(res, 200, await acquisitionSummary(req));
    const l = p.match(/^\/api\/leads(?:\/([\w-]+)(\/[a-z-]+)?)?$/);
    if (l) return leadRoute(req, res, l[1], l[2]);
    if (p === "/api/agents" && req.method === "GET") {
      const agents = await store.list("agents");
      return send(res, 200, agents.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)));
    }
    if (p === "/api/agents" && req.method === "POST") {
      const body = await readJson(req);
      const agent = { ...sanitizeAgent(body, newId()), createdAt: Date.now(), updatedAt: Date.now() };
      await store.put("agents", agent);
      return send(res, 201, agent);
    }
    if (p === "/api/analyze" && req.method === "POST") {
      if (!ai.configured) throw new HttpError(503, `${ai.keyName || "Der KI-Schlüssel"} fehlt. Trage ihn in die .env ein und starte den Server neu.`);
      if (!analyzeLimit.allow(clientIp(req))) throw new HttpError(429, "Zu viele Analysen. Bitte eine Minute warten.");
      const body = await readJson(req);
      const out = sse(res);
      try {
        const site = await crawl(body.url, { onProgress: (e) => out.event(e.type === "page" ? "page" : "status", e) });
        if (!site.pages.some((pg) => pg.text.length > 200)) throw new CrawlError("Auf der Website war kaum Text zu finden. Wird sie erst per JavaScript aufgebaut? Dann trage die Infos bitte von Hand ein.");
        out.event("status", { message: `${site.pages.length} Seiten gelesen. Der Agent wird eingerichtet …` });
        const result = await analyze(site, { ai });
        out.event("result", result);
      } catch (err) {
        if (!(err instanceof CrawlError)) console.error("analyze error:", err?.message || err);
        out.event("error", { message: err instanceof CrawlError ? err.message : (err?.code === "refusal" ? err.message : "Die Analyse ist fehlgeschlagen. Bitte noch einmal versuchen.") });
      }
      return out.end();
    }
    if (p === "/api/test-chat" && req.method === "POST") {
      const body = await readJson(req);
      const agent = sanitizeAgent(body.agent || {}, String(body.agent?.id || "test"));
      return chat(req, res, agent, body, { test: true });
    }
    if (m) {
      const [, id, sub] = m;
      const agent = await store.get("agents", id);
      if (!agent) throw new HttpError(404, "Agent nicht gefunden.");
      if (!sub && req.method === "GET") return send(res, 200, agent);
      if (!sub && req.method === "PUT") {
        const body = await readJson(req);
        const next = { ...sanitizeAgent(body, id), createdAt: agent.createdAt, updatedAt: Date.now() };
        await store.put("agents", next);
        return send(res, 200, next);
      }
      if (!sub && req.method === "DELETE") {
        await deleteAgents([id]);
        return send(res, 204, "");
      }
      if (sub === "/captured" && req.method === "GET") {
        const rows = await store.list("captured", (r) => r.agentId === id);
        return send(res, 200, rows.sort((a, b) => b.at - a.at));
      }
      if (sub === "/conversations" && req.method === "GET") {
        const rows = await store.list("conversations", (r) => r.agentId === id);
        return send(res, 200, rows.sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0)).slice(0, 200));
      }
    }
    throw new HttpError(404, "Nicht gefunden.");
  }

  async function deleteAgents(ids) {
    const set = new Set(ids);
    await store.remove("agents", (r) => set.has(r.id));
    await store.remove("captured", (r) => set.has(r.agentId));
    await store.remove("conversations", (r) => set.has(r.agentId));
    await store.remove("leads", (r) => set.has(r.agentId));
    for (const [cid, c] of conversations) if (set.has(c.agentId)) conversations.delete(cid);
    for (const id of set) await fs.rm(path.join(screenshotDir, `${id}.jpg`), { force: true });
  }

  async function batchRoute(req, res, url, id, sub) {
    if (!id && req.method === "GET") {
      const all = await store.list("batches");
      return send(res, 200, all.map(summarize).sort((a, b) => b.createdAt - a.createdAt));
    }
    if (!id && req.method === "POST") {
      if (!ai.configured) throw new HttpError(503, `${ai.keyName || "Der KI-Schlüssel"} fehlt. Trage ihn in die .env ein und starte den Server neu.`);
      const buf = await readRaw(req, 5_000_000);
      let mapped;
      try { mapped = mapRows(parseTable(buf, url.searchParams.get("filename") || "")); } catch (e) {
        if (e instanceof TableError) throw new HttpError(400, e.message);
        throw new HttpError(400, "Die Tabelle konnte nicht gelesen werden. Bitte als .xlsx oder .csv speichern.");
      }
      const batch = await autopilot.createBatch({ name: (url.searchParams.get("name") || "").slice(0, 120), rows: mapped.rows, skipped: mapped.skipped });
      return send(res, 201, { ...summarize(batch), columns: mapped.columns, skipped: mapped.skipped });
    }
    const batch = id && await store.get("batches", id);
    if (!batch) throw new HttpError(404, "Durchlauf nicht gefunden.");
    if (!sub && req.method === "GET") {
      return send(res, 200, { ...summarize(batch), skipped: batch.skipped || [], rows: batch.rows.map(({ claimed, ...r }) => r) });
    }
    if (sub === "/retry" && req.method === "POST") {
      return send(res, 200, summarize(await autopilot.retry(id)));
    }
    if (!sub && req.method === "DELETE") {
      await deleteAgents(batch.rows.map((r) => r.agentId).filter(Boolean));
      await store.remove("batches", (r) => r.id === id);
      return send(res, 204, "");
    }
    if (sub === "/export" && req.method === "GET") {
      const base = baseUrl(req);
      const lines = [["Firma", "Website", "Ansprechpartner", "E-Mail", "Telefon", "Ort", "Status", "Demo-Link", "Einbau-Code", "Agent-ID", "Hinweis"]];
      for (const r of batch.rows) {
        const agent = r.agentId ? await store.get("agents", r.agentId) : null;
        lines.push([
          r.company || agent?.company || "", r.url, r.contact, r.email, r.phone, r.city, ROW_STEPS[r.status],
          r.status === "done" ? `${base}/d/${r.agentId}` : "",
          r.status === "done" ? `<script src="${base}/widget.js" data-agent="${r.agentId}" defer></script>` : "",
          r.agentId || "",
          r.error || (agent?.source?.missing?.length ? "Fehlt auf der Website: " + agent.source.missing.join(", ") : ""),
        ]);
      }
      const file = (batch.name || "autopilot").replace(/[^\w\-äöüÄÖÜß ]+/g, "").trim().replace(/\s+/g, "-") || "autopilot";
      res.writeHead(200, { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${file}.csv"`, "cache-control": "no-store" });
      return res.end(toCsv(lines));
    }
    throw new HttpError(404, "Nicht gefunden.");
  }

  async function publicRoute(req, res, url) {
    const pv = url.pathname.match(/^\/api\/public\/agents\/([\w-]+)\/(preview|screenshot)$/);
    if (pv && req.method === "GET") return previewRoute(req, res, pv[1], pv[2], url);
    const un = url.pathname.match(/^\/api\/public\/unsubscribe\/([\w-]{10,})$/);
    if (un && req.method === "POST") return unsubscribe(res, un[1]);
    if (un && req.method === "GET") { res.writeHead(302, { location: `/abmelden/${un[1]}` }); return res.end(); }
    const m = url.pathname.match(/^\/api\/public\/agents\/([\w-]+)(\/chat)?$/);
    if (!m) throw new HttpError(404, "Nicht gefunden.");
    const agent = await store.get("agents", m[1]);
    const origin = req.headers.origin || "";
    const cors = (allowed) => (allowed ? { "access-control-allow-origin": origin || "*", vary: "Origin" } : {});
    if (!agent) return send(res, 404, { error: "Agent nicht gefunden." }, cors(true));
    // The agent's own demo page lives on this server and is always allowed.
    let sameHost = false;
    try { sameHost = !!origin && new URL(origin).host === req.headers.host; } catch { /* malformed Origin */ }
    const allowed = sameHost || originAllowed(agent, origin);

    if (req.method === "OPTIONS") {
      if (!allowed) return send(res, 403, "");
      return send(res, 204, "", { ...cors(true), "access-control-allow-methods": "GET, POST", "access-control-allow-headers": "content-type", "access-control-max-age": "600" });
    }
    if (!allowed) return send(res, 403, { error: "Dieser Agent ist für diese Website nicht freigegeben." });
    if (!m[2] && req.method === "GET") return send(res, 200, publicView(agent), cors(true));
    if (m[2] && req.method === "POST") {
      try {
        const body = await readJson(req, 10_000);
        return await chat(req, res, agent, body, { corsHeaders: cors(true) });
      } catch (err) {
        // Errors before the stream opens still need CORS headers, or the widget cannot read them.
        if (err instanceof HttpError && !res.headersSent) return send(res, err.status, { error: err.message }, cors(true));
        throw err;
      }
    }
    throw new HttpError(405, "Methode nicht erlaubt.");
  }

  /* ---------- acquisition ---------- */

  const tasks = new Set(); // lead ids with a draft or send in progress
  const DAY = 86_400_000;

  async function getSettings() {
    const row = await store.get("settings", "main");
    return { ...DEFAULT_SETTINGS, ...(row || {}), sender: { ...DEFAULT_SETTINGS.sender, ...(row?.sender || {}) } };
  }

  async function leadEvent(agentId, type, data = {}, dedupeMs = 0) {
    try {
      const lead = (await store.list("leads", (x) => x.agentId === agentId))[0];
      if (!lead) return;
      const last = [...lead.events].reverse().find((e) => e.type === type);
      if (dedupeMs && last && Date.now() - last.at < dedupeMs) return;
      addEvent(lead, type, data);
      if (type === "demo_view" && lead.stage === "kontaktiert") lead.stage = "angesehen";
      await store.put("leads", lead);
    } catch (e) {
      console.error("lead event:", e?.message || e);
    }
  }

  async function sentToday() {
    const since = Date.now() - DAY;
    return (await store.list("leads")).reduce((n, l) => n + l.sent.filter((x) => x.at >= since).length, 0);
  }

  async function acquisitionSummary(req) {
    const [leads, settings] = await Promise.all([store.list("leads"), getSettings()]);
    return {
      stages: STAGES, funnel: FUNNEL,
      summary: summarizeLeads(leads, settings),
      mail: { configured: Boolean(mailer), from: mailer?.from || "", dailyLimit: mailer?.dailyLimit || 0, sentToday: await sentToday() },
      senderMissing: senderComplete(settings.sender),
      tasks: [...tasks],
      publicUrl: baseUrl(req),
    };
  }

  async function settingsRoute(req, res) {
    if (req.method === "GET") return send(res, 200, await getSettings());
    if (req.method !== "PUT") throw new HttpError(405, "Methode nicht erlaubt.");
    const body = await readJson(req, 20_000);
    const cur = await getSettings();
    const str = (v, n = 300) => (typeof v === "string" ? v.trim().slice(0, n) : "");
    const s = body.sender || {};
    const next = {
      id: "main",
      sender: { name: str(s.name), company: str(s.company), email: str(s.email), phone: str(s.phone), website: str(s.website), address: str(s.address, 500) },
      followUpDays: Math.max(0, Math.min(30, Number(body.followUpDays ?? cur.followUpDays) || 0)),
      pitch: str(body.pitch, 400),
    };
    if (next.sender.email && !isEmail(next.sender.email)) throw new HttpError(400, "Die Absender-E-Mail ist ungültig.");
    await store.put("settings", next);
    return send(res, 200, next);
  }

  function leadView(lead, settings) {
    const { unsubToken, ...rest } = lead;
    return { ...rest, followUpDue: followUpDue(lead, settings), busy: tasks.has(lead.id) };
  }

  async function makeDraft(lead, kind) {
    const agent = await store.get("agents", lead.agentId);
    if (!agent) throw new HttpError(404, "Der Agent zu diesem Lead wurde gelöscht.");
    lead.draft = await generateDraft({ ai, agent, lead, settings: await getSettings(), kind });
    if (["neu"].includes(lead.stage)) lead.stage = "entwurf";
    addEvent(lead, "draft", { kind });
    await store.put("leads", lead);
  }

  async function sendLead(lead, req) {
    if (!mailer) throw new HttpError(503, "Kein E-Mail-Versand eingerichtet. Trage SMTP_HOST, SMTP_USER und SMTP_PASS in die .env ein.");
    const settings = await getSettings();
    const missing = senderComplete(settings.sender);
    if (missing.length) throw new HttpError(400, `Bitte zuerst die Absenderangaben ergänzen: ${missing.join(", ")}.`);
    if (!isEmail(lead.email)) throw new HttpError(400, `${lead.company || "Dieser Lead"} hat keine gültige E-Mail-Adresse.`);
    if (lead.stage === "abgemeldet" || lead.stage === "kein_interesse") throw new HttpError(400, `${lead.company} möchte keine Nachrichten.`);
    const blocked = await store.get("blocklist", lead.email.toLowerCase());
    if (blocked) throw new HttpError(400, `${lead.email} hat sich abgemeldet.`);
    if (!lead.draft) throw new HttpError(400, "Es gibt noch keinen Entwurf.");
    if (await sentToday() >= mailer.dailyLimit) throw new HttpError(429, `Tageslimit von ${mailer.dailyLimit} E-Mails erreicht. Morgen geht es weiter.`);
    const base = baseUrl(req);
    const unsubscribeUrl = `${base}/abmelden/${lead.unsubToken}`;
    const text = composeEmail({ draft: lead.draft, sender: settings.sender, demoUrl: `${base}/d/${lead.agentId}`, unsubscribeUrl });
    await mailer.send({ to: lead.email, subject: lead.draft.subject, text, unsubscribeUrl: `${base}/api/public/unsubscribe/${lead.unsubToken}`, replyTo: settings.sender.email });
    lead.sent.push({ subject: lead.draft.subject, kind: lead.draft.kind, at: Date.now() });
    addEvent(lead, "email_sent", { kind: lead.draft.kind });
    lead.draft = null;
    if (["neu", "entwurf"].includes(lead.stage)) lead.stage = "kontaktiert";
    await store.put("leads", lead);
  }

  // Runs one job per lead in the background, two at a time.
  function runBulk(ids, job) {
    const queue = ids.filter((id) => !tasks.has(id));
    queue.forEach((id) => tasks.add(id));
    const worker = async () => {
      while (queue.length) {
        const id = queue.shift();
        try {
          const lead = await store.get("leads", id);
          if (lead) await job(lead);
        } catch (e) {
          const lead = await store.get("leads", id);
          if (lead) { addEvent(lead, "error", { message: e instanceof HttpError ? e.message : "Fehlgeschlagen." }); await store.put("leads", lead); }
          if (e instanceof HttpError && e.status === 429) { queue.forEach((x) => tasks.delete(x)); queue.length = 0; }
        } finally {
          tasks.delete(id);
        }
      }
    };
    Promise.all([worker(), worker()]).catch(() => {});
    return queue.length;
  }

  async function leadRoute(req, res, id, sub) {
    const settings = await getSettings();
    if (!id && req.method === "GET") {
      const leads = await store.list("leads");
      return send(res, 200, leads.sort((a, b) => b.updatedAt - a.updatedAt).map((l) => leadView(l, settings)));
    }
    if (id === "bulk" && req.method === "POST") {
      const body = await readJson(req, 100_000);
      const ids = (Array.isArray(body.ids) ? body.ids : []).filter((x) => typeof x === "string").slice(0, 500);
      if (body.action === "draft") {
        if (!ai.configured) throw new HttpError(503, `${ai.keyName || "Der KI-Schlüssel"} fehlt.`);
        return send(res, 202, { started: runBulk(ids, (lead) => makeDraft(lead, followUpDue(lead, settings) ? "followup" : "first")) });
      }
      if (body.action === "send") {
        if (!mailer) throw new HttpError(503, "Kein E-Mail-Versand eingerichtet. Trage SMTP_HOST, SMTP_USER und SMTP_PASS in die .env ein.");
        return send(res, 202, { started: runBulk(ids, async (lead) => { await sendLead(lead, req); await new Promise((r) => setTimeout(r, 1500)); }) });
      }
      if (body.action === "stage" && STAGES[body.stage]) {
        for (const lid of ids) {
          const lead = await store.get("leads", lid);
          if (lead) { lead.stage = body.stage; addEvent(lead, "stage", { stage: body.stage }); await store.put("leads", lead); }
        }
        return send(res, 200, { updated: ids.length });
      }
      throw new HttpError(400, "Unbekannte Aktion.");
    }
    const lead = id && await store.get("leads", id);
    if (!lead) throw new HttpError(404, "Lead nicht gefunden.");
    if (!sub && req.method === "GET") return send(res, 200, leadView(lead, settings));
    if (!sub && req.method === "PATCH") {
      const body = await readJson(req, 50_000);
      if (typeof body.notes === "string") lead.notes = body.notes.slice(0, 5000);
      if (typeof body.email === "string") lead.email = body.email.trim().slice(0, 200);
      if (typeof body.contact === "string") lead.contact = body.contact.trim().slice(0, 200);
      if (body.stage && STAGES[body.stage] && body.stage !== lead.stage) { lead.stage = body.stage; addEvent(lead, "stage", { stage: body.stage }); }
      if (body.draft && typeof body.draft.subject === "string" && typeof body.draft.body === "string") {
        lead.draft = { ...(lead.draft || { kind: "first" }), subject: body.draft.subject.slice(0, 200), body: body.draft.body.slice(0, 8000), at: Date.now() };
        if (lead.stage === "neu") lead.stage = "entwurf";
      }
      lead.updatedAt = Date.now();
      await store.put("leads", lead);
      return send(res, 200, leadView(lead, settings));
    }
    if (sub === "/draft" && req.method === "POST") {
      if (!ai.configured) throw new HttpError(503, `${ai.keyName || "Der KI-Schlüssel"} fehlt.`);
      if (tasks.has(lead.id)) throw new HttpError(409, "Für diesen Lead läuft gerade schon etwas.");
      const body = await readJson(req);
      tasks.add(lead.id);
      try { await makeDraft(lead, body.kind === "followup" ? "followup" : "first"); } finally { tasks.delete(lead.id); }
      return send(res, 200, leadView(lead, settings));
    }
    if (sub === "/send" && req.method === "POST") {
      if (tasks.has(lead.id)) throw new HttpError(409, "Für diesen Lead läuft gerade schon etwas.");
      tasks.add(lead.id);
      try { await sendLead(lead, req); } finally { tasks.delete(lead.id); }
      return send(res, 200, leadView(lead, settings));
    }
    if (sub === "/preview-email" && req.method === "GET") {
      if (!lead.draft) throw new HttpError(400, "Es gibt noch keinen Entwurf.");
      const base = baseUrl(req);
      return send(res, 200, { subject: lead.draft.subject, text: composeEmail({ draft: lead.draft, sender: settings.sender, demoUrl: `${base}/d/${lead.agentId}`, unsubscribeUrl: `${base}/abmelden/${lead.unsubToken}` }) });
    }
    throw new HttpError(404, "Nicht gefunden.");
  }

  async function unsubscribe(res, token) {
    const lead = (await store.list("leads", (l) => l.unsubToken === token))[0];
    if (!lead) return send(res, 404, { error: "Dieser Abmeldelink ist ungültig." });
    if (lead.stage !== "abgemeldet") {
      lead.stage = "abgemeldet";
      lead.draft = null;
      addEvent(lead, "unsubscribed");
      await store.put("leads", lead);
    }
    if (isEmail(lead.email)) await store.put("blocklist", { id: lead.email.toLowerCase(), at: Date.now() });
    return send(res, 200, { ok: true });
  }

  // Data for the demo page /d/:id. Public on purpose: the link is meant to
  // be sent to the prospect. It holds nothing that is not on their website.
  async function previewRoute(req, res, id, what, url) {
    const agent = await store.get("agents", id);
    if (!agent) return send(res, 404, { error: "Diese Vorschau gibt es nicht (mehr)." });
    // Count a demo view for the lead, unless it is us opening it from the dashboard.
    if (what === "preview" && !url.searchParams.has("intern")) leadEvent(agent.id, "demo_view", {}, 30 * 60_000);
    if (what === "screenshot") {
      let img;
      try { img = await fs.readFile(path.join(screenshotDir, `${agent.id}.jpg`)); } catch { throw new HttpError(404, "Kein Screenshot vorhanden."); }
      res.writeHead(200, { "content-type": "image/jpeg", "cache-control": "public, max-age=3600", "x-content-type-options": "nosniff" });
      return res.end(img);
    }
    const a = withDefaults(agent);
    return send(res, 200, {
      ...publicView(agent),
      website: a.source?.url || (a.website ? `https://${a.website}` : ""),
      industry: a.industry,
      screenshot: Boolean(agent.preview?.screenshot),
      title: a.source?.preview?.title || a.company,
      description: a.source?.preview?.description || "",
      headings: a.source?.preview?.headings || [],
      services: a.services.split("\n").map((x) => x.trim()).filter(Boolean).slice(0, 6),
      agency: { name: agency.name || "", contact: agency.contact || "" },
    });
  }

  async function staticRoute(req, res, url) {
    if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "Methode nicht erlaubt.");
    const rel = url.pathname === "/" ? "index.html"
      : /^\/d\/[\w-]+\/?$/.test(url.pathname) ? "preview.html"
      : /^\/abmelden\/[\w-]+\/?$/.test(url.pathname) ? "unsubscribe.html"
      : url.pathname.slice(1);
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR + path.sep)) throw new HttpError(404, "Nicht gefunden.");
    let data;
    try { data = await fs.readFile(file); } catch { throw new HttpError(404, "Nicht gefunden."); }
    const headers = { "content-type": TYPES[path.extname(file)] || "application/octet-stream", "x-content-type-options": "nosniff" };
    if (rel === "widget.js") Object.assign(headers, { "access-control-allow-origin": "*", "cache-control": "public, max-age=300" });
    else Object.assign(headers, { "cache-control": "no-cache", "x-frame-options": "DENY", "referrer-policy": "same-origin" });
    res.writeHead(200, headers);
    res.end(req.method === "HEAD" ? undefined : data);
  }

  return async function handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    try {
      if (url.pathname.startsWith("/api/public/")) return await publicRoute(req, res, url);
      if (url.pathname.startsWith("/api/")) return await adminRoute(req, res, url);
      return await staticRoute(req, res, url);
    } catch (err) {
      if (res.headersSent) return res.end();
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(err);
      send(res, status, { error: status === 500 ? "Interner Fehler." : err.message });
    }
  };
}
