// Mistral AI (La Plateforme, EU provider) behind the same small interface
// the rest of the app uses: parse() for structured output and stream() for
// chat turns. stream() speaks Anthropic-style messages and content blocks on
// the outside (text / tool_use / tool_result) and translates to Mistral's
// chat-completions format on the wire, so chat.js does not care which
// provider runs.

import { z } from "zod";

export class MistralError extends Error {
  constructor(message, status) { super(message); this.status = status; this.isApiError = true; }
}
class ToolArgsError extends Error {}

const API = "https://api.mistral.ai/v1/chat/completions";

function systemText(system) {
  if (!system) return "";
  return Array.isArray(system) ? system.map((b) => b.text).join("\n\n") : String(system);
}

// Anthropic-style history -> Mistral messages.
export function toMistralMessages(system, messages) {
  const out = [];
  const sys = systemText(system);
  if (sys) out.push({ role: "system", content: sys });
  for (const m of messages) {
    if (typeof m.content === "string") { out.push({ role: m.role, content: m.content }); continue; }
    if (m.role === "assistant") {
      const text = m.content.filter((b) => b.type === "text").map((b) => b.text).join("");
      const calls = m.content.filter((b) => b.type === "tool_use").map((b) => ({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
      const msg = { role: "assistant", content: text };
      if (calls.length) msg.tool_calls = calls;
      out.push(msg);
    } else {
      const results = m.content.filter((b) => b.type === "tool_result");
      const names = new Map();
      for (const prev of out) for (const c of prev.tool_calls || []) names.set(c.id, c.function.name);
      for (const r of results) out.push({ role: "tool", tool_call_id: r.tool_use_id, name: names.get(r.tool_use_id) || "tool", content: typeof r.content === "string" ? r.content : JSON.stringify(r.content) });
      const text = m.content.filter((b) => b.type === "text").map((b) => b.text).join("");
      if (text) out.push({ role: "user", content: text });
    }
  }
  return out;
}

export function toMistralTools(tools = []) {
  return tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } }));
}

const STOP = { stop: "end_turn", tool_calls: "tool_use", length: "max_tokens", model_length: "max_tokens", error: "error" };

export function createMistralAi({ apiKey = process.env.MISTRAL_API_KEY, model = process.env.MISTRAL_MODEL || "mistral-medium-latest", fetchImpl = fetch } = {}) {
  async function post(body, signal) {
    let res;
    try {
      res = await fetchImpl(API, {
        method: "POST",
        headers: { "content-type": "application/json", accept: body.stream ? "text/event-stream" : "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, ...body }),
        signal: signal ?? AbortSignal.timeout(180_000),
      });
    } catch (e) {
      throw new MistralError(`Mistral ist nicht erreichbar (${e?.name || "Netzwerkfehler"}).`, 0);
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new MistralError(`Mistral antwortet mit Status ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`, res.status);
    }
    return res;
  }

  return {
    provider: "mistral",
    keyName: "MISTRAL_API_KEY",
    model,
    configured: Boolean(apiKey),

    async parse({ system, messages, schema, maxTokens = 16000 }) {
      const { $schema, ...jsonSchema } = z.toJSONSchema(schema);
      const res = await post({
        messages: toMistralMessages(system, messages),
        max_tokens: maxTokens,
        temperature: 0.2,
        response_format: { type: "json_schema", json_schema: { name: "result", schema: jsonSchema, strict: true } },
      });
      const data = await res.json();
      const choice = data.choices?.[0];
      if (choice?.finish_reason === "length") throw Object.assign(new Error("Die Antwort war zu lang und wurde abgeschnitten."), { code: "max_tokens" });
      let parsed;
      try { parsed = JSON.parse(choice?.message?.content || ""); } catch { throw Object.assign(new Error("Die Antwort des Modells war nicht lesbar."), { code: "invalid_output" }); }
      const checked = schema.safeParse(parsed);
      if (!checked.success) throw Object.assign(new Error("Die Antwort des Modells passte nicht zum Schema."), { code: "invalid_output" });
      return checked.data;
    },

    stream({ system, messages, tools, maxTokens = 4000 }) {
      const handlers = [];
      const body = { messages: toMistralMessages(system, messages), max_tokens: maxTokens, temperature: 0.4, stream: true };
      if (tools?.length) { body.tools = toMistralTools(tools); body.tool_choice = "auto"; }
      return {
        on(evt, fn) { if (evt === "text") handlers.push(fn); return this; },
        async finalMessage() {
          const res = await post(body);
          const reader = res.body.getReader();
          const dec = new TextDecoder();
          let buf = "", text = "", finish = null;
          const calls = [];
          const handle = (data) => {
            const choice = data.choices?.[0];
            if (!choice) return;
            const d = choice.delta || {};
            if (typeof d.content === "string" && d.content) { text += d.content; for (const h of handlers) h(d.content); }
            else if (Array.isArray(d.content)) for (const part of d.content) if (part?.type === "text" && part.text) { text += part.text; for (const h of handlers) h(part.text); }
            for (const tc of d.tool_calls || []) {
              const i = tc.index ?? calls.length;
              calls[i] ||= { id: "", name: "", args: "" };
              if (tc.id) calls[i].id = tc.id;
              if (tc.function?.name) calls[i].name = tc.function.name;
              if (tc.function?.arguments) calls[i].args += typeof tc.function.arguments === "string" ? tc.function.arguments : JSON.stringify(tc.function.arguments);
            }
            if (choice.finish_reason) finish = choice.finish_reason;
          };
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            const lines = buf.split("\n");
            buf = lines.pop();
            for (const line of lines) {
              const l = line.trim();
              if (!l.startsWith("data:")) continue;
              const payload = l.slice(5).trim();
              if (!payload || payload === "[DONE]") continue;
              try { handle(JSON.parse(payload)); } catch { /* keep-alive or partial line */ }
            }
          }
          const content = [];
          if (text) content.push({ type: "text", text });
          for (const c of calls.filter(Boolean)) {
            let input;
            try { input = c.args ? JSON.parse(c.args) : {}; } catch { throw new ToolArgsError("Werkzeug-Argumente waren kein gültiges JSON."); }
            content.push({ type: "tool_use", id: c.id || `call_${Math.random().toString(36).slice(2, 10)}`, name: c.name, input });
          }
          const stop = calls.length ? "tool_use" : (STOP[finish] || "end_turn");
          return { stop_reason: stop, content };
        },
      };
    },

    isApiError(err) {
      return err instanceof MistralError;
    },
  };
}
