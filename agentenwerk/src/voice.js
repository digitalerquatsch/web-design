// Phone bot over Twilio Programmable Voice: Twilio turns speech into text
// (<Gather input="speech">), the agent answers, Twilio reads the answer out
// (<Say>). Every webhook is checked against Twilio's request signature.

import crypto from "node:crypto";

const xml = (s) => String(s ?? "").replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]);

// https://www.twilio.com/docs/usage/security#validating-requests
export function twilioSignature(authToken, url, params) {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  return crypto.createHmac("sha1", authToken).update(data, "utf8").digest("base64");
}

export function validTwilioRequest(authToken, url, params, header) {
  if (!authToken || !header) return false;
  const expected = Buffer.from(twilioSignature(authToken, url, params));
  const got = Buffer.from(String(header));
  return expected.length === got.length && crypto.timingSafeEqual(expected, got);
}

// Text for speech: no markdown, no links, no emojis.
export function speakable(text) {
  return String(text || "")
    .replace(/\*\*|__|`|#+\s/g, "")
    .replace(/https?:\/\/\S+/g, "auf unserer Website")
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, "")
    .replace(/\s*\n+\s*/g, " ")
    .trim()
    .slice(0, 900);
}

// Callers must be told right away that they are talking to an AI (EU AI Act, Art. 50).
export function phoneGreeting(agent) {
  const g = speakable(agent.phoneGreeting || agent.welcome || "Wie kann ich Ihnen helfen?");
  return /\b(KI|künstliche|digitale[rn]?|virtuelle[rn]?)\b/i.test(g) ? g : `Sie sprechen mit dem KI-Assistenten von ${agent.company || "uns"}. ${g}`;
}

export function twiml({ say, gatherAction, voice, hangup = false, reprompt }) {
  const sayTag = (t) => `<Say language="de-DE" voice="${xml(voice)}">${xml(t)}</Say>`;
  if (hangup) return `<?xml version="1.0" encoding="UTF-8"?><Response>${sayTag(say)}<Hangup/></Response>`;
  return `<?xml version="1.0" encoding="UTF-8"?><Response>` +
    `<Gather input="speech" language="de-DE" speechTimeout="auto" speechModel="phone_call" action="${xml(gatherAction)}" method="POST">${sayTag(say)}</Gather>` +
    `${sayTag(reprompt || "Sind Sie noch da? Dann sagen Sie mir einfach, worum es geht.")}<Redirect method="POST">${xml(gatherAction)}?still=1</Redirect></Response>`;
}
