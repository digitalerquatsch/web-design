import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Store, newId } from "./store.js";
import { crawlSite, CrawlError } from "./crawl.js";
import { analyzeSite } from "./analyze.js";
import { runTurn } from "./chat.js";
import { clientIp, RateLimiter, originAllowed, safeEqual, isLoopback, bearer } from "./security.js";
import { createAuth, AuthError, ROLES, STATUSES, COOKIE, parseCookies, publicUser, allowed, ownsAgent, temporaryPassword, passwordProblem, verifyPassword, hashPassword, normEmail, validEmail, workspaceOf, inWorkspace, canSeeAgent, autopilotAllowed } from "./users.js";
import { fromEnv, loadSystem, maskedSystem, applySystemUpdate, SystemError, billingEnabled, phoneEnabled, instagramUrl } from "./system.js";
import { createStripe, verifyWebhook, BillingError, ACTIVE_BILLING } from "./billing.js";
import { validTwilioRequest, speakable, phoneGreeting, twiml } from "./voice.js";
import { sanitizeIntegrations, maskAgent, maskIntegrations, dispatch, deliver, ready as integrationReady, IntegrationError, TYPES as INTEGRATION_TYPES } from "./integrations.js";
import { newToken, hashToken, sanitizeSnapshot, STALE_MS } from "./jarvis.js";
import { createGithub, summarizeProject, GithubError } from "./github.js";
import { withDefaults, publicView } from "../public/prompt.js";
import { parseTable, mapRows, toCsv, TableError } from "./table.js";
import { createAutopilot, summarize, ROW_STEPS } from "./autopilot.js";
import { STAGES, FUNNEL, DEFAULT_SETTINGS, addEvent, summarizeLeads, followUpDue, generateDraft, composeEmail, composeHtml, senderComplete, isEmail } from "./outreach.js";

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

