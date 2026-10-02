// "JARVIS": runs, sessions and usage pushed from the Mac, next to this
// server's own lead activity. Read-only; all text goes through textContent.
import { ago } from "./agents.js";

const RUN_LABEL = { queued: "Wartet", running: "Läuft", succeeded: "Fertig", failed: "Fehler", timed_out: "Zeitlimit", cancelled: "Abgebrochen" };
const RUN_CLASS = { running: "s-analyzing", succeeded: "s-done", failed: "s-failed", timed_out: "s-failed" };
const LEAD_LABEL = { demo_view: "Demo angesehen", demo_chat: "Chat in der Demo", demo_lead: "Kontakt hinterlassen", email_sent: "E-Mail gesendet", unsubscribed: "Abgemeldet" };

export function mountJarvis({ root, api, h, icon }) {
  let data = null;
  let fresh = null; // token shown once
  let message = null;
  let timer = null;

  async function load() {
    try { data = await api("GET", "/api/jarvis"); message = null; } catch (e) { message = e.message; }
    render();
    clearInterval(timer);
    timer = setInterval(async () => { try { data = await api("GET", "/api/jarvis"); render(); } catch { /* keep last view */ } }, 30000);
  }

  async function createToken() {
    if (data.connected && !confirm("Das bisherige Token wird ungültig. Fortfahren?")) return;
    try { fresh = await api("POST", "/api/jarvis/token", {}); await load(); } catch (e) { message = e.message; render(); }
  }
  async function disconnect() {
    if (!confirm("Verbindung trennen und empfangene JARVIS-Daten löschen?")) return;
    try { await api("DELETE", "/api/jarvis/token"); fresh = null; await load(); } catch (e) { message = e.message; render(); }
  }

  const copy = (text, btn) => navigator.clipboard?.writeText(text).then(() => { btn.textContent = "Kopiert"; });

  function stat(label, value, tone) {
    return h("div", { class: "stat" + (tone ? ` ${tone}` : "") }, h("strong", { text: String(value) }), h("span", { text: label }));
  }

  function connectCard() {
    const url = fresh?.ingestUrl || data.ingestUrl;
    const site = url.replace(/\/api\/public.*$/, "");
    const tok = fresh ? fresh.token : "<Token>";
    const cmd = `$env:AGENTENWERK_URL="${site}"; $env:AGENTENWERK_TOKEN="${tok}"; python scripts\\agentenwerk_sync.py`;
    const cmdMac = `AGENTENWERK_URL=${site} AGENTENWERK_TOKEN=${tok} python3 scripts/agentenwerk_sync.py`;
    const copyBtn = h("button", { type: "button", class: "btn", text: "Befehl kopieren" });
    copyBtn.addEventListener("click", () => copy(cmd, copyBtn));
    return h("section", { class: "panel" },
      h("h3", { text: data.connected ? "Verbindung" : "JARVIS verbinden" }),
      h("p", { class: "hint", text: "JARVIS bleibt auf deinem Mac. Ein kleines Skript auf deinem Rechner schickt alle 30 Sekunden den Stand hierher; dieser Server ruft nie bei dir an." }),
      fresh ? h("div", { class: "field" }, h("label", { text: "Dein Token (wird nur jetzt angezeigt)" }), h("input", { class: "input mono", readonly: "", value: fresh.token }),
        h("p", { class: "hint", text: "Windows (PowerShell, im JARVIS-Ordner):" }), h("pre", { class: "mono", text: cmd }), copyBtn, h("p", { class: "hint", text: "Mac/Linux:" }), h("pre", { class: "mono", text: cmdMac })) : null,
      h("div", { class: "toolbar" },
        h("button", { type: "button", class: "btn primary", onclick: createToken, text: data.connected ? "Neues Token" : "Token erzeugen" }),
        data.connected ? h("button", { type: "button", class: "btn ghost", onclick: disconnect, text: "Trennen" }) : null));
  }

  function sync() {
    if (!data.connected) return null;
    if (!data.receivedAt) return h("p", { class: "hint", text: "Noch keine Daten empfangen. Starte das Skript auf dem Mac." });
    return h("p", { class: "hint" + (data.stale ? " warn" : ""), text: data.stale ? `Letzte Daten ${ago(data.receivedAt)}. Läuft das Skript noch?` : `Zuletzt aktualisiert ${ago(data.receivedAt)}${data.snapshot.host ? ` von ${data.snapshot.host}` : ""}.` });
  }

  function render() {
    if (!data) { root.replaceChildren(h("p", { class: "hint", text: message || "Lädt …" })); return; }
    const snap = data.snapshot;
    const parts = [h("div", { class: "page-head" }, h("div", null, h("span", { class: "eyebrow", text: "Dein Rechner" }), h("h2", { text: "JARVIS" })))];
    if (message) parts.push(h("p", { class: "msg err", text: message }));
    parts.push(connectCard(), sync());
    if (snap) {
      const running = snap.runs.filter((r) => r.status === "running").length;
      const needs = snap.sessions.filter((s) => s.state === "needs_you");
      const failed = snap.runs.filter((r) => r.status === "failed" || r.status === "timed_out").length;
      parts.push(h("div", { class: "stats" }, stat("Läuft", running), stat("Braucht dich", needs.length, needs.length ? "hot" : ""), stat("Fehlgeschlagen", failed), stat("Sessions", snap.sessions.filter((s) => s.state !== "gone").length)));
      if (needs.length) parts.push(h("section", { class: "panel" }, h("h3", { text: "Braucht dich" }),
        h("ul", { class: "plain" }, needs.map((s) => h("li", null, h("strong", { text: s.project || s.title || "Session" }), h("span", { class: "meta", text: ` ${s.needs || s.summary}` }))))));
      const usage = snap.limits.windows.filter((w) => w.utilization != null);
      if (usage.length) parts.push(h("section", { class: "panel" }, h("h3", { text: "Abo-Auslastung" }),
        usage.map((w) => { const pct = Math.max(0, Math.min(100, Math.round(w.utilization <= 1 ? w.utilization * 100 : w.utilization))); const bar = h("div", { class: "bar" }, h("i")); bar.firstChild.style.width = `${pct}%`; return h("div", { class: "field" }, h("label", { text: `${w.label || w.key} · ${pct} %` }), bar); })));
      parts.push(h("section", { class: "panel" }, h("h3", { text: "Letzte Runs" }),
        snap.runs.length ? h("ul", { class: "plain" }, snap.runs.slice(0, 15).map((r) => h("li", null,
          h("span", { class: `pill ${RUN_CLASS[r.status] || ""}`, text: RUN_LABEL[r.status] || r.status }), " ",
          h("strong", { text: r.project || "Run" }), h("span", { class: "meta", text: ` ${r.prompt}` })))) : h("p", { class: "hint", text: "Keine Runs." })));
    }
    if (data.feed.length) parts.push(h("section", { class: "panel" }, h("h3", { text: "Gemeinsamer Verlauf" }),
      h("ul", { class: "plain" }, data.feed.map((f) => h("li", null,
        h("span", { class: "pill", text: f.kind === "run" ? "JARVIS" : "Akquise" }), " ",
        h("strong", { text: f.title }), h("span", { class: "meta", text: ` ${f.kind === "run" ? (RUN_LABEL[f.type] || f.type) : (LEAD_LABEL[f.type] || f.type)} · ${ago(f.at)}` }))))));
    root.replaceChildren(...parts.filter(Boolean));
  }

  return { show: load, hide() { clearInterval(timer); } };
}
