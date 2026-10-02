// Server settings an admin changes in the browser ("System" page) instead of
// editing .env. Environment variables are the defaults; values saved in the
// browser win. Secrets are never sent back to the browser in full.

export const SECRETS = ["mistralApiKey", "anthropicApiKey", "smtpPass", "stripeSecretKey", "stripeWebhookSecret", "twilioAuthToken"];

const FIELDS = {
  // general
  publicUrl: "url", agencyName: "str", agencyContact: "str", instagram: "str",
  // AI
  aiProvider: ["mistral", "anthropic"], mistralApiKey: "secret", mistralModel: "str", anthropicApiKey: "secret", anthropicModel: "str",
  // e-mail
  smtpHost: "str", smtpPort: "int", smtpSecure: "bool", smtpUser: "str", smtpPass: "secret", smtpFrom: "str", dailyLimit: "int",
  // subscription
  stripeSecretKey: "secret", stripeWebhookSecret: "secret", planName: "str", planPrice: "int", planSeats: "int",
  planDailyEmails: "int", planMonthlyAnalyses: "int", planMonthlyChats: "int", termsUrl: "url", privacyUrl: "url", imprintUrl: "url",
  // phone
  twilioAccountSid: "str", twilioAuthToken: "secret", twilioVoice: "str",
};

export function fromEnv(env = process.env) {
  return {
    publicUrl: (env.PUBLIC_URL || "").replace(/\/$/, ""),
    agencyName: env.AGENCY_NAME || "",
    agencyContact: env.AGENCY_CONTACT || "",
    instagram: env.INSTAGRAM || "",
    aiProvider: env.AI_PROVIDER === "anthropic" || (!env.MISTRAL_API_KEY && env.ANTHROPIC_API_KEY) ? "anthropic" : "mistral",
    mistralApiKey: env.MISTRAL_API_KEY || "",
    mistralModel: env.MISTRAL_MODEL || "mistral-medium-latest",
    anthropicApiKey: env.ANTHROPIC_API_KEY || "",
    anthropicModel: env.AGENT_MODEL || "claude-opus-5-5",
    smtpHost: env.SMTP_HOST || "",
    smtpPort: Number(env.SMTP_PORT || 587),
    smtpSecure: env.SMTP_SECURE ? env.SMTP_SECURE === "true" : Number(env.SMTP_PORT) === 465,
    smtpUser: env.SMTP_USER || "",
    smtpPass: env.SMTP_PASS || "",
    smtpFrom: env.SMTP_FROM || "",
    dailyLimit: Number(env.OUTREACH_DAILY_LIMIT || 40),
    stripeSecretKey: env.STRIPE_SECRET_KEY || "",
    stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET || "",
    planName: env.PLAN_NAME || "Agentenwerk Starter",
    planPrice: Number(env.PLAN_PRICE || 30),
    planSeats: Number(env.PLAN_SEATS || 5),
    planDailyEmails: 30,
    planMonthlyAnalyses: 300,
    planMonthlyChats: 3000,
    termsUrl: env.TERMS_URL || "",
    privacyUrl: env.PRIVACY_URL || "",
    imprintUrl: env.IMPRINT_URL || "",
    twilioAccountSid: env.TWILIO_ACCOUNT_SID || "",
    twilioAuthToken: env.TWILIO_AUTH_TOKEN || "",
    twilioVoice: env.TWILIO_VOICE || "Polly.Vicki-Neural",
  };
}

export async function loadSystem(store, env) {
  const saved = (await store.get("config", "system")) || {};
  const out = fromEnv(env);
  for (const k of Object.keys(FIELDS)) if (saved[k] !== undefined && saved[k] !== "") out[k] = saved[k];
  return out;
}

// What the browser sees: secrets only as "set" plus the last four characters.
export function maskedSystem(sys) {
  const out = {};
  for (const k of Object.keys(FIELDS)) {
    if (SECRETS.includes(k)) out[k] = { set: Boolean(sys[k]), hint: sys[k] ? `…${String(sys[k]).slice(-4)}` : "" };
    else out[k] = sys[k];
  }
  return out;
}

export class SystemError extends Error {}

// Applies a partial update from the browser. For secrets: a non-empty string
// replaces, null clears, anything else keeps the stored value.
export function applySystemUpdate(saved, body) {
  const next = { ...saved, id: "system" };
  for (const [k, type] of Object.entries(FIELDS)) {
    if (!(k in body)) continue;
    const v = body[k];
    if (type === "secret") {
      if (v === null) next[k] = "";
      else if (typeof v === "string" && v.trim()) next[k] = v.trim().slice(0, 500);
      continue;
    }
    if (Array.isArray(type)) { if (!type.includes(v)) throw new SystemError(`Ungültiger Wert für ${k}.`); next[k] = v; continue; }
    if (type === "bool") { next[k] = Boolean(v); continue; }
    if (type === "int") {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0 || n > 1_000_000) throw new SystemError(`${k} muss eine Zahl sein.`);
      next[k] = Math.round(n);
      continue;
    }
    const s = typeof v === "string" ? v.trim().slice(0, 300) : "";
    if (type === "url" && s && !/^https?:\/\/[^\s"'<>]+$/i.test(s)) throw new SystemError(`${k} muss mit http:// oder https:// beginnen.`);
    next[k] = type === "url" ? s.replace(/\/$/, "") : s;
  }
  if (next.instagram) next.instagram = String(next.instagram).replace(/^@/, "").replace(/^https?:\/\/(www\.)?instagram\.com\//i, "").replace(/\/.*$/, "");
  return next;
}

// The env-style view the existing factories (createAi, createMailer) read.
export function envFrom(sys) {
  return {
    AI_PROVIDER: sys.aiProvider,
    MISTRAL_API_KEY: sys.mistralApiKey, MISTRAL_MODEL: sys.mistralModel,
    ANTHROPIC_API_KEY: sys.anthropicApiKey, AGENT_MODEL: sys.anthropicModel,
    SMTP_HOST: sys.smtpHost, SMTP_PORT: String(sys.smtpPort || ""), SMTP_SECURE: String(Boolean(sys.smtpSecure)),
    SMTP_USER: sys.smtpUser, SMTP_PASS: sys.smtpPass, SMTP_FROM: sys.smtpFrom, OUTREACH_DAILY_LIMIT: String(sys.dailyLimit || 40),
  };
}

export const billingEnabled = (sys) => Boolean(sys.stripeSecretKey && sys.stripeWebhookSecret && sys.planPrice > 0);
export const phoneEnabled = (sys) => Boolean(sys.twilioAccountSid && sys.twilioAuthToken);
export const instagramUrl = (sys) => (sys.instagram ? `https://ig.me/m/${encodeURIComponent(sys.instagram)}` : "");
