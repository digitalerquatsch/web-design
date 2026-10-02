// Takes the website screenshot behind each demo. Optional: needs the
// `playwright` package and a Chromium (npx playwright install chromium).
// Without them the demo shows a generated page in the company's colors.

import { assertPublicHost } from "./crawl.js";

const VIEW = { width: 1366, height: 900 };
const MAX_HEIGHT = 3200;

// Cookie banners would cover the demo; hide the common consent tools.
const HIDE_BANNERS = `
#usercentrics-root, #usercentrics-cmp-ui, #CybotCookiebotDialog, #CybotCookiebotDialogBodyUnderlay, #onetrust-consent-sdk,
#borlabs-cookie, #BorlabsCookieBox, .cmplz-cookiebanner, .cc-window, .cc-banner, #cookie-notice, #cookie-law-info-bar,
.cookie-notice-container, #moove_gdpr_cookie_info_bar, .klaro, #klaro, [id*="cookie-banner" i], [class*="cookie-banner" i],
[id*="cookieconsent" i], [class*="cookieconsent" i], #cmpbox, #cmpbox2, .cmpboxBG, #sp_message_container, .fc-consent-root
{ display: none !important; visibility: hidden !important; }
html, body { overflow: visible !important; }`;

export async function createScreenshotter({ guard = (host) => assertPublicHost(host), executablePath = process.env.CHROMIUM_PATH || undefined } = {}) {
  let pw;
  try { pw = await import("playwright"); } catch { return null; }
  let browserP = null;
  const getBrowser = () => (browserP ||= pw.chromium.launch({ executablePath, args: ["--disable-dev-shm-usage"] }).catch((e) => { browserP = null; throw e; }));

  return {
    async capture(url) {
      const browser = await getBrowser();
      const context = await browser.newContext({ viewport: VIEW, locale: "de-DE", deviceScaleFactor: 1, javaScriptEnabled: true, serviceWorkers: "block" });
      const allowed = new Map();
      // Every request the page makes is checked, so a site cannot point the
      // browser at the server's own network.
      await context.route("**/*", async (route) => {
        let u;
        try { u = new URL(route.request().url()); } catch { return route.abort(); }
        if (u.protocol === "data:" || u.protocol === "blob:") return route.continue();
        if (u.protocol !== "http:" && u.protocol !== "https:") return route.abort();
        if (!allowed.has(u.hostname)) allowed.set(u.hostname, guard(u.hostname).then(() => true, () => false));
        return (await allowed.get(u.hostname)) ? route.continue() : route.abort();
      });
      try {
        const page = await context.newPage();
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 });
        await page.waitForLoadState("load", { timeout: 8000 }).catch(() => {});
        await page.addStyleTag({ content: HIDE_BANNERS }).catch(() => {});
        // Trigger lazy images, then return to the top.
        await page.evaluate(async () => {
          for (let y = 0; y < 3000; y += 700) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 120)); }
          window.scrollTo(0, 0);
        }).catch(() => {});
        await page.waitForTimeout(600);
        const height = Math.min(MAX_HEIGHT, Math.max(VIEW.height, await page.evaluate(() => document.documentElement.scrollHeight).catch(() => VIEW.height)));
        return await page.screenshot({ type: "jpeg", quality: 72, fullPage: true, clip: { x: 0, y: 0, width: VIEW.width, height } });
      } finally {
        await context.close().catch(() => {});
      }
    },
    async close() {
      if (browserP) (await browserP.catch(() => null))?.close();
    },
  };
}
