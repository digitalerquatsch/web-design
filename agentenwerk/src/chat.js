// One visitor turn: stream the agent's reply, run its tools (save a lead,
// record a booking request) and keep the conversation append-only, so
// thinking blocks from earlier turns stay valid on the next request.

import { z } from "zod";
import { activePrompt, withDefaults, LEAD_FIELDS } from "../public/prompt.js";

const MAX_ROUNDS = 4;

const str = z.string().max(500).optional();
function leadSchema(fields) {
  return z.object(Object.fromEntries([...fields.map((f) => [f, str]), ["notiz", z.string().max(1000).optional()]]));
}

export function chatTools(agent) {
  const fields = agent.leadFields;
  const props = Object.fromEntries(fields.map((f) => [f, { type: "string", description: LEAD_FIELDS[f] }]));
  const tools = [];
  if (agent.goal === "booking") {
    tools.push({
      name: "book_appointment",
      description: "Speichert eine Terminanfrage für das Team. Erst aufrufen, wenn der Besucher die Zusammenfassung bestätigt hat.",
      eager_input_streaming: true,
      input_schema: {
        type: "object",
        properties: { leistung: { type: "string", description: "Gewünschte Leistung" }, datum: { type: "string", description: "Wunschdatum" }, uhrzeit: { type: "string", description: "Wunschuhrzeit" }, ...props },
        required: ["leistung", "datum"],
      },
    });
  }
  tools.push({
    name: "save_lead",
    description: "Speichert Kontaktdaten und Anliegen eines Besuchers, damit sich das Team meldet.",
    eager_input_streaming: true,
    input_schema: { type: "object", properties: { ...props, notiz: { type: "string", description: "Kurze Zusammenfassung des Bedarfs" } } },
  });
  return tools;
}

function validator(name, agent) {
  if (name === "book_appointment") return leadSchema(agent.leadFields).extend({ leistung: z.string().min(1).max(300), datum: z.string().min(1).max(100), uhrzeit: str });
  if (name === "save_lead") return leadSchema(agent.leadFields);
  return null;
}

function clean(o) {
  const r = {};
  for (const [k, v] of Object.entries(o || {})) if (typeof v === "string" && v.trim()) r[k] = v.trim();
  return r;
}

const PHONE = "Du führst gerade ein Telefongespräch. Deine Antworten werden vorgelesen: höchstens zwei kurze Sätze, keine Aufzählungen, keine Links, keine Sonderzeichen. Nenne Zahlen so, wie man sie spricht. Frag Telefonnummern nicht ab, die Nummer des Anrufers ist bekannt. Wenn der Anrufer sich verabschiedet, verabschiede dich kurz.";

export function systemFor(agentCfg, now = new Date(), channel = "web") {
  const agent = withDefaults(agentCfg);
  const date = now.toLocaleDateString("de-DE", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "Europe/Berlin" });
  return [
    { type: "text", text: activePrompt(agent), cache_control: { type: "ephemeral" } },
    channel === "phone"
      ? { type: "text", text: `${PHONE}\nAntworte ausschließlich als ${agent.name || "der Assistent"}, ohne Meta-Kommentare. Heute ist ${date}.` }
      : { type: "text", text: `Du bist live im Chat-Widget auf der Website. Deine Begrüßung wurde dem Besucher bereits angezeigt: „${agent.welcome}“\nAntworte ausschließlich als ${agent.name || "der Assistent"}, ohne Meta-Kommentare. Heute ist ${date}.` },
  ];
}

/**
 * @param {object} p
 * @param {object} p.agent       agent config
 * @param {Array}  p.messages    conversation so far (API message params, mutated: the turn is appended on success)
 * @param {string} p.text        the visitor's message
 * @param {object} p.ai          from createAi()
 * @param {(delta:string)=>void} p.onText
 * @param {(type:string, data:object)=>Promise<void>} p.onCapture   persists a lead or booking request
 * @returns {Promise<{reply:string, refused:boolean}>}
 */
export async function runTurn({ agent: agentCfg, messages, text, ai, onText = () => {}, onCapture = async () => {}, channel = "web" }) {
  const agent = withDefaults(agentCfg);
  const tools = chatTools(agent);
  const system = systemFor(agent, new Date(), channel);
  const turn = [{ role: "user", content: text }];
  let reply = "";
  let jsonRetries = 0;

  for (let round = 0; round < MAX_ROUNDS; ) {
    const stream = ai.stream({ system, messages: [...messages, ...turn], tools });
    stream.on("text", (delta) => { reply += delta; onText(delta); });
    let msg;
    try {
      msg = await stream.finalMessage();
      jsonRetries = 0;
    } catch (err) {
      // Only an unparseable streamed tool input is retried; API errors propagate.
      if (ai.isApiError(err) || jsonRetries++ >= 2) throw err;
      continue;
    }
    round++;

    if (msg.stop_reason === "refusal") {
      // The turn is not appended: the conversation stays as it was.
      return { reply: "", refused: true };
    }
    turn.push({ role: "assistant", content: msg.content });
    const toolUses = msg.content.filter((b) => b.type === "tool_use");
    if (msg.stop_reason !== "tool_use" || !toolUses.length) break;

    const results = [];
    for (const t of toolUses) {
      const schema = validator(t.name, agent);
      const parsed = schema ? schema.safeParse(t.input) : null;
      if (!parsed?.success) {
        results.push({ type: "tool_result", tool_use_id: t.id, is_error: true, content: schema ? "Ungültige Eingabe. Prüfe die Angaben und versuche es erneut." : "Unbekanntes Werkzeug." });
        continue;
      }
      const data = clean(parsed.data);
      try {
        await onCapture(t.name === "book_appointment" ? "termin" : "lead", data);
        results.push({ type: "tool_result", tool_use_id: t.id, content: t.name === "book_appointment" ? "Terminanfrage gespeichert. Das Team bestätigt den Termin." : "Kontakt gespeichert. Das Team meldet sich." });
      } catch {
        results.push({ type: "tool_result", tool_use_id: t.id, is_error: true, content: "Speichern fehlgeschlagen. Bitte den Besucher, sich direkt beim Team zu melden." });
      }
    }
    turn.push({ role: "user", content: results });
    if (reply && !reply.endsWith("\n")) { reply += "\n\n"; onText("\n\n"); }
  }

  // A turn that ended on tool results needs a closing assistant message to
  // keep user/assistant alternation; drop it rather than send it back half-done.
  if (turn[turn.length - 1].role === "user" && turn.length > 1) turn.pop(), turn.pop();
  if (turn.length > 1) messages.push(...turn);
  return { reply: reply.trim(), refused: false };
}
