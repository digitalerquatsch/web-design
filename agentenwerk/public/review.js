// Review mode: go through leads one by one. Live demo of the agent on the
// company's site, quick design tweaks, the e-mail as it will arrive, then
// send or skip and move on.

export function mountReview({ root, api, h, icon, getStatus, onExit, openAgent }) {
  let ids = [];
  let index = 0;
  let title = "Akquise";
  let lead = null, agent = null, mail = null, settings = null;
  let info = null;        // { kind, text }
  let busy = "";          // "", "draft", "send", "test", "save"
  let frameKey = Date.now();
  let editEmail = false;

  async function open({ leadIds, start = 0, label = "Akquise" }) {
    ids = leadIds; index = Math.max(0, Math.min(start, ids.length - 1)); title = label;
    settings = await api("GET", "/api/settings").catch(() => null);
    await loadCurrent();
  }

  async function loadCurrent(autoDraft = true) {
    info = null; mail = null; editEmail = false;
    if (!ids.length) { lead = null; render(); return; }
    try {
      lead = await api("GET", `/api/leads/${ids[index]}`);
      agent = await api("GET", `/api/agents/${lead.agentId}`);
    } catch (e) { info = { kind: "err", text: e.message }; lead = null; render(); return; }
    frameKey = Date.now();
    render();
    // Autopilot: write the e-mail as soon as a fresh lead is opened.
    if (autoDraft && !lead.draft && !lead.sent.length && !["abgemeldet", "kein_interesse"].includes(lead.stage) && getStatus().aiConfigured) await draft();
    else await loadMail();
  }

  async function loadMail() {
    if (!lead?.draft) { mail = null; render(); return; }
    try { mail = await api("GET", `/api/leads/${lead.id}/preview-email`); } catch { mail = null; }
    render();
  }

  async function run(kind, fn, ok) {
    busy = kind; info = null; render();
    try { const r = await fn(); if (ok) info = { kind: "ok", text: typeof ok === "function" ? ok(r) : ok }; } catch (e) { info = { kind: "err", text: e.message }; }
    busy = ""; render();
  }
  const draft = () => run("draft", async () => { lead = await api("POST", `/api/leads/${lead.id}/draft`, { kind: lead.sent.length ? "followup" : "first" }); await loadMail(); });

  function go(delta) { const n = index + delta; if (n < 0 || n >= ids.length) return; index = n; loadCurrent(); }

  async function saveLook(patch) {
    await run("save", async () => {
      agent = await api("PUT", `/api/agents/${agent.id}`, { ...agent, ...patch });
      frameKey = Date.now();
      await loadMail();
    }, "Übernommen.");
  }

  async function saveDraft() {
    const s = document.getElementById("rvSubject"), b = document.getElementById("rvBody");
    if (!s || !b) return;
    lead = await api("PATCH", `/api/leads/${lead.id}`, { draft: { subject: s.value, body: b.value } });
  }

  function host(url) { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; } }

  function topBar(status) {
    return h("div", { class: "rv-top" },
      h("button", { type: "button", class: "rv-back", onclick: onExit }, h("span", { text: "‹" }), h("span", { text: title })),
      h("span", { class: "rv-count" }, "Betrieb ", h("b", { text: String(index + 1) }), ` von ${ids.length}`),
      status ? h("span", { class: "rv-sent" }, "Heute versendet ", h("b", { text: String(status.sentToday) }), ` von ${status.dailyLimit}`) : null,
      h("div", { class: "pbar rv-bar" }, h("span", { class: "ok", style: `width:${((index + 1) / Math.max(1, ids.length)) * 100}%` })));
  }

  function browserCard() {
    const d = host(lead.url);
    return h("section", { class: "browser" },
      h("div", { class: "browser-bar" }, h("span", { class: "dots" }, h("i"), h("i"), h("i")), h("span", { class: "browser-url", text: d }),
        h("a", { href: `/d/${lead.agentId}?intern=1`, target: "_blank", rel: "noopener", class: "browser-open" }, "Öffnen", icon("external", 15))),
      h("iframe", { class: "browser-frame", title: `Demo für ${lead.company}`, src: `/d/${lead.agentId}?intern=1&embed=1&open=1&v=${frameKey}`, loading: "lazy" }));
  }

  function leadCard() {
    const emailRow = editEmail
      ? (() => {
        const inp = h("input", { class: "input", id: "rvEmail", type: "email", value: lead.email || "", placeholder: "name@firma.de" });
        const save = () => run("save", async () => { lead = await api("PATCH", `/api/leads/${lead.id}`, { email: inp.value }); editEmail = false; }, "E-Mail-Adresse gespeichert.");
        inp.addEventListener("keydown", (e) => { if (e.key === "Enter") save(); });
        setTimeout(() => inp.focus(), 0);
        return h("div", { class: "toolbar" }, inp, h("button", { type: "button", class: "btn", text: "Speichern", onclick: save }));
      })()
      : h("div", { class: "rv-email" }, h("span", { class: lead.email ? "" : "rv-missing", text: lead.email || "Keine E-Mail-Adresse" }),
        h("button", { type: "button", class: "icon-btn sm", "aria-label": "E-Mail-Adresse bearbeiten", onclick: () => { editEmail = true; render(); } }, icon("edit", 16)));
    return h("section", { class: "panel rv-lead" },
      h("div", { class: "rv-lead-top" }, h("h2", { text: lead.company || host(lead.url) }), h("span", { class: "pill st-" + lead.stage, text: getStatus().stagesLabel?.[lead.stage] || lead.stage })),
      lead.contact ? h("p", { class: "meta", text: lead.contact }) : null,
      emailRow,
      lead.sent.length ? h("p", { class: "hint", text: `Zuletzt gesendet ${new Date(lead.sent.at(-1).at).toLocaleString("de-DE", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}. ${lead.sent.length > 1 ? `${lead.sent.length} E-Mails insgesamt.` : ""}` }) : null,
      lead.skipped ? h("p", { class: "hint", text: "Übersprungen. Du kannst trotzdem senden." }) : null);
  }

  function outCard() {
    const color = h("input", { type: "color", id: "rvColor", value: agent.color || "#3a46c9", "aria-label": "Farbe des Chats" });
    color.addEventListener("change", () => saveLook({ color: color.value }));
    const theme = h("div", { class: "seg", role: "group", "aria-label": "Darstellung" },
      ["light", "dark"].map((t) => h("button", { type: "button", "aria-pressed": String((agent.widgetTheme || "light") === t), onclick: () => saveLook({ widgetTheme: t }) }, t === "light" ? "Hell" : "Dunkel")));
    const welcome = h("input", { class: "input", id: "rvWelcome", value: agent.welcome || "", "aria-label": "Begrüßung" });
    const apply = h("button", { type: "button", class: "btn primary", text: "Übernehmen", disabled: busy === "save" || null, onclick: () => saveLook({ welcome: welcome.value }) });

    const mailBox = h("div", { class: "fields", style: "gap:10px" });
    if (busy === "draft") mailBox.append(h("div", { class: "note", text: "Mistral schreibt die E-Mail …" }));
    else if (!lead.draft) mailBox.append(h("button", { type: "button", class: "btn", disabled: !getStatus().aiConfigured || null, onclick: draft }, icon("spark", 16), lead.sent.length ? "Nachfass-E-Mail schreiben" : "E-Mail schreiben lassen"));
    else {
      const subj = h("input", { class: "input", id: "rvSubject", value: lead.draft.subject });
      const body = h("textarea", { class: "textarea", id: "rvBody", rows: 9 });
      body.value = lead.draft.body;
      const refresh = async () => { await saveDraft(); await loadMail(); };
      subj.addEventListener("change", refresh);
      body.addEventListener("change", refresh);
      mailBox.append(
        h("div", { class: "field" }, h("label", { for: "rvSubject", text: "Betreff" }), subj),
        h("details", { class: "rv-text" }, h("summary", { text: "Text bearbeiten" }), h("p", { class: "hint", text: "{{DEMO_LINK}} wird zum Beispiel-Chat mit Button. Signatur, Anschrift und Abmeldelink kommen automatisch dazu." }), body,
          h("button", { type: "button", class: "btn ghost", text: "Neu schreiben lassen", onclick: draft })),
        mail ? h("iframe", { class: "mail-frame", title: "So kommt die E-Mail an", sandbox: "", srcdoc: mail.html }) : null);
    }

    return h("section", { class: "panel rv-out" },
      h("h3", { text: "Das geht raus" }),
      h("p", { class: "hint", text: "Eine kurze E-Mail mit einem Beispiel-Chat in den Farben des Betriebs, dem Link zur Demo und deiner Signatur. Der Empfänger sieht sofort, was der Assistent kann, auch ohne zu klicken." }),
      h("div", { class: "rv-look" },
        h("div", { class: "rv-look-row" }, h("label", { for: "rvColor", class: "lbl", text: "Farbe" }), color, theme),
        h("div", { class: "rv-look-row" }, welcome, apply)),
      h("button", { type: "button", class: "linkish", text: "Mehr anpassen im Editor", onclick: () => openAgent(agent.id) }),
      mailBox,
      h("div", { class: "rv-divider" }),
      h("button", { type: "button", class: "btn", disabled: !lead.draft || busy === "test" || !getStatus().mailConfigured || null, title: getStatus().mailConfigured ? "" : "SMTP ist nicht eingerichtet",
        onclick: () => run("test", async () => { await saveDraft(); return api("POST", `/api/leads/${lead.id}/test-send`); }, (r) => `Vorschau an ${r.to} gesendet.`) }, icon("eye", 16), "Vorschau an mich"));
  }

  function actions() {
    const canSend = lead.draft && lead.email && getStatus().mailConfigured && !["abgemeldet", "kein_interesse"].includes(lead.stage);
    return h("div", { class: "rv-actions" },
      h("div", { class: "rv-actions-main" },
        h("button", { type: "button", class: "btn primary big", disabled: !canSend || busy === "send" || null,
          title: !getStatus().mailConfigured ? "SMTP ist nicht eingerichtet" : !lead.email ? "Keine E-Mail-Adresse" : !lead.draft ? "Noch kein Entwurf" : "",
          onclick: () => run("send", async () => {
            await saveDraft();
            await api("POST", `/api/leads/${lead.id}/send`);
            if (index < ids.length - 1) { index++; await loadCurrent(); info = { kind: "ok", text: "Gesendet. Weiter mit dem nächsten Betrieb." }; }
            else { lead = await api("GET", `/api/leads/${lead.id}`); info = { kind: "ok", text: "Gesendet. Das war der letzte Betrieb in dieser Liste." }; }
          }) }, icon("send", 18), busy === "send" ? "Sendet …" : "Senden"),
        h("button", { type: "button", class: "btn big", onclick: () => run("save", async () => { await api("POST", `/api/leads/${lead.id}/skip`); if (index < ids.length - 1) { index++; await loadCurrent(); } }) }, "Überspringen")),
      h("div", { class: "rv-actions-nav" },
        h("button", { type: "button", class: "btn ghost", disabled: index === 0 || null, onclick: () => go(-1) }, "← Zurück"),
        h("button", { type: "button", class: "btn ghost", disabled: index >= ids.length - 1 || null, onclick: () => go(1) }, "Weiter →")));
  }

  let mailStatus = null;
  let renderedKey = "";
  let slots = null;
  // The demo iframe reloads whenever it is (re)inserted, so it is only rebuilt
  // when the lead or the agent's look changes; everything else updates around it.
  function render() {
    if (!lead) {
      renderedKey = "";
      root.replaceChildren(topBar(null), info ? h("div", { class: "err-box", text: info.text }) : h("div", { class: "panel empty" }, h("strong", { text: "Keine Betriebe zum Durchgehen" }), "Wähle in der Akquise oder im Autopiloten eine Liste."));
      return;
    }
    const key = `${lead.id}:${frameKey}`;
    if (key !== renderedKey || !slots) {
      renderedKey = key;
      slots = { top: h("div"), info: h("div"), right: h("div", { class: "rv-col" }) };
      root.replaceChildren(slots.top, slots.info, h("div", { class: "rv-grid" }, h("div", { class: "rv-col rv-sticky" }, browserCard()), slots.right));
    }
    slots.top.replaceChildren(topBar(mailStatus));
    slots.info.replaceChildren(...(info ? [h("div", { class: info.kind === "err" ? "err-box" : "ok-box", role: "status", text: info.text })] : []));
    slots.right.replaceChildren(leadCard(), outCard(), actions());
    if (!mailStatus || busy === "") refreshMailStatus();
  }
  let statusPending = false;
  function refreshMailStatus() {
    if (statusPending) return;
    statusPending = true;
    api("GET", "/api/acquisition").then((a) => {
      const changed = !mailStatus || mailStatus.sentToday !== a.mail.sentToday || getStatus().mailConfigured !== a.mail.configured;
      mailStatus = a.mail;
      getStatus().mailConfigured = a.mail.configured;
      getStatus().stagesLabel = a.stages;
      statusPending = false;
      if (changed) render();
    }).catch(() => { statusPending = false; });
  }

  return { open, show() { renderedKey = ""; render(); }, hide() {} };
}
