import crypto from "node:crypto";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function hostName(req) {
  const h = String(req.headers.host || "").toLowerCase();
  return h.startsWith("[") ? h.slice(0, h.indexOf("]") + 1) : h.split(":")[0];
}

export function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Addressed to localhost by name. Used before the first account exists, and
// it also stops DNS-rebinding tricks that point a foreign name at 127.0.0.1.
export function isLoopback(req) {
  return LOOPBACK_HOSTS.has(hostName(req));
}

export function bearer(req) {
  const auth = String(req.headers.authorization || "");
  return auth.startsWith("Bearer ") ? auth.slice(7) : "";
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
