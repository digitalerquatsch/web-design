// Acquisition dashboard: leads from the autopilot, e-mail drafts written by
// the AI, one-click sending, demo views and chats as signals.
// Rendered with createElement/textContent only.

const EVENT_LABELS = {
  created: "Lead angelegt",
  draft: "E-Mail-Entwurf erstellt",
  email_sent: "E-Mail gesendet",
  demo_view: "Demo angesehen",
  demo_chat: "Chat in der Demo gestartet",
  demo_lead: "Hat in der Demo Kontaktdaten hinterlassen",
  unsubscribed: "Hat sich abgemeldet",
  stage: "Status geändert",
  error: "Fehler",
};

export function mountAcquisition({ root, api, h, getStatus, openAgent, onReview }) {
  let data = null;          // /api/acquisition
  let leads = [];
  let settings = null;
  let filter = "alle";
  let query = "";
  let selected = new Set();
  let openId = null;
  let panel = "lead";       // lead | settings
  let preview = null;       // composed e-mail for the open lead
  let confirm = null;       // "send-one" | "send-bulk"
  let message = null;       // { kind: "err"|"ok", text }
  let timer = null;

  const stages = () => data?.stages || {};
  const lead = () => leads.find((l) => l.id === openId) || null;
  const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
  const num = (n) => Number(n || 0).toLocaleString("de-DE");
  function ago(t) {
    const m = Math.round((Date.now() - t) / 60000);
    if (m < 1) return "gerade eben";
    if (m < 60) return `vor ${m} Min.`;
    const hrs = Math.round(m / 60);
    if (hrs < 24) return `vor ${hrs} Std.`;
    const d = Math.round(hrs / 24);
    if (d < 8) return `vor ${d} ${d === 1 ? "Tag" : "Tagen"}`;
    return new Date(t).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });
  }
  const lastActivity = (l) => l.events[l.events.length - 1]?.at || l.updatedAt;
  const count = (l, type) => l.events.filter((e) => e.type === type).length;

  // Polling must not wipe what the user is typing.
  function editing() {
    const a = document.activeElement;
    return panel === "settings" || (a && root.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && a.type !== "checkbox");
  }
  async function load(force = true) {
    try {
      [data, leads] = await Promise.all([api("GET", "/api/acquisition"), api("GET", "/api/leads")]);
      if (!settings) settings = await api("GET", "/api/settings");
    } catch (e) {
      message = { kind: "err", text: e.message };
    }
    selected = new Set([...selected].filter((id) => leads.some((l) => l.id === id)));
    if (force || !editing()) render();
    schedule();
  }
  function schedule() {
    clearTimeout(timer);
    if (root.hidden) return;
    timer = setTimeout(() => load(false), data?.tasks?.length ? 2500 : 15000);
  }
  async function act(fn, ok) {
    message = null;
    try { await fn(); if (ok) message = { kind: "ok", text: ok }; } catch (e) { message = { kind: "err", text: e.message }; }
    confirm = null;
    await load();
  }

  function visibleLeads() {
    const q = query.trim().toLowerCase();
    return leads.filter((l) => {
      if (filter === "followup" && !l.followUpDue) return false;
      if (filter === "noemail" && l.email) return false;
      if (!["alle", "followup", "noemail"].includes(filter) && l.stage !== filter) return false;
      if (q && ![l.company, l.contact, l.email, l.url, l.city].join(" ").toLowerCase().includes(q)) return false;
      return true;
    });
  }

  /* ---------- summary ---------- */
  function tile(label, value, sub) {
    return h("div", { class: "kpi" }, h("span", { class: "kpi-label", text: label }), h("strong", { class: "kpi-value", text: value }), sub ? h("span", { class: "kpi-sub", text: sub }) : null);
  }
  function kpis() {
    const s = data.summary;
    return h("div", { class: "kpis" },
      tile("Leads", num(s.total), `${num(s.counts.neu + s.counts.entwurf)} noch nicht kontaktiert`),
      tile("Kontaktiert", num(s.contacted), data.mail.configured ? `heute ${num(data.mail.sentToday)} von ${num(data.mail.dailyLimit)} gesendet` : "Versand nicht eingerichtet"),
      tile("Demo angesehen", num(s.viewedLeads), s.contacted ? `${pct(s.viewedLeads, s.contacted)} % der Kontaktierten` : `${num(s.views)} Aufrufe gesamt`),
      tile("Chats in Demos", num(s.chats), "Gespräche von Interessenten"),
      tile("Interessiert", num(s.counts.interessiert), "von dir markiert"),
      tile("Kunden", num(s.counts.kunde), s.contacted ? `${pct(s.counts.kunde, s.contacted)} % Abschlussquote` : null));
  }
  function funnel() {
    const s = data.summary;
    const max = Math.max(1, s.total);
    const rows = data.funnel.map((st) => {
      const v = s.reached[st];
      const tip = `${stages()[st]}: ${num(v)} Leads · ${pct(v, s.total)} % aller Leads`;
      return h("button", { type: "button", class: "fun-row", title: tip, "aria-label": tip, onclick: () => { filter = st; render(); } },
        h("span", { class: "fun-label", text: stages()[st] }),
        h("span", { class: "fun-track" }, h("span", { class: "fun-bar", style: `width:${Math.max(v ? 2 : 0, (v / max) * 100)}%` })),
        h("span", { class: "fun-val", text: num(v) }),
        h("span", { class: "fun-tip", text: tip }));
    });
    return h("section", { class: "panel aq-card" },
      h("div", { class: "aq-card-head" }, h("h3", { text: "Pipeline" }), h("span", { class: "meta", text: "erreichte Stufe, kumuliert" })),
      h("div", { class: "fun" }, rows),
      h("p", { class: "hint", text: `Kein Interesse: ${num(s.counts.kein_interesse)} · Abgemeldet: ${num(s.counts.abgemeldet)}` }));
  }
  function todo() {
    const s = data.summary;
    const noEmail = leads.filter((l) => !l.email).length;
    const item = (label, n, f, hint) => h("button", { type: "button", class: "todo", disabled: !n || null, onclick: () => { filter = f; render(); } },
      h("strong", { text: num(n) }), h("span", null, h("b", { text: label }), h("span", { class: "meta", text: hint })));
    const feed = h("ul", { class: "feed" }, s.recent.length ? s.recent.slice(0, 8).map((e) => h("li", null,
      h("button", { type: "button", class: "linkish", text: e.company || "Lead", onclick: () => { openId = e.leadId; panel = "lead"; preview = null; render(); } }),
      " ", EVENT_LABELS[e.type] || e.type, h("span", { class: "meta", text: " · " + ago(e.at) }))) : h("li", { class: "meta", text: "Noch keine Aktivität. Sobald jemand eine Demo öffnet, steht es hier." }));
    return h("section", { class: "panel aq-card" },
      h("div", { class: "aq-card-head" }, h("h3", { text: "Heute zu tun" })),
      h("div", { class: "todos" },
        item("Entwürfe prüfen", s.drafts, "entwurf", "lesen, anpassen, senden"),
        item("Nachfassen fällig", s.followUps.length, "followup", `nach ${settings?.followUpDays || 0} Tagen ohne Antwort`),
        item("Ohne E-Mail-Adresse", noEmail, "noemail", "Adresse ergänzen oder anrufen")),
      h("h4", { class: "cap-section", text: "Letzte Aktivität" }), feed);
  }

  /* ---------- list ---------- */
  function listCard() {
    const vis = visibleLeads();
    const s = data.summary;
    const chip = (key, label, n) => h("button", { type: "button", class: "chip", "aria-pressed": String(filter === key), onclick: () => { filter = key; render(); } }, label, n != null ? h("span", { class: "count", text: num(n) }) : null);
    const chips = h("div", { class: "chips" },
      chip("alle", "Alle", s.total),
      Object.keys(stages()).filter((k) => s.counts[k]).map((k) => chip(k, stages()[k], s.counts[k])),
      s.followUps.length ? chip("followup", "Nachfassen", s.followUps.length) : null);
    const search = h("input", { class: "input", id: "aqSearch", type: "search", placeholder: "Firma, Ort, E-Mail suchen", value: query });
    search.addEventListener("input", () => { query = search.value; renderList(); });

    const allOn = vis.length > 0 && vis.every((l) => selected.has(l.id));
    const all = h("input", { type: "checkbox", "aria-label": "Alle sichtbaren auswählen" });
    all.checked = allOn;
    all.addEventListener("change", () => { vis.forEach((l) => (all.checked ? selected.add(l.id) : selected.delete(l.id))); render(); });

    const sel = [...selected];
    const bulk = sel.length ? h("div", { class: "bulk" },
      h("span", { text: `${sel.length} ausgewählt` }),
      h("button", { type: "button", class: "btn", text: "E-Mails schreiben", onclick: () => act(() => api("POST", "/api/leads/bulk", { action: "draft", ids: sel }), `Mistral schreibt ${sel.length} Entwürfe. Das dauert etwa ${Math.ceil(sel.length / 2) * 10} Sekunden.`) }),
      confirm === "send-bulk"
        ? h("span", { class: "confirm" }, h("span", { text: `${sel.filter((id) => leads.find((l) => l.id === id)?.draft).length} E-Mails mit Entwurf jetzt senden?` }),
          h("button", { type: "button", class: "btn primary", text: "Ja, senden", onclick: () => act(() => api("POST", "/api/leads/bulk", { action: "send", ids: sel.filter((id) => leads.find((l) => l.id === id)?.draft) }), "Versand gestartet.") }),
          h("button", { type: "button", class: "btn ghost", text: "Abbrechen", onclick: () => { confirm = null; render(); } }))
        : h("button", { type: "button", class: "btn primary", text: "Senden", disabled: !data.mail.configured || null, title: data.mail.configured ? "" : "SMTP ist nicht eingerichtet", onclick: () => { confirm = "send-bulk"; render(); } }),
      stageSelect("", (v) => act(() => api("POST", "/api/leads/bulk", { action: "stage", stage: v, ids: sel })), "Status setzen …"),
      h("button", { type: "button", class: "btn ghost", text: "Auswahl aufheben", onclick: () => { selected.clear(); render(); } })) : null;

    return h("section", { class: "panel aq-card aq-list" },
      h("div", { class: "aq-card-head" }, h("h3", { text: "Leads" }), h("div", { class: "toolbar" }, search,
        vis.length ? h("button", { type: "button", class: "btn primary", text: `Einzeln durchgehen (${vis.length})`, onclick: () => onReview({ leadIds: vis.map((l) => l.id), start: Math.max(0, vis.findIndex((l) => l.id === openId)), label: filter === "alle" ? "Alle Leads" : (stages()[filter] || "Auswahl") }) }) : null)),
      chips, bulk,
      h("div", { class: "lead-head" }, all, h("span", { text: "Firma" }), h("span", { text: "Status" }), h("span", { text: "Signale" }), h("span", { text: "Zuletzt" })),
      h("div", { id: "aqRows" }, rowsFor(vis)));
  }
  function rowsFor(vis) {
    if (!leads.length) return [h("div", { class: "empty" }, h("strong", { text: "Noch keine Leads" }), "Starte im Autopiloten einen Durchlauf. Jede fertige Website landet hier als Lead mit Demo-Link.")];
    if (!vis.length) return [h("div", { class: "empty" }, h("strong", { text: "Nichts gefunden" }), "Ändere den Filter oder die Suche.")];
    return vis.map((l) => {
      const cb = h("input", { type: "checkbox", "aria-label": `${l.company} auswählen` });
      cb.checked = selected.has(l.id);
      cb.addEventListener("click", (e) => e.stopPropagation());
      cb.addEventListener("change", () => { cb.checked ? selected.add(l.id) : selected.delete(l.id); render(); });
      const views = count(l, "demo_view"), chats = count(l, "demo_chat");
      const row = h("div", { class: "lead-row", role: "button", tabindex: "0", "aria-current": l.id === openId ? "true" : null },
        cb,
        h("span", { class: "lead-who" }, h("strong", { text: l.company || l.url }), h("span", { class: "meta", text: [l.contact, l.email || "keine E-Mail", l.city].filter(Boolean).join(" · ") })),
        h("span", null, h("span", { class: "pill st-" + l.stage, text: stages()[l.stage] }), l.followUpDue ? h("span", { class: "pill st-due", text: "Nachfassen" }) : null, l.busy ? h("span", { class: "meta", text: " arbeitet …" }) : null),
        h("span", { class: "meta", text: [views ? `${views}× angesehen` : "", chats ? `${chats} Chat${chats > 1 ? "s" : ""}` : "", l.sent.length ? `${l.sent.length} gesendet` : ""].filter(Boolean).join(" · ") || "–" }),
        h("span", { class: "meta", text: ago(lastActivity(l)) }));
      const open = () => { openId = l.id; panel = "lead"; preview = null; confirm = null; render(); if (window.matchMedia("(max-width: 1100px)").matches) document.getElementById("aqPanel")?.scrollIntoView({ block: "start" }); };
      row.addEventListener("click", open);
      row.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
      return row;
    });
  }
  function renderList() {
    const el = document.getElementById("aqRows");
    if (el) el.replaceChildren(...rowsFor(visibleLeads()));
  }
  function stageSelect(value, onChange, placeholder) {
    const s = h("select", { class: "input select" });
    if (placeholder) s.append(h("option", { value: "", text: placeholder }));
    for (const [k, v] of Object.entries(stages())) s.append(h("option", { value: k, text: v }));
    s.value = value;
    s.addEventListener("change", () => { if (s.value) onChange(s.value); });
    return s;
  }

  /* ---------- detail panel ---------- */
  function leadPanel() {
    const l = lead();
    if (!l) return h("div", { class: "empty" }, h("strong", { text: "Lead auswählen" }), "Klicke links auf eine Firma. Hier schreibst und sendest du die E-Mail und siehst, was der Interessent mit der Demo gemacht hat.");
    const base = (data.publicUrl || location.origin).replace(/\/$/, "");
    const patch = (body) => act(() => api("PATCH", `/api/leads/${l.id}`, body));
    const field = (label, key, type = "text") => {
      const i = h("input", { class: "input", type, value: l[key] || "", id: `aq_${key}` });
      i.addEventListener("change", () => patch({ [key]: i.value }));
      return h("div", { class: "field" }, h("label", { for: `aq_${key}`, text: label }), i);
    };

    const email = h("div", { class: "fields", style: "gap:10px" });
    if (l.draft) {
      const subj = h("input", { class: "input", id: "aqSubject", value: l.draft.subject });
      const body = h("textarea", { class: "textarea", id: "aqBody", rows: 12 });
      body.value = l.draft.body;
      const save = () => api("PATCH", `/api/leads/${l.id}`, { draft: { subject: subj.value, body: body.value } });
      // Keep edits even if the user clicks away without pressing Speichern.
      subj.addEventListener("change", () => save().catch(() => {}));
      body.addEventListener("change", () => save().catch(() => {}));
      email.append(
        h("div", { class: "field" }, h("label", { for: "aqSubject", text: "Betreff" }), subj),
        h("div", { class: "field" }, h("label", { for: "aqBody", text: l.draft.kind === "followup" ? "Nachfass-E-Mail" : "Erste E-Mail" }), h("p", { class: "hint", text: "{{DEMO_LINK}} wird beim Senden durch den Demo-Link ersetzt. Signatur, Anschrift und Abmeldelink kommen automatisch dazu." }), body),
        h("div", { class: "toolbar" },
          h("button", { type: "button", class: "btn", text: "Speichern", onclick: () => act(save, "Gespeichert.") }),
          h("button", { type: "button", class: "btn", text: "Vorschau", onclick: async () => { await save(); try { preview = await api("GET", `/api/leads/${l.id}/preview-email`); } catch (e) { message = { kind: "err", text: e.message }; } render(); } }),
          h("button", { type: "button", class: "btn ghost", text: "Neu schreiben", disabled: l.busy || null, onclick: () => act(() => api("POST", `/api/leads/${l.id}/draft`, { kind: l.draft.kind }), "Neuer Entwurf erstellt.") })),
        preview ? h("div", { class: "mail-preview" }, h("div", { class: "meta", text: `An: ${l.email || "(keine Adresse)"} · Betreff: ${preview.subject}` }), h("pre", { text: preview.text }),
          h("div", { class: "toolbar" }, copyBtn("Text kopieren", () => preview.text))) : null,
        confirm === "send-one"
          ? h("div", { class: "confirm" }, h("span", { text: `Jetzt an ${l.email} senden?` }),
            h("button", { type: "button", class: "btn primary", text: "Ja, senden", onclick: async () => { await save(); await act(() => api("POST", `/api/leads/${l.id}/send`), `E-Mail an ${l.email} gesendet.`); preview = null; } }),
            h("button", { type: "button", class: "btn ghost", text: "Abbrechen", onclick: () => { confirm = null; render(); } }))
          : h("button", { type: "button", class: "btn primary big", text: "Senden", disabled: !data.mail.configured || !l.email || l.busy || null,
            title: !data.mail.configured ? "SMTP ist nicht eingerichtet" : !l.email ? "Keine E-Mail-Adresse" : "", onclick: () => { confirm = "send-one"; render(); } }));
    } else {
      email.append(h("p", { class: "hint", text: l.sent.length ? "Die letzte E-Mail ist raus. Wenn keine Antwort kommt, schreibe eine kurze Nachfass-E-Mail." : "Mistral schreibt eine kurze, persönliche E-Mail mit Bezug auf die Website und dem Demo-Link." }),
        h("div", { class: "toolbar" },
          h("button", { type: "button", class: "btn primary", text: l.busy ? "Schreibt …" : l.sent.length ? "Nachfass-E-Mail schreiben" : "E-Mail schreiben", disabled: l.busy || ["abgemeldet", "kein_interesse"].includes(l.stage) || null,
            onclick: () => act(() => api("POST", `/api/leads/${l.id}/draft`, { kind: l.sent.length ? "followup" : "first" }), "Entwurf erstellt.") })));
    }

    const notes = h("textarea", { class: "textarea", id: "aqNotes", rows: 3, placeholder: "z. B. Rückruf am Donnerstag, will Preise wissen" });
    notes.value = l.notes || "";
    notes.addEventListener("change", () => patch({ notes: notes.value }));

    const timeline = h("ol", { class: "timeline" }, [...l.events].reverse().slice(0, 30).map((e) => h("li", { class: "ev-" + e.type },
      h("span", { text: e.type === "stage" ? `Status: ${stages()[e.stage] || e.stage}` : e.type === "error" ? `Fehler: ${e.message}` : e.type === "email_sent" && e.kind === "followup" ? "Nachfass-E-Mail gesendet" : (EVENT_LABELS[e.type] || e.type) }),
      h("span", { class: "meta", text: ago(e.at) }))));

    return h("div", { class: "fields" },
      h("div", { class: "detail-head" },
        h("div", null, h("h3", { text: l.company || l.url }), h("a", { class: "meta", href: l.url, target: "_blank", rel: "noopener", text: l.url.replace(/^https?:\/\//, "").replace(/\/$/, "") })),
        stageSelect(l.stage, (v) => patch({ stage: v }))),
      h("div", { class: "toolbar" },
        h("a", { class: "btn", href: `${base}/d/${l.agentId}?intern=1`, target: "_blank", rel: "noopener", text: "Demo öffnen" }),
        copyBtn("Demo-Link kopieren", () => `${base}/d/${l.agentId}`),
        h("button", { type: "button", class: "btn ghost", text: "Agent bearbeiten", onclick: () => openAgent(l.agentId) })),
      h("div", { class: "row2" }, field("Ansprechpartner", "contact"), field("E-Mail", "email", "email")),
      h("div", { class: "field" }, h("span", { class: "lbl", text: "Nachricht" }), email),
      h("div", { class: "field" }, h("label", { for: "aqNotes", text: "Notizen" }), notes),
      h("div", { class: "field" }, h("span", { class: "lbl", text: "Verlauf" }), timeline));
  }

  function settingsPanel() {
    const s = settings || { sender: {} };
    const inp = (label, key, ph, type = "text") => h("div", { class: "field" }, h("label", { for: `st_${key}`, text: label }), h("input", { class: "input", id: `st_${key}`, type, value: s.sender[key] || "", placeholder: ph }));
    const addr = h("textarea", { class: "textarea", id: "st_address", rows: 2, placeholder: "Musterstraße 1, 80331 München" });
    addr.value = s.sender.address || "";
    const pitch = h("textarea", { class: "textarea", id: "st_pitch", rows: 2, placeholder: "z. B. Wir richten den Assistenten in einer Woche ein, ab 49 € im Monat." });
    pitch.value = s.pitch || "";
    const days = h("input", { class: "input", id: "st_days", type: "number", min: "0", max: "30", value: String(s.followUpDays ?? 4) });
    const val = (id) => document.getElementById(id).value;
    const mail = data.mail;
    return h("div", { class: "fields" },
      h("div", { class: "detail-head" }, h("h3", { text: "Einstellungen" }), h("button", { type: "button", class: "btn ghost", text: "Schließen", onclick: () => { panel = "lead"; render(); } })),
      h("p", { class: "hint", text: "Absender und Anschrift stehen unter jeder E-Mail. In Deutschland ist das für geschäftliche E-Mails Pflicht." }),
      h("div", { class: "row2" }, inp("Dein Name", "name", "Anna Berger"), inp("Firma", "company", "Webagentur Süd GmbH")),
      h("div", { class: "row2" }, inp("E-Mail (für Antworten)", "email", "anna@webagentur-sued.de", "email"), inp("Telefon", "phone", "089 123456")),
      inp("Website", "website", "webagentur-sued.de"),
      h("div", { class: "field" }, h("label", { for: "st_address", text: "Anschrift" }), addr),
      h("div", { class: "field" }, h("label", { for: "st_pitch", text: "Dein Angebot in einem Satz (optional)" }), h("p", { class: "hint", text: "Mistral baut das in die E-Mails ein." }), pitch),
      h("div", { class: "field" }, h("label", { for: "st_days", text: "Nachfassen nach … Tagen (0 = aus)" }), days),
      h("button", { type: "button", class: "btn primary", text: "Speichern", onclick: () => act(async () => {
        settings = await api("PUT", "/api/settings", {
          sender: { name: val("st_name"), company: val("st_company"), email: val("st_email"), phone: val("st_phone"), website: val("st_website"), address: val("st_address") },
          pitch: val("st_pitch"), followUpDays: Number(val("st_days")),
        });
      }, "Einstellungen gespeichert.") }),
      h("div", { class: "note" }, h("strong", { text: "E-Mail-Versand: " }), mail.configured ? `eingerichtet, Absender ${mail.from}, höchstens ${mail.dailyLimit} E-Mails pro Tag.` : "nicht eingerichtet. Trage SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS und SMTP_FROM in die .env ein und starte neu. Bis dahin kannst du Entwürfe kopieren."),
      h("div", { class: "note" }, h("strong", { text: "Rechtlicher Hinweis: " }), "Werbe-E-Mails ohne vorherige Einwilligung sind in Deutschland auch an Firmen grundsätzlich unzulässig (§ 7 UWG) und können abgemahnt werden. Schreibe nur Firmen an, die eingewilligt haben oder mit denen du bereits in Kontakt bist. Die Entwürfe eignen sich auch als Gesprächsleitfaden fürs Telefon oder für LinkedIn."));
  }

  function copyBtn(label, get) {
    const b = h("button", { type: "button", class: "btn", text: label });
    b.addEventListener("click", () => {
      const done = (t) => { b.textContent = t; setTimeout(() => (b.textContent = label), 1500); };
      if (!navigator.clipboard) return done("Bitte manuell kopieren");
      navigator.clipboard.writeText(get()).then(() => done("Kopiert"), () => done("Bitte manuell kopieren"));
    });
    return b;
  }

  function render() {
    if (!data) { root.replaceChildren(h("div", { class: "empty", text: message?.text || "Lade Dashboard …" })); return; }
    const warnings = [];
    if (!data.mail.configured) warnings.push(h("div", { class: "note" }, h("strong", { text: "Versand nicht eingerichtet. " }), "Entwürfe kannst du schreiben lassen und kopieren. Zum Senden SMTP in der .env eintragen."));
    if (data.senderMissing.length) warnings.push(h("div", { class: "note" }, h("strong", { text: "Absender unvollständig: " }), `${data.senderMissing.join(", ")} fehlt. `, h("button", { type: "button", class: "linkish", text: "Jetzt ergänzen", onclick: () => { panel = "settings"; render(); } })));
    root.replaceChildren(...[
      h("div", { class: "aq-head" },
        h("div", null, h("span", { class: "eyebrow", text: "Akquise-Autopilot" }), h("h2", { text: "Dashboard" })),
        h("div", { class: "toolbar" },
          h("span", { class: "meta", text: `KI: ${getStatus().provider === "mistral" ? "Mistral AI (EU)" : getStatus().provider || "–"}` }),
          h("button", { type: "button", class: "btn", text: "Einstellungen", onclick: () => { panel = "settings"; render(); } }),
          h("button", { type: "button", class: "btn ghost", text: "Aktualisieren", onclick: () => load() }))),
      message ? h("div", { class: message.kind === "err" ? "err-box" : "ok-box", role: "status", text: message.text }) : null,
      ...warnings,
      kpis(),
      h("div", { class: "aq-grid" },
        h("div", { class: "aq-main" }, h("div", { class: "aq-two" }, funnel(), todo()), listCard()),
        h("aside", { class: "panel aq-panel", id: "aqPanel" }, panel === "settings" ? settingsPanel() : leadPanel())),
    ].filter(Boolean));
  }

  return {
    async show() { render(); await load(); },
    hide() { clearTimeout(timer); },
  };
}
