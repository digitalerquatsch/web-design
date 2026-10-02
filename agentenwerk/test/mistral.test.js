import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { createMistralAi, toMistralMessages } from "../src/ai-mistral.js";
import { createAi } from "../src/ai.js";
import { runTurn } from "../src/chat.js";
import { fromTemplate } from "../public/prompt.js";

function sse(chunks) {
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

test("createAi picks Mistral by default and Claude on request", () => {
  assert.equal(createAi({ MISTRAL_API_KEY: "m" }).provider, "mistral");
  assert.equal(createAi({}).provider, "mistral");
  assert.equal(createAi({}).configured, false);
  assert.equal(createAi({ ANTHROPIC_API_KEY: "a" }).provider, "anthropic");
  assert.equal(createAi({ AI_PROVIDER: "anthropic", MISTRAL_API_KEY: "m", ANTHROPIC_API_KEY: "a" }).provider, "anthropic");
  assert.equal(createAi({ MISTRAL_API_KEY: "m", MISTRAL_MODEL: "mistral-large-latest" }).model, "mistral-large-latest");
});

test("parse sends a strict JSON schema and validates the answer", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: '{"subject":"Ihre Demo","body":"Hallo"}' } }] }), { status: 200 });
  };
  const ai = createMistralAi({ apiKey: "key", model: "mistral-medium-latest", fetchImpl });
  const out = await ai.parse({ system: "sys", messages: [{ role: "user", content: "u" }], schema: z.object({ subject: z.string(), body: z.string() }) });
  assert.deepEqual(out, { subject: "Ihre Demo", body: "Hallo" });
  const { url, init, body } = calls[0];
  assert.equal(url, "https://api.mistral.ai/v1/chat/completions");
  assert.equal(init.headers.authorization, "Bearer key");
  assert.equal(body.model, "mistral-medium-latest");
  assert.deepEqual(body.messages, [{ role: "system", content: "sys" }, { role: "user", content: "u" }]);
  assert.equal(body.response_format.type, "json_schema");
  assert.equal(body.response_format.json_schema.strict, true);
  assert.equal(body.response_format.json_schema.schema.$schema, undefined);
  assert.equal(body.response_format.json_schema.schema.additionalProperties, false);
});

test("parse rejects answers that do not match the schema, and API errors carry the status", async () => {
  const bad = createMistralAi({ apiKey: "k", fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"subject":1}' } }] })) });
  await assert.rejects(bad.parse({ messages: [], schema: z.object({ subject: z.string() }) }), /Schema/);
  const down = createMistralAi({ apiKey: "k", fetchImpl: async () => new Response("rate limited", { status: 429 }) });
  const err = await down.parse({ messages: [], schema: z.object({}) }).catch((e) => e);
  assert.equal(err.status, 429);
  assert.equal(down.isApiError(err), true);
});

test("history with tool calls translates to Mistral messages", () => {
  const msgs = toMistralMessages([{ type: "text", text: "A" }, { type: "text", text: "B" }], [
    { role: "user", content: "Termin bitte" },
    { role: "assistant", content: [{ type: "text", text: "Notiert." }, { type: "tool_use", id: "c1", name: "save_lead", input: { name: "Eva" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "ok" }] },
  ]);
  assert.deepEqual(msgs, [
    { role: "system", content: "A\n\nB" },
    { role: "user", content: "Termin bitte" },
    { role: "assistant", content: "Notiert.", tool_calls: [{ id: "c1", type: "function", function: { name: "save_lead", arguments: '{"name":"Eva"}' } }] },
    { role: "tool", tool_call_id: "c1", name: "save_lead", content: "ok" },
  ]);
});

test("a full chat turn with a streamed tool call runs through chat.js", async () => {
  const bodies = [];
  const replies = [
    sse([
      { choices: [{ delta: { content: "Gern, " } }] },
      { choices: [{ delta: { content: "ich notiere das." } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call1", function: { name: "save_lead", arguments: '{"name":"Eva",' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"phone":"0171 123"}' } }] }, finish_reason: "tool_calls" }] },
    ]),
    sse([{ choices: [{ delta: { content: "Wir melden uns." }, finish_reason: "stop" }] }]),
  ];
  const ai = createMistralAi({ apiKey: "k", fetchImpl: async (url, init) => { bodies.push(JSON.parse(init.body)); return replies.shift(); } });
  const messages = [];
  const captured = [];
  let streamed = "";
  const { reply } = await runTurn({
    agent: fromTemplate("leads"), messages, text: "Ich will verkaufen", ai,
    onText: (d) => { streamed += d; },
    onCapture: async (type, data) => captured.push({ type, data }),
  });
  assert.deepEqual(captured, [{ type: "lead", data: { name: "Eva", phone: "0171 123" } }]);
  assert.match(reply, /ich notiere das\.\s+Wir melden uns\./);
  assert.match(streamed, /Wir melden uns/);
  assert.equal(bodies[0].stream, true);
  assert.equal(bodies[0].tool_choice, "auto");
  assert.ok(bodies[0].tools.some((t) => t.type === "function" && t.function.name === "save_lead"));
  assert.equal(bodies[1].messages.at(-1).role, "tool");
  assert.equal(messages.length, 4, "user, assistant(tool_use), user(tool_result), assistant");
});
