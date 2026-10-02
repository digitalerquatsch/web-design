// Accounts for the builder: login with e-mail and password, access requests
// that an admin approves ("freischalten"), roles, and sessions in an
// HttpOnly cookie. Passwords are hashed with scrypt; only a hash of each
// session token is stored.

import crypto from "node:crypto";
import { newId } from "./store.js";

export const ROLES = { admin: "Admin", team: "Team", abo: "Abo", kunde: "Kunde" };
export const STATUSES = { pending: "Wartet auf Freischaltung", active: "Aktiv", blocked: "Gesperrt" };
export const COOKIE = "aw_session";
const SESSION_DAYS = 14;
const SCRYPT = { N: 16384, r: 8, p: 1 };

export class AuthError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64, SCRYPT);
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function verifyPassword(password, stored) {
  const [kind, salt, hash] = String(stored || "").split("$");
  if (kind !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64");
  const actual = crypto.scryptSync(String(password), Buffer.from(salt, "base64"), expected.length, SCRYPT);
  return crypto.timingSafeEqual(actual, expected);
}

export function passwordProblem(pw) {
  if (typeof pw !== "string" || pw.length < 10) return "Das Passwort braucht mindestens 10 Zeichen.";
  if (pw.length > 200) return "Das Passwort ist zu lang.";
  return null;
}

export function temporaryPassword() {
  // Readable: no 0/O/1/l. 14 chars from 55 symbols, about 80 bits.
  const alphabet = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.randomBytes(14);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("").replace(/(.{7})/, "$1-");
}

export const normEmail = (e) => String(e || "").trim().toLowerCase();
export const validEmail = (e) => /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[a-z]{2,}$/i.test(e);
const sha = (t) => crypto.createHash("sha256").update(t).digest("hex");

export function publicUser(u) {
  if (!u) return null;
  const { passwordHash, ...rest } = u;
  return rest;
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

let dummyHash = null; // compared against for unknown e-mails, so they take as long as wrong passwords

export function createAuth({ store }) {
  async function users() { return store.list("users"); }

  async function activeAdmins(exceptId) {
    return (await users()).filter((u) => u.role === "admin" && u.status === "active" && u.id !== exceptId).length;
  }

  return {
    users,
    activeAdmins,

    async count() { return (await users()).length; },

    async byEmail(email) {
      const e = normEmail(email);
      return (await users()).find((u) => u.email === e) || null;
    },

    async create({ name, email, password, company = "", role = "team", status = "pending", note = "", extra = {} }) {
      const e = normEmail(email);
      if (!validEmail(e)) throw new AuthError(400, "Bitte eine gültige E-Mail-Adresse angeben.");
      if (!String(name || "").trim()) throw new AuthError(400, "Bitte einen Namen angeben.");
      const problem = passwordProblem(password);
      if (problem) throw new AuthError(400, problem);
      if (await this.byEmail(e)) throw new AuthError(409, "Für diese E-Mail-Adresse gibt es schon einen Zugang.");
      const user = {
        id: newId(),
        email: e,
        name: String(name).trim().slice(0, 120),
        company: String(company || "").trim().slice(0, 120),
        note: String(note || "").trim().slice(0, 500),
        role: ROLES[role] ? role : "team",
        status: STATUSES[status] ? status : "pending",
        agentIds: [],
        passwordHash: hashPassword(password),
        createdAt: Date.now(),
        approvedAt: status === "active" ? Date.now() : null,
        lastLoginAt: null,
        autopilotUnlocked: false,
        ...extra,
      };
      await store.put("users", user);
      return user;
    },

    async login(email, password) {
      const user = await this.byEmail(email);
      // Hash anyway so unknown addresses take as long as wrong passwords.
      dummyHash ||= hashPassword(crypto.randomBytes(12).toString("hex"));
      const ok = user ? verifyPassword(password, user.passwordHash) : (verifyPassword(password, dummyHash), false);
      if (!ok) throw new AuthError(401, "E-Mail oder Passwort stimmt nicht.");
      if (user.status === "pending") throw new AuthError(403, "Dein Zugang wartet noch auf Freischaltung durch einen Admin.");
      if (user.status === "blocked") throw new AuthError(403, "Dieser Zugang ist gesperrt.");
      user.lastLoginAt = Date.now();
      await store.put("users", user);
      return user;
    },

    async startSession(user) {
      const token = crypto.randomBytes(32).toString("base64url");
      await store.put("sessions", { id: sha(token), userId: user.id, createdAt: Date.now(), expiresAt: Date.now() + SESSION_DAYS * 86_400_000 });
      return token;
    },

    async userForToken(token) {
      if (!token) return null;
      const s = await store.get("sessions", sha(token));
      if (!s) return null;
      if (s.expiresAt < Date.now()) { await store.remove("sessions", (x) => x.id === s.id); return null; }
      const u = await store.get("users", s.userId);
      return u && u.status === "active" ? u : null;
    },

    async endSession(token) {
      if (token) await store.remove("sessions", (x) => x.id === sha(token));
    },

    async endAllSessions(userId) {
      await store.remove("sessions", (x) => x.userId === userId);
    },

    cookie(token, { secure }) {
      const parts = [`${COOKIE}=${token}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${token ? SESSION_DAYS * 86400 : 0}`];
      if (secure) parts.push("Secure");
      return parts.join("; ");
    },
  };
}

/* ---------- permissions ---------- */

// Abo users each get their own workspace; admin and team share "main".
export const workspaceOf = (user) => (user?.role === "abo" ? user.id : "main");
export const inWorkspace = (rec, ws) => (rec?.ownerId || "main") === ws;

export function canSeeAgent(user, agent) {
  if (!agent) return false;
  if (user.role === "kunde") return (user.agentIds || []).includes(agent.id);
  return inWorkspace(agent, workspaceOf(user));
}

// Abo users unlock the autopilot (and acquisition) through the mentoring.
export const autopilotAllowed = (user) => user.role !== "abo" || user.autopilotUnlocked === true;

// What each role may do in the admin API.
export function allowed(user, method, path) {
  if (user.role === "admin") return true;
  if (/^\/api\/(users|auth\/config|system|jarvis)/.test(path)) return false;
  if (user.role === "team" || user.role === "abo") return true;
  // kunde
  if (path === "/api/status" || path === "/api/overview" || path === "/api/auth/password" || path === "/api/account") return true;
  if (path === "/api/agents") return method === "GET";
  if (path === "/api/test-chat") return method === "POST";
  const m = path.match(/^\/api\/agents\/[\w-]+(\/[a-z-]+)?$/);
  if (m) return m[1] ? method === "GET" : (method === "GET" || method === "PUT");
  return false;
}

export function ownsAgent(user, agentId) {
  return user.role !== "kunde" || (user.agentIds || []).includes(agentId);
}
