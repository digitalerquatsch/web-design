// Start page: greeting, the one next step that matters, numbers as cards,
// the path to the first customer, quick actions and recent agents.

import { agentCard } from "./agents.js";

export function mountHome({ root, api, h, icon, getStatus, go, onNew, onEdit }) {
  let data = null;
  const me = () => getStatus().me || {};
  const isKunde = () => me().role === "kunde";
  const num = (n) => Number(n || 0).toLocaleString("de-DE");

  async function load() {
    try { data = await api("GET", "/api/overview"); } catch (e) { data = null; root.replaceChildren(h("div", { class: "err-box", text: e.message })); return; }
    render();
  }

  function greeting() {
    const hr = new Date().getHours();
    const hello = hr < 11 ? "Guten Morgen" : hr < 18 ? "Guten Tag" : "Guten Abend";
    const first = String(me().name || "").split(/\s+/)[0];
    return first && !["Lokal", "Admin-Token"].includes(first) ? `${hello}, ${first}` : hello;
  }

  // The single most useful next step, from the current numbers.
  function nextStep() {
    const s = getStatus();
    const L = data.leads || {};
    if (isKunde()) {
      return data.agents
        ? { icon: "chat", title: "Teste deinen Agenten", text: "Stell im Testchat die Fragen, die deine Kunden stellen würden. Passt eine Antwort nicht, ergänze das Wissen oder die Regeln.", cta: "Agent öffnen", run: () => onEdit(data.recentAgents[0].id) }
        : { icon: "bot", title: "Noch kein Agent freigegeben", text: "Deine Agentur weist dir deinen Agenten zu. Danach kannst du ihn hier testen und anpassen." };
    }
    if (me().id === "local") return { icon: "shield", title: "Lege deinen Admin-Zugang an", text: "Noch gibt es kein Konto. Mit dem ersten Admin wird die Anmeldung Pflicht, und du kannst Nutzer freischalten.", cta: "Zugang anlegen", run: () => go("users") };
    if (!s.aiConfigured) return { icon: "spark", title: `${s.keyName} fehlt`, text: "Trage den Schlüssel in die .env des Servers ein und starte neu. Danach liest Agentenwerk Websites, chattet und schreibt E-Mails." };
    if (data.pendingUsers) return { icon: "users", title: `${data.pendingUsers} ${data.pendingUsers === 1 ? "Anfrage wartet" : "Anfragen warten"} auf Freischaltung`, text: "Prüfe, wer Zugang möchte, und gib die passende Rolle.", cta: "Anfragen ansehen", run: () => go("users") };
    if (!data.agents) return { icon: "rocket", title: "Bau deine erste Demo", text: "Der schnellste Weg zum ersten Kunden: Website eines echten Betriebs einlesen, der Agent ist in einer Minute fertig, dann den Demo-Link schicken.", cta: "Agent aus Website erstellen", run: onNew };
    if (!data.batches) return { icon: "upload", title: "Lass den Autopiloten ran", text: "Lade eine Liste mit Betrieben hoch. Für jeden entsteht ein Agent mit Demo-Seite auf dessen eigener Website.", cta: "Liste hochladen", run: () => go("autopilot") };
    if (L.total && !L.contacted) return L.drafts
      ? { icon: "send", title: `${L.drafts} E-Mail-Entwürfe warten`, text: "Lies sie kurz, passe sie an und sende sie mit einem Klick.", cta: "Entwürfe prüfen", run: () => go("acquisition") }
      : { icon: "send", title: "Schreib die ersten E-Mails", text: `${L.total} Demos sind fertig. Lass Mistral persönliche E-Mails mit Demo-Link schreiben.`, cta: "Zur Akquise", run: () => go("acquisition") };
    if (L.contacted && !L.viewed) return { icon: "eye", title: "Noch hat niemand die Demo geöffnet", text: "Das ist normal in den ersten Tagen. Ruf zwei, drei Betriebe kurz an und frag, ob die E-Mail angekommen ist.", cta: "Leads ansehen", run: () => go("acquisition") };
    if (L.viewed && !L.customers) return { icon: "trend", title: `${L.viewed} ${L.viewed === 1 ? "Betrieb hat" : "Betriebe haben"} die Demo geöffnet`, text: "Jetzt ist der beste Moment für einen Anruf. Die Demo ist frisch im Kopf.", cta: "Interessenten ansehen", run: () => go("acquisition") };
    return { icon: "check", title: `${L.customers} ${L.customers === 1 ? "Kunde" : "Kunden"} gewonnen`, text: "Stark. Die nächste Liste wartet: neue Branche, neue Stadt.", cta: "Neue Liste hochladen", run: () => go("autopilot") };
  }

  function stat(cls, ic, value, label) {
    return h("div", { class: `stat ${cls}` }, h("span", { class: "stat-ico" }, icon(ic, 20)), h("strong", { class: "stat-value", text: value }), h("span", { class: "stat-label", text: label }));
  }

  function journey() {
    const L = data.leads || {};
    const steps = [
      ["Erster Agent", data.agents > 0],
      ["Website eingelesen", data.imported > 0],
      ["Testchat geführt", data.testConversations > 0],
      ["Autopilot gestartet", data.batches > 0],
      ["Demo verschickt", L.contacted > 0],
      ["Demo geöffnet", L.viewed > 0],
      ["Erstes Gespräch", data.conversations > 0],
      ["Erster Kunde", L.customers > 0],
    ];
    const done = steps.filter((x) => x[1]).length;
    const nextIdx = steps.findIndex((x) => !x[1]);
    return h("section", { class: "panel journey" },
      h("div", { class: "journey-head" }, h("div", null, h("h3", { text: "Dein Weg zum ersten Kunden" }), h("p", { class: "hint", text: `${done} von ${steps.length} Stationen geschafft` })), h("strong", { class: "journey-pct", text: `${Math.round((done / steps.length) * 100)} %` })),
      h("div", { class: "pbar journey-bar", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": String(steps.length), "aria-valuenow": String(done) }, h("span", { class: "ok", style: `width:${(done / steps.length) * 100}%` })),
      h("ol", { class: "stations" }, steps.map(([label, ok], i) => h("li", { class: ok ? "done" : i === nextIdx ? "next" : "" },
        h("span", { class: "station-dot" }, ok ? icon("check", 16) : h("span", { text: String(i + 1) })), h("span", { class: "station-label", text: label })))));
  }

  function actions() {
    const row = (ic, title, sub, run) => h("button", { type: "button", class: "action-card", onclick: run },
      h("span", { class: "stat-ico" }, icon(ic, 20)), h("span", { class: "action-text" }, h("strong", { text: title }), h("span", { class: "meta", text: sub })), icon("arrow", 18));
    if (isKunde()) return null;
    return h("section", { class: "actions" },
      row("bot", "Agent erstellen", "aus Website oder Vorlage", onNew),
      row("upload", "Liste hochladen", "Autopilot baut Agenten und Demos", () => go("autopilot")),
      row("send", "Akquise", "E-Mails, Demo-Aufrufe, Pipeline", () => go("acquisition")),
      me().role === "admin" ? row("users", "Nutzer verwalten", data.pendingUsers ? `${data.pendingUsers} warten auf Freischaltung` : "freischalten, Rollen, Kunden", () => go("users")) : null);
  }

  function render() {
    const step = nextStep();
    const L = data.leads || {};
    root.replaceChildren(...[
      h("div", { class: "hello" },
        h("span", { class: "avatar lg", text: String(me().name || "A").split(/\s+/).map((x) => x[0]).join("").slice(0, 2).toUpperCase() }),
        h("div", null, h("h2", { class: "hello-title" }, h("span", { class: "hello-word", text: greeting() })), h("p", { class: "hint", text: isKunde() ? "Hier testest und pflegst du deinen Chat-Assistenten." : "Dein Überblick und der nächste Schritt zum nächsten Kunden." }))),
      h("section", { class: "panel next-step" },
        h("div", { class: "next-row" }, h("span", { class: "next-ico" }, icon(step.icon, 26)),
          h("div", null, h("span", { class: "eyebrow", text: "Nächster Schritt" }), h("h3", { text: step.title }), h("p", { text: step.text }))),
        step.cta ? h("button", { type: "button", class: "btn primary big wide", onclick: step.run }, step.cta, icon("arrow", 18)) : null),
      h("div", { class: "stats" },
        stat("tint-pink", "bot", num(data.agents), "KI-Agenten"),
        isKunde() ? stat("tint-violet", "chat", num(data.testConversations), "Testchats") : stat("tint-violet", "eye", `${num(L.viewed)} / ${num(L.contacted)}`, "Demos geöffnet / verschickt"),
        stat("tint-green", "chat", num(data.conversations), "Gespräche"),
        stat("tint-amber", "trend", num(data.captured), "Leads aus Chats")),
      isKunde() ? null : journey(),
      actions(),
      data.recentAgents.length ? h("div", { class: "page-head" }, h("h3", { text: "Zuletzt bearbeitet" }), h("button", { type: "button", class: "linkish", text: "Alle Agenten ansehen", onclick: () => go("agents") })) : null,
      data.recentAgents.length ? h("div", { class: "agent-grid" }, data.recentAgents.slice(0, 3).map((a) => agentCard({ h, icon, a, status: getStatus(), onEdit }))) : null,
    ].filter(Boolean));
  }

  return { show: load, hide() {} };
}
