import crypto from "node:crypto";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function hostName(req) {
  const h = String(req.headers.host || "").toLowerCase();
  return h.startsWith("[") ? h.slice(0, h.indexOf("]") + 1) : h.split(":")[0];
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * Admin routes (the builder and its API).
 * - Every admin request must carry the custom header X-Agentenwerk. A browser
 *   only sends it after a CORS preflight, which admin routes never grant, so
 *   another website cannot drive the API from a visitor's browser.
 * - With ADMIN_TOKEN set, a matching bearer token is required.
 * - Without it, only requests addressed to localhost are accepted, which also
 *   stops DNS-rebinding tricks that point a foreign name at 127.0.0.1.
 */
export function checkAdmin(req, adminToken) {
  if (!req.headers["x-agentenwerk"]) return { ok: false, status: 403, message: "Fehlender Header X-Agentenwerk." };
  if (adminToken) {
    const auth = String(req.headers.authorization || "");
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    return token && safeEqual(token, adminToken) ? { ok: true } : { ok: false, status: 401, message: "Bitte den Admin-Token eingeben." };
  }
  return LOOPBACK_HOSTS.has(hostName(req))
    ? { ok: true }
    : { ok: false, status: 403, message: "Ohne ADMIN_TOKEN ist der Builder nur über localhost erreichbar." };
}

export function clientIp(req) {
  return req.socket.remoteAddress || "unknown";
}

// Fixed-window counter per key. Good enough for one process.
export class RateLimiter {
  constructor(limit, windowMs) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.hits = new Map();
  }
  allow(key, now = Date.now()) {
    const e = this.hits.get(key);
    if (!e || now - e.start >= this.windowMs) {
      this.hits.set(key, { start: now, n: 1 });
      if (this.hits.size > 10000) for (const [k, v] of this.hits) if (now - v.start >= this.windowMs) this.hits.delete(k);
      return true;
    }
    e.n++;
    return e.n <= this.limit;
  }
}

// Which page may embed which agent. An empty list allows any origin.
export function originAllowed(agent, origin) {
  const list = (agent.allowedOrigins || []).map((o) => o.trim().replace(/\/$/, "").toLowerCase()).filter(Boolean);
  if (!list.length) return true;
  if (!origin) return false;
  return list.includes(origin.toLowerCase());
}
