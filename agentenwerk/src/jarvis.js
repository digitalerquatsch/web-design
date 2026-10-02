// JARVIS connection. JARVIS stays on the Mac (loopback only); a small script
// there pushes a snapshot of runs, sessions and usage to this server. Nothing
// here ever calls back into the Mac.
import crypto from "node:crypto";

export const TOKEN_PREFIX = "jv_";
export const STALE_MS = 10 * 60_000;

export const newToken = () => TOKEN_PREFIX + crypto.randomBytes(24).toString("base64url");
export const hashToken = (t) => crypto.createHash("sha256").update(String(t)).digest("hex");

const str = (v, n) => (typeof v === "string" ? v.slice(0, n) : "");
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const RUN_STATES = new Set(["queued", "running", "succeeded", "failed", "timed_out", "cancelled"]);
const SESSION_STATES = new Set(["needs_you", "working", "idle", "fresh", "gone"]);

// Everything from the Mac is untrusted text: cap sizes and counts, keep only known fields.
export function sanitizeSnapshot(body) {
  if (!body || typeof body !== "object") throw new Error("Ungültige Daten.");
  const runs = (Array.isArray(body.runs) ? body.runs : []).slice(0, 50).map((r) => ({
    id: str(String(r?.id ?? ""), 60),
    project: str(r?.project_name ?? r?.project, 120),
    prompt: str(r?.prompt, 300),
    status: RUN_STATES.has(r?.status) ? r.status : "queued",
    summary: str(r?.summary, 400),
    error: str(r?.error, 300),
    model: str(r?.model, 60),
    costUsd: num(r?.cost_usd),
    createdAt: num(r?.created_at), endedAt: num(r?.ended_at),
  })).filter((r) => r.id);
  const sessions = (Array.isArray(body.sessions) ? body.sessions : []).slice(0, 100).map((s) => ({
    id: str(String(s?.session_id ?? s?.id ?? ""), 80),
    project: str(s?.project, 120),
    state: SESSION_STATES.has(s?.state) ? s.state : "idle",
    needs: str(typeof s?.needs === "string" ? s.needs : "", 300),
    title: str(s?.title, 160),
    summary: str(s?.summary, 300),
  })).filter((s) => s.id);
  const windows = (Array.isArray(body.limits?.windows) ? body.limits.windows : []).slice(0, 6).map((w) => ({
    key: str(w?.key, 30), label: str(w?.label, 60), utilization: num(w?.utilization), resetsAt: num(w?.resets_at), expired: Boolean(w?.expired),
  }));
  const st = body.stats && typeof body.stats === "object" ? body.stats : {};
  return {
    host: str(body.host, 80),
    sentAt: num(body.sentAt),
    stats: { total: num(st.total), succeeded: num(st.succeeded), failed: num(st.failed), running: num(st.running) },
    runs, sessions, limits: { measured: Boolean(body.limits?.measured), windows },
  };
}
