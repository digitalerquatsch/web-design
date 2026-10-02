// User management: approve access requests, invite, change roles, assign
// agents to customers, block, reset passwords, delete.

const ROLE_HINT = {
  admin: "Alles, auch Nutzerverwaltung",
  team: "Builder, Autopilot und Akquise",
  kunde: "Nur die zugewiesenen Agenten im Builder",
};

export function mountUsers({ root, api, h, getStatus, onChange }) {
  let users = [], config = { signupOpen: true }, roles = {}, statuses = {};
  let agents = [];
  let filter = "alle", query = "";
  let secret = null;      // { name, email, password } shown once
  let confirm = null;     // { id, kind }
  let openAgents = null;  // user id whose agent list is expanded
  let message = null;

  const me = () => getStatus().me || {};
  const initials = (n) => String(n || "?").split(/\s+/).map((x) => x[0]).join("").slice(0, 2).toUpperCase();
  function ago(t) {
    if (!t) return "noch nie";
    const m = Math.round((Date.now() - t) / 60000);
    if (m < 60) return m < 1 ? "gerade eben" : `vor ${m} Min.`;
    const hrs = Math.round(m / 60);
    if (hrs < 24) return `vor ${hrs} Std.`;
    const d = Math.round(hrs / 24);
    return d < 30 ? `vor ${d} ${d === 1 ? "Tag" : "Tagen"}` : new Date(t).toLocaleDateString("de-DE");
  }

  async function load() {
    if (me().id === "local") { render(); return; }
    try {
      const r = await api("GET", "/api/users");
      users = r.users; config = r.config; roles = r.roles; statuses = r.statuses;
      agents = await api("GET", "/api/agents");
    } catch (e) { message = { kind: "err", text: e.message }; }
    render();
  }
  async function act(fn, ok) {
    message = null;
    try { const r = await fn(); if (ok) message = { kind: "ok", text: typeof ok === "function" ? ok(r) : ok }; } catch (e) { message = { kind: "err", text: e.message }; }
    confirm = null;
    await load();
    onChange?.();
  }
  const patch = (u, body, ok) => act(() => api("PATCH", `/api/users/${u.id}`, body), ok);

  function roleSelect(value, onPick, id) {
    const s = h("select", { class: "input select", id, "aria-label": "Rolle" });
    for (const [k, v] of Object.entries(roles)) s.append(h("option", { value: k, text: v }));
    s.value = value;
    s.addEventListener("change", () => onPick(s.value));
    return s;
  }
  function copyBtn(text) {
    const b = h("button", { type: "button", class: "btn", text: "Kopieren" });
    b.addEventListener("click", () => navigator.clipboard?.writeText(text).then(() => { b.textContent = "Kopiert"; setTimeout(() => (b.textContent = "Kopieren"), 1500); }, () => { b.textContent = "Bitte markieren"; }));
    return b;
  }

  function statTile(label, n, sub) {
    return h("div", { class: "kpi" }, h("span", { class: "kpi-label", text: label }), h("strong", { class: "kpi-value", text: String(n) }), sub ? h("span", { class: "kpi-sub", text: sub }) : null);
  }

  function pendingCard(u) {
    let role = "team";
    const sel = roleSelect(role, (v) => { role = v; }, `pr_${u.id}`);
    const asking = confirm?.id === u.id && confirm.kind === "reject";
    return h("article", { class: "ucard pending" },
      h("div", { class: "ucard-top" }, h("span", { class: "avatar", text: initials(u.name) }),
        h("div", { class: "ucard-who" }, h("strong", { text: u.name }), h("span", { class: "meta", text: u.email }), u.company ? h("span", { class: "meta", text: u.company }) : null),
        h("span", { class: "pill st-entwurf", text: "Wartet" })),
      u.note ? h("p", { class: "ucard-note", text: `„${u.note}“` }) : null,
      h("p", { class: "meta", text: `Angefragt ${ago(u.createdAt)}` }),
      h("div", { class: "field" }, h("label", { for: `pr_${u.id}`, text: "Freischalten als" }), sel),
      asking
        ? h("div", { class: "confirm" }, h("span", { text: "Anfrage ablehnen und löschen?" }),
          h("button", { type: "button", class: "btn danger", text: "Ja, ablehnen", onclick: () => act(() => api("DELETE", `/api/users/${u.id}`), `Anfrage von ${u.name} abgelehnt.`) }),
          h("button", { type: "button", class: "btn ghost", text: "Abbrechen", onclick: () => { confirm = null; render(); } }))
        : h("div", { class: "toolbar" },
          h("button", { type: "button", class: "btn primary", text: "Freischalten", onclick: () => patch(u, { status: "active", role }, (r) => `${u.name} ist freigeschaltet${r.mailed ? " und per E-Mail informiert" : ""}.`) }),
          h("button", { type: "button", class: "btn ghost danger", text: "Ablehnen", onclick: () => { confirm = { id: u.id, kind: "reject" }; render(); } })));
  }

  function userCard(u) {
    const isMe = u.id === me().id;
    const asking = confirm?.id === u.id ? confirm.kind : null;
    const card = h("article", { class: "ucard" + (u.status === "blocked" ? " blocked" : "") + (isMe ? " me" : "") },
      h("div", { class: "ucard-top" }, h("span", { class: "avatar", text: initials(u.name) }),
        h("div", { class: "ucard-who" }, h("strong", null, u.name, isMe ? h("span", { class: "you", text: " · du" }) : null), h("span", { class: "meta", text: u.email }), u.company ? h("span", { class: "meta", text: u.company }) : null),
        h("span", { class: "pill " + (u.status === "active" ? "st-interessiert" : "st-abgemeldet"), text: u.status === "active" ? "Aktiv" : "Gesperrt" })),
      h("div", { class: "ucard-meta" },
        h("span", { class: "meta", text: `Letzte Anmeldung: ${ago(u.lastLoginAt)}` }),
        u.approvedBy ? h("span", { class: "meta", text: `Freigeschaltet von ${u.approvedBy}` }) : null),
      h("div", { class: "field" }, h("label", { for: `ro_${u.id}`, text: "Rolle" }), roleSelect(u.role, (v) => patch(u, { role: v }, `${u.name} ist jetzt ${roles[v]}.`), `ro_${u.id}`), h("span", { class: "hint", text: ROLE_HINT[u.role] })));

    if (u.role === "kunde") {
      const assigned = new Set(u.agentIds || []);
      const open = openAgents === u.id;
      card.append(h("div", { class: "field" },
        h("button", { type: "button", class: "linkish", "aria-expanded": String(open), text: `${assigned.size} ${assigned.size === 1 ? "Agent" : "Agenten"} zugewiesen · ${open ? "schließen" : "ändern"}`, onclick: () => { openAgents = open ? null : u.id; render(); } }),
        open ? h("div", { class: "agent-picks" }, agents.length ? agents.map((a) => {
          const cb = h("input", { type: "checkbox", id: `ag_${u.id}_${a.id}` });
          cb.checked = assigned.has(a.id);
          cb.addEventListener("change", () => { cb.checked ? assigned.add(a.id) : assigned.delete(a.id); });
          return h("label", { class: "pick", for: `ag_${u.id}_${a.id}` }, cb, h("span", { text: `${a.name || "Ohne Namen"}${a.company ? " · " + a.company : ""}` }));
        }) : h("p", { class: "hint", text: "Noch keine Agenten vorhanden." }),
        h("button", { type: "button", class: "btn primary", text: "Zuweisung speichern", onclick: () => { openAgents = null; patch(u, { agentIds: [...assigned] }, "Zuweisung gespeichert."); } })) : null));
    }

    if (asking === "delete") {
      card.append(h("div", { class: "confirm" }, h("span", { text: `${u.name} endgültig löschen?` }),
        h("button", { type: "button", class: "btn danger", text: "Ja, löschen", onclick: () => act(() => api("DELETE", `/api/users/${u.id}`), `${u.name} gelöscht.`) }),
        h("button", { type: "button", class: "btn ghost", text: "Abbrechen", onclick: () => { confirm = null; render(); } })));
    } else if (asking === "reset") {
      card.append(h("div", { class: "confirm" }, h("span", { text: "Neues Passwort erzeugen? Das alte gilt dann nicht mehr." }),
        h("button", { type: "button", class: "btn primary", text: "Ja, neu erzeugen", onclick: () => act(async () => { const r = await api("POST", `/api/users/${u.id}/reset-password`); secret = { name: u.name, email: u.email, password: r.password }; }) }),
        h("button", { type: "button", class: "btn ghost", text: "Abbrechen", onclick: () => { confirm = null; render(); } })));
    } else {
      card.append(h("div", { class: "toolbar" },
        isMe ? null : u.status === "active"
          ? h("button", { type: "button", class: "btn", text: "Sperren", onclick: () => patch(u, { status: "blocked" }, `${u.name} ist gesperrt.`) })
          : h("button", { type: "button", class: "btn primary", text: "Entsperren", onclick: () => patch(u, { status: "active" }, `${u.name} ist wieder aktiv.`) }),
        isMe ? null : h("button", { type: "button", class: "btn ghost", text: "Passwort zurücksetzen", onclick: () => { confirm = { id: u.id, kind: "reset" }; render(); } }),
        isMe ? null : h("button", { type: "button", class: "btn ghost danger", text: "Löschen", onclick: () => { confirm = { id: u.id, kind: "delete" }; render(); } })));
    }
    return card;
  }

  function inviteCard() {
    const f = h("form", { class: "fields", style: "gap:10px" },
      h("div", { class: "field" }, h("label", { for: "iv_name", text: "Name" }), h("input", { class: "input", id: "iv_name", required: true })),
      h("div", { class: "field" }, h("label", { for: "iv_email", text: "E-Mail" }), h("input", { class: "input", id: "iv_email", type: "email", required: true })),
      h("div", { class: "field" }, h("label", { for: "iv_company", text: "Firma (optional)" }), h("input", { class: "input", id: "iv_company" })),
      h("div", { class: "field" }, h("label", { for: "iv_role", text: "Rolle" }), roleSelect("team", () => {}, "iv_role")),
      h("button", { type: "submit", class: "btn primary", text: "Zugang anlegen" }));
    f.addEventListener("submit", (e) => {
      e.preventDefault();
      const v = (id) => document.getElementById(id).value;
      act(async () => {
        const r = await api("POST", "/api/users", { name: v("iv_name"), email: v("iv_email"), company: v("iv_company"), role: v("iv_role") });
        secret = { name: r.user.name, email: r.user.email, password: r.password };
      });
    });
    return h("section", { class: "panel ucard invite" }, h("h3", { text: "Nutzer einladen" }), h("p", { class: "hint", text: "Legt einen aktiven Zugang mit Einmal-Passwort an. Gib es sicher weiter, z. B. am Telefon." }), f);
  }

  function setupCard() {
    const err = h("div", { class: "err-box", hidden: true });
    const f = h("form", { class: "fields", style: "gap:10px" },
      h("div", { class: "field" }, h("label", { for: "fs_name", text: "Name" }), h("input", { class: "input", id: "fs_name", required: true, autocomplete: "name" })),
      h("div", { class: "field" }, h("label", { for: "fs_email", text: "E-Mail" }), h("input", { class: "input", id: "fs_email", type: "email", required: true, autocomplete: "email" })),
      h("div", { class: "field" }, h("label", { for: "fs_pw", text: "Passwort (mindestens 10 Zeichen)" }), h("input", { class: "input", id: "fs_pw", type: "password", minlength: "10", required: true, autocomplete: "new-password" })),
      err, h("button", { type: "submit", class: "btn primary big", text: "Admin-Zugang anlegen" }));
    f.addEventListener("submit", async (e) => {
      e.preventDefault();
      const v = (id) => document.getElementById(id).value;
      try { await api("POST", "/api/auth/setup", { name: v("fs_name"), email: v("fs_email"), password: v("fs_pw") }); location.reload(); } catch (x) { err.textContent = x.message; err.hidden = false; }
    });
    return h("section", { class: "panel ucard setup" }, h("h3", { text: "Zuerst: deinen Admin-Zugang anlegen" }),
      h("p", { class: "hint", text: "Noch gibt es kein Konto, deshalb ist der Builder nur über localhost offen. Mit dem ersten Admin wird die Anmeldung Pflicht, und du kannst weitere Nutzer freischalten." }), f);
  }

  function render() {
    if (me().id === "local") { root.replaceChildren(h("div", { class: "aq-head" }, h("div", null, h("span", { class: "eyebrow", text: "Verwaltung" }), h("h2", { text: "Nutzer" }))), setupCard()); return; }
    const pending = users.filter((u) => u.status === "pending");
    const rest = users.filter((u) => u.status !== "pending");
    const q = query.trim().toLowerCase();
    const shown = rest.filter((u) => (filter === "alle" || (filter === "blocked" ? u.status === "blocked" : u.role === filter)) && (!q || `${u.name} ${u.email} ${u.company}`.toLowerCase().includes(q)));

    const toggle = h("input", { type: "checkbox", id: "signupOpen", role: "switch" });
    toggle.checked = !!config.signupOpen;
    toggle.addEventListener("change", () => act(() => api("PUT", "/api/auth/config", { signupOpen: toggle.checked }), toggle.checked ? "Registrierung ist offen." : "Registrierung ist geschlossen."));

    const chip = (k, label, n) => h("button", { type: "button", class: "chip", "aria-pressed": String(filter === k), onclick: () => { filter = k; render(); } }, label, h("span", { class: "count", text: String(n) }));
    const search = h("input", { class: "input", type: "search", id: "uSearch", placeholder: "Name, E-Mail, Firma", value: query });
    search.addEventListener("input", () => { query = search.value; const pos = search.selectionStart; render(); const s = document.getElementById("uSearch"); s.focus(); s.setSelectionRange(pos, pos); });

    root.replaceChildren(...[
      h("div", { class: "aq-head" },
        h("div", null, h("span", { class: "eyebrow", text: "Verwaltung" }), h("h2", { text: "Nutzer" })),
        h("label", { class: "switch", for: "signupOpen" }, toggle, h("span", null, h("b", { text: "Registrierung offen" }), h("span", { class: "meta", text: " · neue Leute können einen Zugang beantragen" })))),
      message ? h("div", { class: message.kind === "err" ? "err-box" : "ok-box", role: "status", text: message.text }) : null,
      secret ? h("div", { class: "secret panel" },
        h("div", null, h("strong", { text: `Einmal-Passwort für ${secret.name}` }), h("p", { class: "hint", text: `${secret.email} · wird nur jetzt angezeigt. Bitte beim ersten Login ändern lassen.` })),
        h("code", { class: "secret-pw", text: secret.password }),
        h("div", { class: "toolbar" }, copyBtn(`E-Mail: ${secret.email}\nPasswort: ${secret.password}\nAnmelden: ${getStatus().publicUrl}/`), h("button", { type: "button", class: "btn ghost", text: "Fertig", onclick: () => { secret = null; render(); } }))) : null,
      h("div", { class: "kpis four" },
        statTile("Aktiv", users.filter((u) => u.status === "active").length, "können sich anmelden"),
        statTile("Warten", pending.length, pending.length ? "auf deine Freischaltung" : "keine offenen Anfragen"),
        statTile("Kunden", users.filter((u) => u.role === "kunde").length, "sehen nur ihre Agenten"),
        statTile("Gesperrt", users.filter((u) => u.status === "blocked").length, null)),
      h("div", { class: "users-layout" },
        h("div", { class: "users-main" },
          h("h3", { class: "section-title", text: `Wartet auf Freischaltung (${pending.length})` }),
          pending.length ? h("div", { class: "ucards" }, pending.map(pendingCard))
            : h("div", { class: "panel empty" }, h("strong", { text: "Keine offenen Anfragen" }), config.signupOpen ? `Neue Leute beantragen einen Zugang über die Anmeldeseite (${getStatus().publicUrl}/).` : "Die Registrierung ist geschlossen. Lade Leute direkt ein."),
          h("div", { class: "section-row" }, h("h3", { class: "section-title", text: "Alle Zugänge" }), search),
          h("div", { class: "chips" }, chip("alle", "Alle", rest.length), chip("admin", "Admins", rest.filter((u) => u.role === "admin").length), chip("team", "Team", rest.filter((u) => u.role === "team").length), chip("kunde", "Kunden", rest.filter((u) => u.role === "kunde").length), chip("blocked", "Gesperrt", rest.filter((u) => u.status === "blocked").length)),
          shown.length ? h("div", { class: "ucards" }, shown.map(userCard)) : h("div", { class: "panel empty" }, h("strong", { text: "Niemand gefunden" }), "Ändere Filter oder Suche.")),
        h("aside", { class: "users-side" }, inviteCard(),
          h("section", { class: "panel ucard" }, h("h3", { text: "Rollen" }), h("dl", { class: "roles" }, Object.entries(ROLE_HINT).flatMap(([k, v]) => [h("dt", { text: roles[k] || k }), h("dd", { text: v })]))))),
    ].filter(Boolean));
  }

  return { show: load, hide() {} };
}
