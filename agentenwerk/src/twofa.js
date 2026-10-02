import crypto from "node:crypto";

export const newCode = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
// Bound to the challenge id so a code is useless for any other challenge.
export const hashCode = (challengeId, code) => crypto.createHash("sha256").update(`${challengeId}:${code}`).digest("hex");
