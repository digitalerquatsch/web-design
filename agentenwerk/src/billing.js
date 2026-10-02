// Stripe over its REST API (no SDK): Checkout for the monthly subscription,
// the customer portal, cancellation, and signed webhooks.

import crypto from "node:crypto";

export class BillingError extends Error {
  constructor(message, status = 502) { super(message); this.status = status; }
}

// Stripe's form encoding: nested objects and arrays as a[b][0][c]=v.
export function formEncode(obj, prefix = "", out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === "object") formEncode(v, key, out);
    else out.append(key, String(v));
  }
  return out;
}

export function createStripe({ secretKey, fetchImpl = fetch }) {
  async function call(method, path, params) {
    let res;
    try {
      res = await fetchImpl(`https://api.stripe.com/v1${path}`, {
        method,
        headers: { authorization: `Bearer ${secretKey}`, "content-type": "application/x-www-form-urlencoded" },
        body: params ? formEncode(params).toString() : undefined,
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new BillingError("Stripe ist gerade nicht erreichbar.");
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new BillingError(data?.error?.message || `Stripe-Fehler ${res.status}`);
    return data;
  }
  return {
    checkout({ user, plan, successUrl, cancelUrl }) {
      return call("POST", "/checkout/sessions", {
        mode: "subscription",
        customer_email: user.email,
        client_reference_id: user.id,
        success_url: successUrl,
        cancel_url: cancelUrl,
        locale: "de",
        billing_address_collection: "required",
        tax_id_collection: { enabled: true },
        subscription_data: { metadata: { userId: user.id } },
        metadata: { userId: user.id },
        line_items: [{ quantity: 1, price_data: { currency: "eur", unit_amount: Math.round(plan.price * 100), recurring: { interval: "month" }, product_data: { name: plan.name } } }],
      });
    },
    portal({ customer, returnUrl }) {
      return call("POST", "/billing_portal/sessions", { customer, return_url: returnUrl });
    },
    cancelAtPeriodEnd(subscriptionId) {
      return call("POST", `/subscriptions/${encodeURIComponent(subscriptionId)}`, { cancel_at_period_end: true });
    },
    resume(subscriptionId) {
      return call("POST", `/subscriptions/${encodeURIComponent(subscriptionId)}`, { cancel_at_period_end: false });
    },
  };
}

// Checks the Stripe-Signature header (t=…,v1=…) against the raw body.
export function verifyWebhook(raw, header, secret, { toleranceSec = 300, now = Date.now() } = {}) {
  const parts = Object.fromEntries(String(header || "").split(",").map((p) => p.split("=")).filter((p) => p.length === 2));
  const t = Number(parts.t);
  const sigs = String(header || "").split(",").filter((p) => p.startsWith("v1=")).map((p) => p.slice(3));
  if (!t || !sigs.length) throw new BillingError("Webhook ohne gültige Signatur.", 400);
  if (Math.abs(now / 1000 - t) > toleranceSec) throw new BillingError("Webhook ist zu alt.", 400);
  const expected = crypto.createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex");
  const ok = sigs.some((s) => s.length === expected.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
  if (!ok) throw new BillingError("Webhook-Signatur stimmt nicht.", 400);
  return JSON.parse(raw);
}

export const ACTIVE_BILLING = new Set(["active", "trialing", "past_due"]);
