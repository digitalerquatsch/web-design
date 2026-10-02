// Picks the AI provider. Everything else receives an `ai` object with
// parse() and stream(), which the tests replace with fakes.
//
// Default is Mistral AI (EU provider, Paris). Set AI_PROVIDER=anthropic to
// run on Claude instead.

import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { createMistralAi } from "./ai-mistral.js";

export function createAi(env = process.env) {
  const provider = (env.AI_PROVIDER || (env.MISTRAL_API_KEY || !env.ANTHROPIC_API_KEY ? "mistral" : "anthropic")).toLowerCase();
  if (provider === "anthropic" || provider === "claude") return createClaudeAi({ apiKey: env.ANTHROPIC_API_KEY, model: env.AGENT_MODEL || "claude-opus-5-5" });
  return createMistralAi({ apiKey: env.MISTRAL_API_KEY, model: env.MISTRAL_MODEL || "mistral-medium-latest" });
}

export class AiError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

export function createClaudeAi({ apiKey, model = "claude-opus-5-5" } = {}) {
  const client = new Anthropic(apiKey ? { apiKey } : {});
  // Server-side fallback: if a safety classifier declines a request, the API
  // re-runs it on the model Anthropic recommends for that category instead
  // of returning a refusal.
  const base = { model, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" };

  return {
    provider: "anthropic",
    keyName: "ANTHROPIC_API_KEY",
    model,
    configured: Boolean(apiKey),

    async parse({ system, messages, schema, maxTokens = 16000, effort = "medium" }) {
      const res = await client.beta.messages.parse({
        ...base,
        max_tokens: maxTokens,
        system,
        messages,
        output_config: { effort, format: betaZodOutputFormat(schema) },
      });
      if (res.stop_reason === "refusal") throw new AiError("Die Analyse wurde vom Modell abgelehnt.", "refusal");
      if (res.stop_reason === "max_tokens") throw new AiError("Die Antwort war zu lang und wurde abgeschnitten.", "max_tokens");
      if (!res.parsed_output) throw new AiError("Die Antwort des Modells war nicht lesbar.", "invalid_output");
      return res.parsed_output;
    },

    // Returns the SDK's MessageStream: .on("text", cb) and .finalMessage().
    stream({ system, messages, tools, maxTokens = 8000, effort = "low" }) {
      return client.beta.messages.stream({
        ...base,
        max_tokens: maxTokens,
        system,
        messages,
        tools,
        output_config: { effort },
      });
    },

    isApiError(err) {
      return err instanceof Anthropic.APIError;
    },
  };
}
