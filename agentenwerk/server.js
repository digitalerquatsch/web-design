import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
try { process.loadEnvFile(path.join(here, ".env")); } catch { /* no .env: use the real environment */ }

const { createApp } = await import("./src/app.js");
const { createAi } = await import("./src/ai.js");
const { createScreenshotter } = await import("./src/screenshot.js");

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "127.0.0.1";
const adminToken = process.env.ADMIN_TOKEN || "";
const ai = createAi();

if (!ai.configured) console.warn("Hinweis: ANTHROPIC_API_KEY fehlt. Builder und Widget laufen, aber Analyse und Chat antworten erst mit Key.");
if (host !== "127.0.0.1" && host !== "localhost" && !adminToken) console.warn("Warnung: Der Server lauscht nicht nur lokal, aber ADMIN_TOKEN ist nicht gesetzt. Der Builder ist dann nur über http://localhost erreichbar.");

const screenshotter = await createScreenshotter();
if (!screenshotter) console.warn("Hinweis: playwright ist nicht installiert. Demos zeigen eine nachgebaute Seite statt eines Screenshots (npm install playwright && npx playwright install chromium).");

const handler = createApp({
  dataDir: path.resolve(here, process.env.DATA_DIR || "data"),
  ai,
  adminToken,
  publicUrl: (process.env.PUBLIC_URL || "").replace(/\/$/, ""),
  screenshotter,
  agency: { name: process.env.AGENCY_NAME || "", contact: process.env.AGENCY_CONTACT || "" },
});

http.createServer(handler).listen(port, host, () => {
  console.log(`Agentenwerk läuft auf http://${host === "0.0.0.0" ? "localhost" : host}:${port}  (Modell: ${ai.model})`);
});