const AGENT_BODY = 2_500_000; // an agent can carry a knowledge base
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
function sanitizeAgent(input, id, existing = null) {
  const a = withDefaults(input);
  a.id = id;
  a.promptOverride = typeof input.promptOverride === "string" ? input.promptOverride.slice(0, 60000) : null;
  a.knowledge = a.knowledge.slice(0, 80000);
  a.allowedOrigins = a.allowedOrigins.filter((o) => typeof o === "string").map((o) => o.trim().replace(/\/+$/, "")).filter((o) => /^https?:\/\/[^/\s]+$/i.test(o)).slice(0, 20);
  a.quickReplies = a.quickReplies.filter((q) => typeof q === "string").slice(0, 5).map((q) => q.slice(0, 40));
  a.color = /^#[0-9a-f]{6}$/i.test(a.color) ? a.color : "#3a46c9";
  a.logoUrl = /^https?:\/\/[^\s"'<>]{3,500}$/i.test(a.logoUrl) ? a.logoUrl : "";
  a.widgetTitle = a.widgetTitle.slice(0, 40);
  // Projects come from the import route; from the client only the shape and sizes are accepted.
  const clip = (s, n) => String(s ?? "").slice(0, n);
  a.projects = a.projects.slice(0, 12).filter((p) => /^[\w.-]+\/[\w.-]+$/.test(p.repo)).map((p) => ({
    repo: p.repo, url: /^https:\/\/github\.com\//.test(p.url || "") ? p.url : `https://github.com/${p.repo}`,
    name: clip(p.name, 120), summary: clip(p.summary, 1200), usage: clip(p.usage, 2500), tech: clip(p.tech, 300), private: Boolean(p.private), importedAt: Number(p.importedAt) || 0,
    features: (Array.isArray(p.features) ? p.features : []).slice(0, 8).map((x) => clip(x, 240)),
    faqs: (Array.isArray(p.faqs) ? p.faqs : []).slice(0, 6).filter((f) => f && typeof f.q === "string" && typeof f.a === "string").map((f) => ({ q: clip(f.q, 200), a: clip(f.a, 700) })),
  }));
  const sid = new Set();
  a.sources = a.sources.slice(0, 100).map((x) => ({
    id: /^[\w-]{4,30}$/.test(x.id || "") && !sid.has(x.id) ? x.id : newId(),
    kind: x.kind === "website" ? "website" : "file", name: clip(x.name, 160), url: /^https?:\/\/[^\s"'<>]{3,500}$/i.test(x.url || "") ? x.url : "",
    text: clip(x.text, 60000), addedAt: Number(x.addedAt) || 0,
  })).map((x) => { sid.add(x.id); return { ...x, chars: x.text.length }; }).filter((x) => x.text.trim());
  let room = 1_200_000;
  a.sources = a.sources.filter((x) => (room -= x.chars) >= 0);
  try { a.integrations = sanitizeIntegrations(input.integrations, existing?.integrations); } catch (e) { if (e instanceof IntegrationError) throw new HttpError(400, e.message); throw e; }
  return a;
}

export function createApp({ dataDir, ai, adminToken = "", publicUrl = "", crawl = crawlSite, analyze = analyzeSite, screenshotter = null, autopilotConcurrency = 2, agency = {}, mailer = null, factories = null, env = {}, stripeFetch, githubFetch } = {}) {
  const store = new Store(dataDir);
  const screenshotDir = path.join(dataDir, "screenshots");

  // Settings from the browser ("System"), with env and constructor values as defaults.
  let sys = fromEnv(env);
  function withFallbacks(x) {
    if (!x.publicUrl && publicUrl) x.publicUrl = publicUrl.replace(/\/$/, "");
    if (!x.agencyName && agency.name) x.agencyName = agency.name;
    if (!x.agencyContact && agency.contact) x.agencyContact = agency.contact;
    return x;
  }
  withFallbacks(sys);
  async function reconfigure() {
    sys = withFallbacks(await loadSystem(store, env));
    if (factories?.ai) ai = factories.ai(sys);
    if (factories?.mailer) mailer = await factories.mailer(sys);
  }
  const ready = reconfigure().catch((e) => console.error("settings:", e));

  const monthKey = () => new Date().toISOString().slice(0, 7);
  class QuotaError extends Error {}
  const limitsFor = (ws) => (ws === "main" ? null : { analyses: sys.planMonthlyAnalyses, chats: sys.planMonthlyChats });
  async function usageOf(ws) {
    return (await store.get("usage", `${ws}:${monthKey()}`)) || { id: `${ws}:${monthKey()}`, ws, month: monthKey(), analyses: 0, chats: 0 };
  }
  // Counts monthly usage per workspace; abo workspaces stop at their plan's limit.
  async function consume(ws, kind, n = 1) {
    const u = await usageOf(ws);
    const lim = limitsFor(ws);
    if (lim && lim[kind] && u[kind] + n > lim[kind]) {
      throw new QuotaError(kind === "chats" ? "Das Monatskontingent an Chat-Nachrichten ist aufgebraucht." : "Das Monatskontingent an Website-Analysen ist aufgebraucht.");
    }
    u[kind] += n;
    await store.put("usage", u);
  }

  const autopilot = createAutopilot({ store, crawl, analyze, getAi: () => ai, screenshotter, screenshotDir, concurrency: autopilotConcurrency, consume });
  ready.then(() => autopilot.resume()).catch((e) => console.error("autopilot resume:", e));
  const baseUrl = (req) => sys.publicUrl || `http://${req.headers.host}`;
  const auth = createAuth({ store });
  const loginLimit = new RateLimiter(10, 15 * 60_000);
  const signupLimit = new RateLimiter(5, 60 * 60_000);
  const testLimit = new RateLimiter(20, 60 * 60_000);
  const jarvisLimit = new RateLimiter(120, 60_000);
  const TOKEN_ADMIN = { id: "token", name: "Admin-Token", email: "", role: "admin", status: "active", agentIds: [] };
  const LOCAL_ADMIN = { id: "local", name: "Lokal (noch kein Konto)", email: "", role: "admin", status: "active", agentIds: [] };
  const conversations = new Map(); // id -> { agentId, messages, turns, lastAt, test }
  const chatLimit = new RateLimiter(20, 60_000);
  const analyzeLimit = new RateLimiter(6, 60_000);

  function pruneConversations(now = Date.now()) {
    for (const [id, c] of conversations) if (now - c.lastAt > CONV_TTL) conversations.delete(id);
  }

  async function logMessage(conv, role, text) {
    const row = (await store.get("conversations", conv.id)) || { id: conv.id, agentId: conv.agentId, test: conv.test, channel: conv.channel || "web", from: conv.from, startedAt: Date.now(), messages: [] };
    row.messages.push({ role, text, at: Date.now() });
    row.lastAt = Date.now();
    await store.put("conversations", row);
  }

  // Shared by the public widget and the builder's test chat.
  async function chat(req, res, agent, body, { test = false, corsHeaders = {}, ws = agent.ownerId || "main" } = {}) {
    if (!ai.configured) throw new HttpError(503, `${ai.keyName || "Der KI-Schlüssel"} fehlt. Trage ihn unter System ein.`);
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
    try { await consume(ws, "chats"); } catch (e) { if (e instanceof QuotaError) throw new HttpError(429, e.message); throw e; }
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
          if (!test) {
            leadEvent(agent.id, "demo_lead", { kind: type });
            dispatch(agent, { type, data, channel: "web", at: Date.now() }, { mailer }).catch(() => {});
          }
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

  /* ---------- start page ---------- */

  // Numbers for the start page, scoped to what this user may see.
  async function overview(me) {
    const ws = workspaceOf(me);
    const agents = await store.list("agents", (a) => canSeeAgent(me, a));
    const ids = new Set(agents.map((a) => a.id));
    const convs = await store.list("conversations", (c) => ids.has(c.agentId));
    const captured = await store.list("captured", (c) => ids.has(c.agentId) && !c.test);
    const out = {
      agents: agents.length,
      imported: agents.filter((a) => a.source).length,
      conversations: convs.filter((c) => !c.test).length,
      testConversations: convs.filter((c) => c.test).length,
      captured: captured.length,
      recentAgents: agents.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 6).map((a) => ({
        id: a.id, name: a.name, company: a.company, goal: a.goal, color: a.color, updatedAt: a.updatedAt, fromWebsite: Boolean(a.source), demo: Boolean(a.batchId),
      })),
    };
    if (me.role !== "kunde") {
      const leads = await store.list("leads", (l) => inWorkspace(l, ws));
      out.batches = (await store.list("batches", (b) => inWorkspace(b, ws))).length;
      out.leads = {
        total: leads.length,
        contacted: leads.filter((l) => l.sent.length).length,
        drafts: leads.filter((l) => l.stage === "entwurf").length,
        viewed: leads.filter((l) => l.events.some((e) => e.type === "demo_view")).length,
        demoChats: leads.filter((l) => l.events.some((e) => e.type === "demo_chat")).length,
        interested: leads.filter((l) => l.stage === "interessiert").length,
        customers: leads.filter((l) => l.stage === "kunde").length,
      };
    }
    if (me.role === "admin") out.pendingUsers = (await auth.users()).filter((u) => u.status === "pending").length;
    return out;
  }

  /* ---------- subscription ---------- */

  const stripe = () => createStripe({ secretKey: sys.stripeSecretKey, fetchImpl: stripeFetch });

  async function planInfo() {
    const users = await auth.users();
    const taken = users.filter((u) => u.role === "abo" && u.billing && ACTIVE_BILLING.has(u.billing.status)).length;
    return {
      enabled: billingEnabled(sys), name: sys.planName, price: sys.planPrice, seats: sys.planSeats,
      seatsLeft: Math.max(0, sys.planSeats - taken), termsUrl: sys.termsUrl, privacyUrl: sys.privacyUrl, imprintUrl: sys.imprintUrl,
      limits: { analyses: sys.planMonthlyAnalyses, chats: sys.planMonthlyChats, emailsPerDay: sys.planDailyEmails },
    };
  }

  async function billingRoute(req, res, me, action) {
    if (!billingEnabled(sys)) throw new HttpError(503, "Die Bezahlung ist noch nicht eingerichtet.");
    if (me.role !== "abo") throw new HttpError(400, "Nur Abo-Zugänge haben ein Abo.");
    const back = `${baseUrl(req)}/?view=account`;
    try {
      if (action === "checkout") {
        if (me.billing && ACTIVE_BILLING.has(me.billing.status)) throw new HttpError(400, "Dein Abo ist bereits aktiv.");
        const plan = await planInfo();
        if (plan.seatsLeft <= 0) throw new HttpError(409, "Alle Plätze sind gerade vergeben.");
        const session = await stripe().checkout({ user: me, plan, successUrl: `${baseUrl(req)}/?checkout=success`, cancelUrl: `${baseUrl(req)}/?checkout=cancel` });
        return send(res, 200, { url: session.url });
      }
      if (!me.billing?.customer) throw new HttpError(400, "Für diesen Zugang gibt es noch kein Abo bei Stripe.");
      if (action === "portal") return send(res, 200, { url: (await stripe().portal({ customer: me.billing.customer, returnUrl: back })).url });
      if (!me.billing.subscription) throw new HttpError(400, "Kein laufendes Abo gefunden.");
      const sub = action === "cancel" ? await stripe().cancelAtPeriodEnd(me.billing.subscription) : await stripe().resume(me.billing.subscription);
      me.billing = { ...me.billing, cancelAtPeriodEnd: Boolean(sub.cancel_at_period_end), periodEnd: periodEndOf(sub) || me.billing.periodEnd, status: sub.status || me.billing.status };
      await store.put("users", me);
      return send(res, 200, { billing: me.billing });
    } catch (e) {
      if (e instanceof BillingError) throw new HttpError(502, e.message);
      throw e;
    }
  }

  const periodEndOf = (sub) => (sub?.current_period_end || sub?.items?.data?.[0]?.current_period_end || 0) * 1000 || null;

  async function stripeWebhook(req, res) {
    const raw = (await readRaw(req, 1_000_000)).toString("utf8");
    if (!sys.stripeWebhookSecret) return send(res, 503, { error: "Webhook nicht eingerichtet." });
    let event;
    try { event = verifyWebhook(raw, req.headers["stripe-signature"], sys.stripeWebhookSecret); } catch (e) { return send(res, 400, { error: e.message }); }
    const obj = event.data?.object || {};
    if (event.type === "checkout.session.completed" && obj.client_reference_id) {
      const u = await store.get("users", obj.client_reference_id);
      if (u) {
        u.billing = { ...(u.billing || {}), status: "active", customer: obj.customer, subscription: obj.subscription, since: u.billing?.since || Date.now() };
        if (u.role !== "admin") u.role = "abo";
        u.status = "active";
        await store.put("users", u);
      }
    } else if (/^customer\.subscription\.(created|updated|deleted)$/.test(event.type)) {
      const all = await auth.users();
      const u = all.find((x) => x.billing?.subscription === obj.id) || (obj.metadata?.userId ? all.find((x) => x.id === obj.metadata.userId) : null);
      if (u) {
        u.billing = { ...(u.billing || {}), subscription: obj.id, customer: obj.customer || u.billing?.customer, status: event.type.endsWith("deleted") ? "canceled" : obj.status, cancelAtPeriodEnd: Boolean(obj.cancel_at_period_end), periodEnd: periodEndOf(obj) || u.billing?.periodEnd || null };
        await store.put("users", u);
      }
    }
    return send(res, 200, { received: true });
  }

  /* ---------- phone ---------- */

  function sendXml(res, body) {
    res.writeHead(200, { "content-type": "text/xml; charset=utf-8", "cache-control": "no-store" });
    res.end(body);
  }

  async function voiceRoute(req, res, url, id, isTurn) {
    const raw = (await readRaw(req, 200_000)).toString("utf8");
    const params = Object.fromEntries(new URLSearchParams(raw));
    const voice = sys.twilioVoice || "Polly.Vicki-Neural";
    if (!phoneEnabled(sys)) return sendXml(res, twiml({ say: "Dieser Anschluss ist noch nicht eingerichtet.", voice, hangup: true }));
    // Twilio signs the exact URL it was configured with: the public base plus path and query.
    const fullUrl = `${sys.publicUrl || `https://${req.headers.host}`}${req.url}`;
    if (!validTwilioRequest(sys.twilioAuthToken, fullUrl, params, req.headers["x-twilio-signature"])) return send(res, 403, { error: "Ungültige Signatur." });
    const agent = await store.get("agents", id);
    if (!agent || !agent.phoneEnabled) return sendXml(res, twiml({ say: "Dieser Anschluss ist gerade nicht erreichbar. Auf Wiederhören.", voice, hangup: true }));
    const action = `${sys.publicUrl || `https://${req.headers.host}`}/api/public/voice/${id}/turn`;
    const key = `call:${params.CallSid || "x"}`;
    pruneConversations();
    let conv = conversations.get(key);
    if (!conv) {
      conv = { id: newId(), agentId: agent.id, messages: [], turns: 0, lastAt: Date.now(), test: false, channel: "telefon", from: params.From || "", silent: 0 };
      conversations.set(key, conv);
    }
    conv.lastAt = Date.now();
    if (!isTurn) {
      const greet = phoneGreeting(agent);
      await logMessage(conv, "assistant", greet);
      return sendXml(res, twiml({ say: greet, gatherAction: action, voice }));
    }
    const speech = String(params.SpeechResult || "").trim().slice(0, MAX_MESSAGE);
    if (!speech) {
      conv.silent++;
      if (conv.silent >= 2) return sendXml(res, twiml({ say: "Ich lege jetzt auf. Rufen Sie gern jederzeit wieder an. Auf Wiederhören.", voice, hangup: true }));
      return sendXml(res, twiml({ say: "Entschuldigung, das habe ich nicht verstanden. Was kann ich für Sie tun?", gatherAction: action, voice }));
    }
    conv.silent = 0;
    if (conv.turns >= MAX_TURNS / 2 || !ai.configured) return sendXml(res, twiml({ say: "Vielen Dank für Ihren Anruf. Für alles Weitere meldet sich unser Team bei Ihnen. Auf Wiederhören.", voice, hangup: true }));
    try { await consume(agent.ownerId || "main", "chats"); } catch (e) {
      if (e instanceof QuotaError) return sendXml(res, twiml({ say: "Der Assistent ist gerade nicht verfügbar. Bitte versuchen Sie es später noch einmal.", voice, hangup: true }));
      throw e;
    }
    conv.turns++;
    await logMessage(conv, "user", speech);
    let say;
    try {
      const { reply, refused } = await runTurn({
        agent, messages: conv.messages, text: speech, ai, channel: "phone",
        onCapture: async (type, data) => {
          await store.put("captured", { id: newId(), agentId: agent.id, conversationId: conv.id, type, data: { ...data, phone: data.phone || conv.from }, channel: "telefon", test: false, at: Date.now() });
          dispatch(agent, { type, data: { ...data, phone: data.phone || conv.from }, channel: "telefon", at: Date.now() }, { mailer }).catch(() => {});
        },
      });
      say = refused ? "Dabei kann ich leider nicht helfen. Kann ich etwas anderes für Sie tun?" : (speakable(reply) || "Einen Moment bitte, können Sie das noch einmal sagen?");
    } catch (e) {
      console.error("voice error:", e?.message || e);
      say = "Entschuldigung, da ist etwas schiefgegangen. Können Sie Ihre Frage noch einmal stellen?";
    }
    await logMessage(conv, "assistant", say);
    const bye = /\b(tschüss|tschüs|auf wiederhören|wiederhören|ciao|das wars|das war's|danke das war alles)\b/i.test(speech);
    return sendXml(res, twiml({ say, gatherAction: action, voice, hangup: bye }));
  }

  /* ---------- accounts ---------- */

  const sessionToken = (req) => parseCookies(req.headers.cookie)[COOKIE] || "";
  const secureCookie = (req) => publicUrl.startsWith("https://") || req.headers["x-forwarded-proto"] === "https";
  const tokenOk = (req) => Boolean(adminToken) && safeEqual(bearer(req), adminToken);

  async function authConfig() {
    return { signupOpen: true, ...((await store.get("config", "auth")) || {}) };
  }

  // Who is calling? A session user, the ADMIN_TOKEN, or, before the first
  // account exists, a request addressed to localhost.
  async function currentUser(req) {
    if (tokenOk(req)) return TOKEN_ADMIN;
    const u = await auth.userForToken(sessionToken(req));
    if (u) return u;
    if (!adminToken && isLoopback(req) && (await auth.count()) === 0) return LOCAL_ADMIN;
    return null;
  }

  async function startSession(res, req, user) {
    const token = await auth.startSession(user);
    res.setHeader("set-cookie", auth.cookie(token, { secure: secureCookie(req) }));
  }

  async function authRoute(req, res, p) {
    if (p === "/api/auth/state" && req.method === "GET") {
      const count = await auth.count();
      const user = await auth.userForToken(sessionToken(req));
      return send(res, 200, {
        setupNeeded: count === 0,
        setupNeedsToken: count === 0 && !isLoopback(req),
        signupOpen: (await authConfig()).signupOpen && count > 0,
        tokenLogin: Boolean(adminToken),
        user: publicUser(user),
        plan: await planInfo(),
      });
    }
    if (p === "/api/auth/setup" && req.method === "POST") {
      if ((await auth.count()) > 0) throw new HttpError(409, "Es gibt schon einen Admin. Bitte anmelden.");
      if (!isLoopback(req) && !tokenOk(req)) throw new HttpError(403, "Den ersten Admin legst du über localhost an oder mit dem ADMIN_TOKEN aus der .env.");
      const body = await readJson(req, 10_000);
      const user = await auth.create({ ...body, role: "admin", status: "active" });
      await startSession(res, req, user);
      return send(res, 201, { user: publicUser(user) });
    }
    if (p === "/api/auth/login" && req.method === "POST") {
      const body = await readJson(req, 10_000);
      const ip = clientIp(req);
      if (!loginLimit.allow(ip) || !loginLimit.allow("mail:" + normEmail(body.email))) throw new HttpError(429, "Zu viele Anmeldeversuche. Bitte 15 Minuten warten.");
      const user = await auth.login(body.email, body.password);
      await startSession(res, req, user);
      return send(res, 200, { user: publicUser(user) });
    }
    if (p === "/api/auth/logout" && req.method === "POST") {
      await auth.endSession(sessionToken(req));
      res.setHeader("set-cookie", auth.cookie("", { secure: secureCookie(req) }));
      return send(res, 200, { ok: true });
    }
    if (p === "/api/auth/register" && req.method === "POST") {
      if ((await auth.count()) === 0) throw new HttpError(400, "Bitte zuerst den ersten Admin anlegen.");
      if (!(await authConfig()).signupOpen) throw new HttpError(403, "Neue Zugänge werden gerade nicht angenommen.");
      if (!signupLimit.allow(clientIp(req))) throw new HttpError(429, "Zu viele Anfragen. Bitte später noch einmal.");
      const body = await readJson(req, 10_000);
      // With Stripe set up, self-signup is the paid subscription; otherwise a request an admin approves.
      if (billingEnabled(sys)) {
        if (body.acceptTerms !== true) throw new HttpError(400, "Bitte bestätige die AGB und die Datenschutzerklärung.");
        const plan = await planInfo();
        if (plan.seatsLeft <= 0) throw new HttpError(409, "Alle Plätze sind gerade vergeben. Trag dich auf die Warteliste ein.");
        const user = await auth.create({ name: body.name, email: body.email, password: body.password, company: body.company, role: "abo", status: "active", extra: { billing: { status: "checkout", acceptedTermsAt: Date.now() } } });
        await startSession(res, req, user);
        const session = await stripe().checkout({ user, plan, successUrl: `${baseUrl(req)}/?checkout=success`, cancelUrl: `${baseUrl(req)}/?checkout=cancel` });
        return send(res, 201, { ok: true, checkoutUrl: session.url });
      }
      await auth.create({ name: body.name, email: body.email, password: body.password, company: body.company, note: body.note, role: "abo", status: "pending" });
      return send(res, 201, { ok: true, message: "Danke! Ein Admin prüft deine Anfrage und schaltet dich frei." });
    }
    return null;
  }

  async function usersRoute(req, res, me, id, sub) {
    const view = (u) => publicUser(u);
    if (!id && req.method === "GET") {
      const all = await auth.users();
      return send(res, 200, { users: all.sort((a, b) => b.createdAt - a.createdAt).map(view), config: await authConfig(), roles: ROLES, statuses: STATUSES, plan: await planInfo(), waitlist: (await store.list("waitlist")).sort((a, b) => b.at - a.at) });
    }
    if (!id && req.method === "POST") {
      const body = await readJson(req, 10_000);
      const password = temporaryPassword();
      const user = await auth.create({ name: body.name, email: body.email, company: body.company, role: body.role, status: "active", password });
      return send(res, 201, { user: view(user), password });
    }
    const user = id && await store.get("users", id);
    if (!user) throw new HttpError(404, "Nutzer nicht gefunden.");
    const wouldLeaveNoAdmin = async (next) => user.role === "admin" && user.status === "active" && (next.role !== "admin" || next.status !== "active") && (await auth.activeAdmins(user.id)) === 0;

    if (!sub && req.method === "PATCH") {
      const body = await readJson(req, 20_000);
      const next = { role: ROLES[body.role] ? body.role : user.role, status: STATUSES[body.status] ? body.status : user.status };
      if (await wouldLeaveNoAdmin(next)) throw new HttpError(400, "Es muss mindestens ein aktiver Admin bleiben.");
      const approved = user.status !== "active" && next.status === "active";
      Object.assign(user, next);
      if (typeof body.name === "string" && body.name.trim()) user.name = body.name.trim().slice(0, 120);
      if (typeof body.company === "string") user.company = body.company.trim().slice(0, 120);
      if (typeof body.autopilotUnlocked === "boolean") user.autopilotUnlocked = body.autopilotUnlocked;
      if (Array.isArray(body.agentIds)) {
        const agentIds = new Set((await store.list("agents")).map((a) => a.id));
        user.agentIds = body.agentIds.filter((x) => typeof x === "string" && agentIds.has(x)).slice(0, 200);
      }
      if (approved) { user.approvedAt = Date.now(); user.approvedBy = me.name; }
      if (user.status !== "active") await auth.endAllSessions(user.id);
      await store.put("users", user);
      if (approved && mailer) {
        mailer.send({ to: user.email, subject: "Dein Zugang zu Agentenwerk ist freigeschaltet", text: `Hallo ${user.name},

dein Zugang wurde freigeschaltet. Du kannst dich jetzt anmelden:
${baseUrl(req)}/

Viele Grüße`, unsubscribeUrl: `${baseUrl(req)}/` }).catch((e) => console.warn("approval mail:", e?.message || e));
      }
      return send(res, 200, { user: view(user), mailed: approved && Boolean(mailer) });
    }
    if (sub === "/reset-password" && req.method === "POST") {
      const password = temporaryPassword();
      user.passwordHash = hashPassword(password);
      await store.put("users", user);
      await auth.endAllSessions(user.id);
      return send(res, 200, { password });
    }
    if (!sub && req.method === "DELETE") {
      if (user.id === me.id) throw new HttpError(400, "Du kannst dich nicht selbst löschen.");
      if (await wouldLeaveNoAdmin({ role: "none", status: "none" })) throw new HttpError(400, "Es muss mindestens ein aktiver Admin bleiben.");
      await auth.endAllSessions(user.id);
      await store.remove("users", (u) => u.id === user.id);
      return send(res, 204, "");
    }
    throw new HttpError(404, "Nicht gefunden.");
  }

  async function adminRoute(req, res, url) {
    if (!req.headers["x-agentenwerk"]) throw new HttpError(403, "Fehlender Header X-Agentenwerk.");
    const p = url.pathname;
    if (p.startsWith("/api/auth/") && p !== "/api/auth/password" && p !== "/api/auth/config") {
      try {
        const handled = await authRoute(req, res, p);
        if (handled !== null) return handled;
      } catch (e) {
        if (e instanceof AuthError) throw new HttpError(e.status, e.message);
        throw e;
      }
    }
    const me = await currentUser(req);
    if (!me) {
      if (adminToken || (await auth.count()) > 0) throw new HttpError(401, "Bitte anmelden.");
      throw new HttpError(403, "Ohne ADMIN_TOKEN ist der Builder vor dem ersten Konto nur über localhost erreichbar.");
    }
    if (!allowed(me, req.method, p)) throw new HttpError(403, "Dafür hat dein Zugang keine Berechtigung.");
    const ws = workspaceOf(me);
    // A subscription that is not paid (yet) only reaches status, account and billing.
    if (me.role === "abo" && me.billing && !ACTIVE_BILLING.has(me.billing.status) && !/^\/api\/(status|account|billing|auth\/password)/.test(p)) {
      throw new HttpError(402, me.billing.status === "checkout" ? "Bitte schließe zuerst die Bezahlung ab." : "Dein Abo ist nicht aktiv.");
    }
    if (!autopilotAllowed(me) && /^\/api\/(batches|leads|acquisition)/.test(p)) {
      throw new HttpError(403, "Autopilot und Akquise werden im 1:1-Mentoring freigeschaltet. Schreib mir auf Instagram.");
    }
    const m = p.match(/^\/api\/agents\/([\w-]+)(\/[a-z-]+(?:\/[\w-]+\/test)?)?$/);

    if (p === "/api/status" && req.method === "GET") {
      const pending = me.role === "admin" ? (await auth.users()).filter((u) => u.status === "pending").length : 0;
      const usage = await usageOf(ws);
      return send(res, 200, {
        aiConfigured: ai.configured, provider: ai.provider || "", keyName: ai.keyName || "KI-Schlüssel", model: ai.model, publicUrl: baseUrl(req),
        screenshots: Boolean(screenshotter), steps: ROW_STEPS, me: { ...publicUser(me), autopilotAllowed: autopilotAllowed(me) }, pendingUsers: pending, accounts: (await auth.count()) > 0,
        mentoring: { instagram: sys.instagram, url: instagramUrl(sys) },
        usage: { analyses: usage.analyses, chats: usage.chats, limits: limitsFor(ws) },
        phone: { enabled: phoneEnabled(sys) }, mail: Boolean(mailer),
        billing: me.billing ? { status: me.billing.status, cancelAtPeriodEnd: Boolean(me.billing.cancelAtPeriodEnd), periodEnd: me.billing.periodEnd || null } : null,
        plan: { name: sys.planName, price: sys.planPrice },
      });
    }
    if (p === "/api/jarvis" && req.method === "GET") return send(res, 200, await jarvisView(req));
    if (p === "/api/jarvis/token" && req.method === "POST") {
      const token = newToken();
      await store.put("config", { id: "jarvis", tokenHash: hashToken(token), createdAt: Date.now() });
      return send(res, 201, { token, ingestUrl: `${baseUrl(req)}/api/public/jarvis/ingest` });
    }
    if (p === "/api/jarvis/token" && req.method === "DELETE") {
      await store.remove("config", (c) => c.id === "jarvis");
      await store.remove("jarvis", () => true);
      return send(res, 200, { ok: true });
    }
    if (p === "/api/system" && req.method === "GET") return send(res, 200, { system: maskedSystem(sys), webhookUrl: `${baseUrl(req)}/api/public/stripe/webhook`, voiceBase: `${baseUrl(req)}/api/public/voice/`, mail: Boolean(mailer), ai: ai.configured });
    if (p === "/api/system" && req.method === "PUT") {
      const body = await readJson(req, 50_000);
      let next;
      try { next = applySystemUpdate((await store.get("config", "system")) || {}, body); } catch (e) { if (e instanceof SystemError) throw new HttpError(400, e.message); throw e; }
      await store.put("config", next);
      await reconfigure();
      return send(res, 200, { system: maskedSystem(sys), mail: Boolean(mailer), ai: ai.configured });
    }
    if (p === "/api/system/test-mail" && req.method === "POST") {
      if (!mailer) throw new HttpError(503, "Der E-Mail-Versand ist noch nicht eingerichtet.");
      const to = me.email || sys.smtpFrom || sys.smtpUser;
      if (!isEmail(to)) throw new HttpError(400, "Keine Empfängeradresse bekannt.");
      try { await mailer.send({ to, subject: "Test von Agentenwerk", text: "Der E-Mail-Versand funktioniert.", unsubscribeUrl: `${baseUrl(req)}/` }); } catch (e) { throw new HttpError(502, `Versand fehlgeschlagen: ${e?.message || e}`); }
      return send(res, 200, { ok: true, to });
    }
    if (p === "/api/account" && req.method === "GET") {
      const usage = await usageOf(ws);
      return send(res, 200, { me: publicUser(me), billing: me.billing || null, usage: { analyses: usage.analyses, chats: usage.chats, limits: limitsFor(ws) }, plan: await planInfo(), mentoring: { instagram: sys.instagram, url: instagramUrl(sys) }, autopilotAllowed: autopilotAllowed(me) });
    }
    const bl = p.match(/^\/api\/billing\/(checkout|portal|cancel|resume)$/);
    if (bl && req.method === "POST") return billingRoute(req, res, me, bl[1]);
    if (p === "/api/overview" && req.method === "GET") return send(res, 200, await overview(me));
    if (p === "/api/auth/password" && req.method === "POST") {
      if (["token", "local"].includes(me.id)) throw new HttpError(400, "Dieser Zugang hat kein Passwort.");
      const body = await readJson(req, 10_000);
      if (!verifyPassword(body.current, me.passwordHash)) throw new HttpError(400, "Das aktuelle Passwort stimmt nicht.");
      const problem = passwordProblem(body.next);
      if (problem) throw new HttpError(400, problem);
      me.passwordHash = hashPassword(body.next);
      await store.put("users", me);
      await auth.endAllSessions(me.id);
      await startSession(res, req, me);
      return send(res, 200, { ok: true });
    }
    if (p === "/api/auth/config" && req.method === "PUT") {
      const body = await readJson(req, 2_000);
      const cfgAuth = { id: "auth", signupOpen: Boolean(body.signupOpen) };
      await store.put("config", cfgAuth);
      return send(res, 200, cfgAuth);
    }
    const um = p.match(/^\/api\/users(?:\/([\w-]+)(\/[a-z-]+)?)?$/);
    if (um) {
      try { return await usersRoute(req, res, me, um[1], um[2]); } catch (e) {
        if (e instanceof AuthError) throw new HttpError(e.status, e.message);
        throw e;
      }
    }
    const b = p.match(/^\/api\/batches(?:\/([\w-]+)(\/[a-z]+)?)?$/);
    if (b) return batchRoute(req, res, url, b[1], b[2], ws);
    if (p === "/api/settings") return settingsRoute(req, res, ws);
    if (p === "/api/acquisition") return send(res, 200, await acquisitionSummary(req, ws));
    const l = p.match(/^\/api\/leads(?:\/([\w-]+)(\/[a-z-]+)?)?$/);
    if (l) return leadRoute(req, res, l[1], l[2], me);
    if (p === "/api/agents" && req.method === "GET") {
      const agents = await store.list("agents", (a) => canSeeAgent(me, a));
      return send(res, 200, agents.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).map(maskAgent));
    }
    if (p === "/api/agents" && req.method === "POST") {
      const body = await readJson(req, AGENT_BODY);
      const agent = { ...sanitizeAgent(body, newId()), ownerId: ws, batchId: undefined, preview: undefined, createdAt: Date.now(), updatedAt: Date.now() };
      await store.put("agents", agent);
      return send(res, 201, maskAgent(agent));
    }
    if (p === "/api/agents/bulk-delete" && req.method === "POST") {
      const body = await readJson(req, 20_000);
      const wanted = (Array.isArray(body.ids) ? body.ids : []).filter((x) => typeof x === "string").slice(0, 500);
      const mine = (await store.list("agents", (a) => wanted.includes(a.id) && canSeeAgent(me, a))).map((a) => a.id);
      await deleteAgents(mine);
      return send(res, 200, { deleted: mine.length });
    }
    if (p === "/api/analyze" && req.method === "POST") {
      if (!ai.configured) throw new HttpError(503, `${ai.keyName || "Der KI-Schlüssel"} fehlt. Trage ihn in die .env ein und starte den Server neu.`);
      if (!analyzeLimit.allow(clientIp(req))) throw new HttpError(429, "Zu viele Analysen. Bitte eine Minute warten.");
      try { await consume(ws, "analyses"); } catch (e) { if (e instanceof QuotaError) throw new HttpError(429, e.message); throw e; }
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
    if (p === "/api/sources/website" && req.method === "POST") {
      if (me.role === "kunde") throw new HttpError(403, "Kein Zugriff.");
      if (!analyzeLimit.allow(clientIp(req))) throw new HttpError(429, "Zu viele Importe. Bitte eine Minute warten.");
      try { await consume(ws, "analyses"); } catch (e) { if (e instanceof QuotaError) throw new HttpError(429, e.message); throw e; }
      const body = await readJson(req, 5_000);
      const deep = body.thorough === true;
      const out = sse(res);
      try {
        const site = await crawl(body.url, { deep, maxPages: deep ? 80 : 8, perPageChars: deep ? 20000 : 12000, totalChars: deep ? 400000 : 70000, onProgress: (e) => out.event(e.type === "page" ? "page" : "status", e) });
        const pages = site.pages.filter((pg) => pg.text.length > 80);
        if (!pages.length) throw new CrawlError("Auf der Website war kaum Text zu finden. Wird sie erst per JavaScript aufgebaut? Dann füge die Inhalte als Datei hinzu.");
        const at = Date.now();
        const sources = deep
          ? pages.map((pg) => ({ id: newId(), kind: "website", name: pg.title || pg.url, url: pg.url, text: pg.text.slice(0, 60000), addedAt: at }))
          : [{ id: newId(), kind: "website", name: new URL(site.url).hostname, url: site.url, text: pages.map((pg) => `## ${pg.title || pg.url}\n${pg.text}`).join("\n\n").slice(0, 60000), addedAt: at }];
        out.event("result", { sources: sources.map((x) => ({ ...x, chars: x.text.length })), failed: site.failed.length });
      } catch (err) {
        if (!(err instanceof CrawlError)) console.error("source import error:", err?.message || err);
        out.event("error", { message: err instanceof CrawlError ? err.message : "Der Import ist fehlgeschlagen. Bitte noch einmal versuchen." });
      }
      return out.end();
    }
    if (p === "/api/projects/import" && req.method === "POST") {
      if (!ai.configured) throw new HttpError(503, `${ai.keyName || "Der KI-Schlüssel"} fehlt. Trage ihn unter System ein.`);
      if (!analyzeLimit.allow(clientIp(req))) throw new HttpError(429, "Zu viele Importe. Bitte eine Minute warten.");
      const body = await readJson(req, 5_000);
      try { await consume(ws, "analyses"); } catch (e) { if (e instanceof QuotaError) throw new HttpError(429, e.message); throw e; }
      try {
        const repo = await createGithub({ token: sys.githubToken, fetchImpl: githubFetch }).fetchRepo(body.repo);
        if (!repo.readme && !repo.description) throw new GithubError("In diesem Repository steht weder ein README noch eine Beschreibung. Daraus kann der Agent nichts lernen.", 422);
        return send(res, 200, { project: await summarizeProject(repo, { ai }) });
      } catch (e) {
        if (e instanceof GithubError) throw new HttpError(e.status === 502 ? 502 : e.status, e.message);
        if (e?.code === "refusal" || e?.code === "invalid_output" || e?.code === "max_tokens") throw new HttpError(502, "Die Zusammenfassung ist fehlgeschlagen. Bitte noch einmal versuchen.");
        throw e;
      }
    }
    if (p === "/api/test-chat" && req.method === "POST") {
      const body = await readJson(req, AGENT_BODY);
      const stored = await store.get("agents", String(body.agent?.id || "test"));
      const agent = sanitizeAgent(body.agent || {}, String(body.agent?.id || "test"), stored);
      if (stored ? !canSeeAgent(me, stored) : me.role === "kunde") throw new HttpError(403, "Dieser Agent gehört nicht zu deinem Zugang.");
      return chat(req, res, agent, body, { test: true, ws: stored?.ownerId || ws });
    }
    if (m) {
      const [, id, sub] = m;
      const found = await store.get("agents", id);
      const agent = canSeeAgent(me, found) ? found : null;
      if (!agent) throw new HttpError(404, "Agent nicht gefunden.");
      if (!sub && req.method === "GET") return send(res, 200, maskAgent(agent));
      if (!sub && req.method === "PUT") {
        const body = await readJson(req, AGENT_BODY);
        // Ownership and autopilot links stay as stored, whatever the client sends.
        const next = { ...sanitizeAgent(body, id, agent), ownerId: agent.ownerId, batchId: agent.batchId, preview: agent.preview, prospect: agent.prospect, createdAt: agent.createdAt, updatedAt: Date.now() };
        await store.put("agents", next);
        return send(res, 200, maskAgent(next));
      }
      if (sub === "/duplicate" && req.method === "POST") {
        const copy = { ...agent, id: newId(), name: `${agent.name || "Agent"} (Kopie)`.slice(0, 80), batchId: undefined, preview: undefined, prospect: undefined, createdAt: Date.now(), updatedAt: Date.now() };
        await store.put("agents", copy);
        return send(res, 201, maskAgent(copy));
      }
      const it = sub && sub.match(/^\/integrations\/([\w-]+)\/test$/);
      if (it && req.method === "POST") {
        if (me.role === "kunde") throw new HttpError(403, "Kein Zugriff.");
        const i = (agent.integrations || []).find((x) => x.id === it[1]);
        if (!i) throw new HttpError(404, "Verbindung nicht gefunden.");
        if (!integrationReady(i)) throw new HttpError(400, "Die Verbindung ist noch nicht vollständig eingerichtet.");
        if (!testLimit.allow(clientIp(req))) throw new HttpError(429, "Zu viele Tests. Bitte später noch einmal.");
        try { await deliver(i, { type: "lead", agentId: agent.id, agentName: agent.name, data: { name: "Test von Agentenwerk", message: "Wenn du das liest, funktioniert die Verbindung." } }, { mailer }); }
        catch (e) { throw new HttpError(502, `Senden fehlgeschlagen: ${e?.message || e}`); }
        return send(res, 200, { ok: true });
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

  async function batchRoute(req, res, url, id, sub, ws) {
    if (!id && req.method === "GET") {
      const all = await store.list("batches", (x) => inWorkspace(x, ws));
      return send(res, 200, all.map(summarize).sort((a, b) => b.createdAt - a.createdAt));
    }
    if (!id && req.method === "POST") {
      if (!ai.configured) throw new HttpError(503, `${ai.keyName || "Der KI-Schlüssel"} fehlt. Trage ihn unter System ein.`);
      const buf = await readRaw(req, 5_000_000);
      let mapped;
      try { mapped = mapRows(parseTable(buf, url.searchParams.get("filename") || "")); } catch (e) {
        if (e instanceof TableError) throw new HttpError(400, e.message);
        throw new HttpError(400, "Die Tabelle konnte nicht gelesen werden. Bitte als .xlsx oder .csv speichern.");
      }
      const batch = await autopilot.createBatch({ name: (url.searchParams.get("name") || "").slice(0, 120), rows: mapped.rows, skipped: mapped.skipped, ownerId: ws });
      return send(res, 201, { ...summarize(batch), columns: mapped.columns, skipped: mapped.skipped });
    }
    const found = id && await store.get("batches", id);
    const batch = found && inWorkspace(found, ws) ? found : null;
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

  async function jarvisView(req) {
    const cfg = await store.get("config", "jarvis");
    const snap = await store.get("jarvis", "snapshot");
    const leads = await store.list("leads");
    const feed = [];
    for (const l of leads) for (const e of l.events || []) if (["demo_view", "demo_chat", "demo_lead", "email_sent", "unsubscribed"].includes(e.type)) feed.push({ kind: "lead", type: e.type, at: e.at, title: l.company || "Lead" });
    for (const r of snap?.runs || []) if (r.createdAt) feed.push({ kind: "run", type: r.status, at: r.createdAt * (r.createdAt < 1e11 ? 1000 : 1), title: r.project || "Run", detail: r.prompt });
    feed.sort((a, b) => b.at - a.at);
    const stale = snap ? Date.now() - snap.receivedAt > STALE_MS : false;
    return { connected: Boolean(cfg), tokenCreatedAt: cfg?.createdAt || null, ingestUrl: `${baseUrl(req)}/api/public/jarvis/ingest`, receivedAt: snap?.receivedAt || null, stale, snapshot: snap || null, feed: feed.slice(0, 40) };
  }

  async function jarvisIngest(req, res) {
    if (!jarvisLimit.allow(clientIp(req))) throw new HttpError(429, "Zu viele Anfragen.");
    const cfg = await store.get("config", "jarvis");
    const tok = bearer(req);
    if (!cfg || !tok || !safeEqual(hashToken(tok), cfg.tokenHash)) throw new HttpError(401, "Ungültiges Verbindungs-Token.");
    const body = await readJson(req, 300_000);
    let snap;
    try { snap = sanitizeSnapshot(body); } catch (e) { throw new HttpError(400, e.message); }
    await store.put("jarvis", { id: "snapshot", ...snap, receivedAt: Date.now() });
    return send(res, 200, { ok: true, runs: snap.runs.length, sessions: snap.sessions.length });
  }

  async function publicRoute(req, res, url) {
    if (url.pathname === "/api/public/jarvis/ingest" && req.method === "POST") return jarvisIngest(req, res);
    if (url.pathname === "/api/public/plan" && req.method === "GET") return send(res, 200, await planInfo());
    if (url.pathname === "/api/public/waitlist" && req.method === "POST") {
      if (!signupLimit.allow(clientIp(req))) throw new HttpError(429, "Zu viele Anfragen. Bitte später noch einmal.");
      const body = await readJson(req, 5_000);
      const email = normEmail(body.email);
      if (!validEmail(email)) throw new HttpError(400, "Bitte eine gültige E-Mail-Adresse angeben.");
      await store.put("waitlist", { id: email, email, name: String(body.name || "").trim().slice(0, 120), at: Date.now() });
      return send(res, 201, { ok: true, message: "Du stehst auf der Warteliste. Wir melden uns, sobald ein Platz frei wird." });
    }
    if (url.pathname === "/api/public/stripe/webhook" && req.method === "POST") return stripeWebhook(req, res);
    const vc = url.pathname.match(/^\/api\/public\/voice\/([\w-]+)(\/turn)?$/);
    if (vc && req.method === "POST") return voiceRoute(req, res, url, vc[1], Boolean(vc[2]));
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

  const settingsId = (ws) => (ws === "main" ? "main" : `ws:${ws}`);
  async function getSettings(ws = "main") {
    const row = await store.get("settings", settingsId(ws));
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

  async function sentToday(ws = "main") {
    const since = Date.now() - DAY;
    return (await store.list("leads", (l) => inWorkspace(l, ws))).reduce((n, l) => n + l.sent.filter((x) => x.at >= since).length, 0);
  }
  const dailyLimitFor = (ws) => (ws === "main" ? mailer?.dailyLimit || sys.dailyLimit || 0 : sys.planDailyEmails || 0);

  async function acquisitionSummary(req, ws = "main") {
    const [leads, settings] = await Promise.all([store.list("leads", (l) => inWorkspace(l, ws)), getSettings(ws)]);
    const mine = new Set(leads.map((l) => l.id));
    return {
      stages: STAGES, funnel: FUNNEL,
      summary: summarizeLeads(leads, settings),
      mail: { configured: Boolean(mailer), from: mailer?.from || "", dailyLimit: dailyLimitFor(ws), sentToday: await sentToday(ws) },
      senderMissing: senderComplete(settings.sender),
      tasks: [...tasks].filter((t) => mine.has(t)),
      publicUrl: baseUrl(req),
    };
  }

  async function settingsRoute(req, res, ws = "main") {
    if (req.method === "GET") return send(res, 200, await getSettings(ws));
    if (req.method !== "PUT") throw new HttpError(405, "Methode nicht erlaubt.");
    const body = await readJson(req, 20_000);
    const cur = await getSettings(ws);
    const str = (v, n = 300) => (typeof v === "string" ? v.trim().slice(0, n) : "");
    const s = body.sender || {};
    const next = {
      id: settingsId(ws),
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
    lead.draft = await generateDraft({ ai, agent, lead, settings: await getSettings(lead.ownerId || "main"), kind });
    if (["neu"].includes(lead.stage)) lead.stage = "entwurf";
    addEvent(lead, "draft", { kind });
    await store.put("leads", lead);
  }

  async function sendLead(lead, req) {
    if (!mailer) throw new HttpError(503, "Kein E-Mail-Versand eingerichtet. Trage die SMTP-Daten unter System ein.");
    const lws = lead.ownerId || "main";
    const settings = await getSettings(lws);
    const missing = senderComplete(settings.sender);
    if (missing.length) throw new HttpError(400, `Bitte zuerst die Absenderangaben ergänzen: ${missing.join(", ")}.`);
    if (!isEmail(lead.email)) throw new HttpError(400, `${lead.company || "Dieser Lead"} hat keine gültige E-Mail-Adresse.`);
    if (lead.stage === "abgemeldet" || lead.stage === "kein_interesse") throw new HttpError(400, `${lead.company} möchte keine Nachrichten.`);
    const blocked = await store.get("blocklist", lead.email.toLowerCase());
    if (blocked) throw new HttpError(400, `${lead.email} hat sich abgemeldet.`);
    if (!lead.draft) throw new HttpError(400, "Es gibt noch keinen Entwurf.");
    const limit = dailyLimitFor(lws);
    if (await sentToday(lws) >= limit) throw new HttpError(429, `Tageslimit von ${limit} E-Mails erreicht. Morgen geht es weiter.`);
    const base = baseUrl(req);
    const unsubscribeUrl = `${base}/abmelden/${lead.unsubToken}`;
    const agent = await store.get("agents", lead.agentId);
    const parts = { draft: lead.draft, sender: settings.sender, demoUrl: `${base}/d/${lead.agentId}`, unsubscribeUrl, agent: agent || {} };
    await mailer.send({ to: lead.email, subject: lead.draft.subject, text: composeEmail(parts), html: composeHtml(parts), unsubscribeUrl: `${base}/api/public/unsubscribe/${lead.unsubToken}`, replyTo: settings.sender.email });
    lead.sent.push({ subject: lead.draft.subject, kind: lead.draft.kind, at: Date.now() });
    addEvent(lead, "email_sent", { kind: lead.draft.kind });
    lead.draft = null;
    lead.skipped = false;
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

  async function leadRoute(req, res, id, sub, me = {}) {
    const ws = workspaceOf(me);
    const settings = await getSettings(ws);
    if (!id && req.method === "GET") {
      const leads = await store.list("leads", (l) => inWorkspace(l, ws));
      return send(res, 200, leads.sort((a, b) => b.updatedAt - a.updatedAt).map((l) => leadView(l, settings)));
    }
    if (id === "bulk" && req.method === "POST") {
      const body = await readJson(req, 100_000);
      const own = new Set((await store.list("leads", (l) => inWorkspace(l, ws))).map((l) => l.id));
      const ids = (Array.isArray(body.ids) ? body.ids : []).filter((x) => typeof x === "string" && own.has(x)).slice(0, 500);
      if (body.action === "draft") {
        if (!ai.configured) throw new HttpError(503, `${ai.keyName || "Der KI-Schlüssel"} fehlt.`);
        return send(res, 202, { started: runBulk(ids, (lead) => makeDraft(lead, followUpDue(lead, settings) ? "followup" : "first")) });
      }
      if (body.action === "send") {
        if (!mailer) throw new HttpError(503, "Kein E-Mail-Versand eingerichtet. Trage die SMTP-Daten unter System ein.");
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
    const foundLead = id && await store.get("leads", id);
    const lead = foundLead && inWorkspace(foundLead, ws) ? foundLead : null;
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
      const parts = { draft: lead.draft, sender: settings.sender, demoUrl: `${base}/d/${lead.agentId}`, unsubscribeUrl: `${base}/abmelden/${lead.unsubToken}`, agent: (await store.get("agents", lead.agentId)) || {} };
      return send(res, 200, { subject: lead.draft.subject, text: composeEmail(parts), html: composeHtml(parts) });
    }
    // A copy of the exact e-mail to the sender's own address. Changes nothing on the lead.
    if (sub === "/test-send" && req.method === "POST") {
      if (!mailer) throw new HttpError(503, "Kein E-Mail-Versand eingerichtet. Trage die SMTP-Daten unter System ein.");
      if (!lead.draft) throw new HttpError(400, "Es gibt noch keinen Entwurf.");
      if (!isEmail(settings.sender.email)) throw new HttpError(400, "Trage zuerst deine E-Mail-Adresse in den Einstellungen ein.");
      if (!testLimit.allow(me.id || "x")) throw new HttpError(429, "Genug Vorschauen für den Moment. Bitte etwas warten.");
      const base = baseUrl(req);
      const parts = { draft: lead.draft, sender: settings.sender, demoUrl: `${base}/d/${lead.agentId}?intern=1`, unsubscribeUrl: `${base}/abmelden/vorschau`, agent: (await store.get("agents", lead.agentId)) || {} };
      await mailer.send({ to: settings.sender.email, subject: `[Vorschau] ${lead.draft.subject}`, text: composeEmail(parts), html: composeHtml(parts), unsubscribeUrl: `${base}/`, replyTo: settings.sender.email });
      return send(res, 200, { ok: true, to: settings.sender.email });
    }
    if (sub === "/skip" && req.method === "POST") {
      lead.skipped = true;
      addEvent(lead, "skipped");
      await store.put("leads", lead);
      return send(res, 200, leadView(lead, settings));
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
      agency: await agencyFor(agent.ownerId || "main"),
    });
  }

  async function agencyFor(ws) {
    if (ws === "main") return { name: sys.agencyName || "", contact: sys.agencyContact || "" };
    const s = (await getSettings(ws)).sender;
    return { name: s.company || s.name || "", contact: s.email || "" };
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
    // The demo page may be framed by the builder itself (review mode), nobody else.
    else if (rel === "preview.html") Object.assign(headers, { "cache-control": "no-cache", "x-frame-options": "SAMEORIGIN", "content-security-policy": "frame-ancestors 'self'", "referrer-policy": "same-origin" });
    else Object.assign(headers, { "cache-control": "no-cache", "x-frame-options": "DENY", "referrer-policy": "same-origin" });
    res.writeHead(200, headers);
    res.end(req.method === "HEAD" ? undefined : data);
  }

  return async function handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    await ready;
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
