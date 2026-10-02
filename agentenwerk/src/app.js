import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Store, newId } from "./store.js";
import { crawlSite, CrawlError } from "./crawl.js";
import { analyzeSite } from "./analyze.js";
import { runTurn } from "./chat.js";
import { checkAdmin, clientIp, RateLimiter, originAllowed } from "./security.js";
import { withDefaults, publicView } from "../public/prompt.js";

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

export function createApp({ dataDir, ai, adminToken = "", publicUrl = "", crawl = crawlSite, analyze = analyzeSite } = {}) {
  const store = new Store(dataDir);
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
    if (!ai.configured) throw new HttpError(503, "ANTHROPIC_API_KEY fehlt. Trage ihn in die .env ein und starte den Server neu.");
    const text = String(body.message || "").trim();
    if (!text) throw new HttpError(400, "Die Nachricht ist leer.");
    if (text.length > MAX_MESSAGE) throw new HttpError(400, `Die Nachricht ist zu lang (höchstens ${MAX_MESSAGE} Zeichen).`);
    if (!chatLimit.allow(clientIp(req))) throw new HttpError(429, "Zu viele Nachrichten. Bitte kurz warten.");

    pruneConversations();
    let conv = typeof body.conversationId === "string" ? conversations.get(body.conversationId) : null;
    if (!conv || conv.agentId !== agent.id) {
      conv = { id: newId(), agentId: agent.id, messages: [], turns: 0, lastAt: Date.now(), test };
      conversations.set(conv.id, conv);
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
      return send(res, 200, { aiConfigured: ai.configured, model: ai.model, publicUrl: publicUrl || `${url.protocol}//${req.headers.host}` });
    }
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
      if (!ai.configured) throw new HttpError(503, "ANTHROPIC_API_KEY fehlt. Trage ihn in die .env ein und starte den Server neu.");
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
        await store.remove("agents", (r) => r.id === id);
        await store.remove("captured", (r) => r.agentId === id);
        await store.remove("conversations", (r) => r.agentId === id);
        for (const [cid, c] of conversations) if (c.agentId === id) conversations.delete(cid);
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

  async function publicRoute(req, res, url) {
    const m = url.pathname.match(/^\/api\/public\/agents\/([\w-]+)(\/chat)?$/);
    if (!m) throw new HttpError(404, "Nicht gefunden.");
    const agent = await store.get("agents", m[1]);
    const origin = req.headers.origin || "";
    const cors = (allowed) => (allowed ? { "access-control-allow-origin": origin || "*", vary: "Origin" } : {});
    if (!agent) return send(res, 404, { error: "Agent nicht gefunden." }, cors(true));
    const allowed = originAllowed(agent, origin);

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

  async function staticRoute(req, res, url) {
    if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "Methode nicht erlaubt.");
    const rel = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
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
