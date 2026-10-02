import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
try { process.loadEnvFile(path.join(here, ".env")); } catch { /* no .env: use the real environment */ }

const { createApp } = await import("./src/app.js");
const { createAi } = await import("./src/ai.js");
const { createScreenshotter } = await import("./src/screenshot.js");
const { createMailer } = await import("./src/outreach.js");
const { envFrom } = await import("./src/system.js");

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "127.0.0.1";
const adminToken = process.env.ADMIN_TOKEN || "";
const ai = createAi();

if (host !== "127.0.0.1" && host !== "localhost" && !adminToken) console.warn("Hinweis: Der Server lauscht im Netz. Lege den ersten Admin über localhost an (oder setze ADMIN_TOKEN), sonst kann niemand von außen den ersten Zugang erstellen.");

const screenshotter = await createScreenshotter();
if (!screenshotter) console.warn("Hinweis: playwright ist nicht installiert. Demos zeigen eine nachgebaute Seite statt eines Screenshots (npm install playwright && npx playwright install chromium).");

const mailer = await createMailer();

// Settings saved on the "System" page rebuild AI and mail without a restart.
const handler = createApp({
  dataDir: path.resolve(here, process.env.DATA_DIR || "data"),
  ai,
  mailer,
  adminToken,
  screenshotter,
  env: process.env,
  factories: { ai: (sys) => createAi(envFrom(sys)), mailer: (sys) => createMailer(envFrom(sys)) },
});

http.createServer(handler).listen(port, host, () => {
  console.log(`Agentenwerk läuft auf http://${host === "0.0.0.0" ? "localhost" : host}:${port}`);
  console.log("Schlüssel, E-Mail, Abo und Telefon stellst du als Admin im Browser unter „System“ ein.");
});
