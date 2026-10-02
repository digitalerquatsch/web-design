// "Kunden": the customers of this workspace, what their bots do, and a form
// to create a customer who gets a copy of a ready demo (branding included).

export function mountCustomers({ root, api, h, icon, getStatus }) {
  let d = null, msg = null, secret = null, adding = false, busy = false, confirmId = null;

  async function load() {
    try { d = await api("GET", "/api/customers"); msg = null; } catch (e) { msg = e.message; }
    render();
  }

  const tile = (ic, n, label, tone) => h("div", { class: "stat" + (tone ? ` ${tone}` : "") }, h("span", { class: "stat-ico" }, icon(ic, 18)), h("strong", { text: (n || 0).toLocaleString("de-DE") }), h("span", { text: label }));

  function createForm() {
    const agent = h("select", { class: "input select", id: "cu_agent", "aria-label": "Demo übernehmen" }, h("option", { value: "", text: "Ohne Agent (später zuweisen)" }), d.agents.map((a) => h("option", { value: a.id, text: `${a.demo ? "Demo: " : ""}${a.name || "Agent"}${a.company ? ` (${a.company})` : ""}` })));
    const copy = h("input", { type: "checkbox", id: "cu_copy", checked: true });
    const err = h("p", { class: "msg err", role: "alert", hidden: true });
    const f = h("form", { class: "fields panel" },
      h("h3", { text: "Kunde anlegen" }),
      h("div", { class: "field" }, h("label", { for: "cu_name", text: "Name" }), h("input", { class: "input", id: "cu_name", required: true, autocomplete: "off" })),
      h("div", { class: "field" }, h("label", { for: "cu_email", text: "E-Mail" }), h("input", { class: "input", id: "cu_email", type: "email", required: true, autocomplete: "off" })),
      h("div", { class: "field" }, h("label", { for: "cu_company", text: "Firma (optional)" }), h("input", { class: "input", id: "cu_company", autocomplete: "off" })),
      h("div", { class: "field" }, h("label", { for: "cu_agent", text: "Demo übernehmen" }), agent),
      h("label", { class: "check", for: "cu_copy" }, copy, h("span", { text: "Kopie für den Kunden anlegen. Die Demo bleibt bei dir." })),
      err,
      h("div", { class: "toolbar" }, h("button", { type: "submit", class: "btn primary", disabled: busy, text: "Kunde anlegen" }), h("button", { type: "button", class: "btn ghost", text: "Abbrechen", onclick: () => { adding = false; render(); } })));
    f.addEventListener("submit", async (e) => {
      e.preventDefault();
      busy = true; err.hidden = true;
      try {
        const r = await api("POST", "/api/customers", { name: document.getElementById("cu_name").value, email: document.getElementById("cu_email").value, company: document.getElementById("cu_company").value, agentId: agent.value || undefined, copy: copy.checked });
        secret = { name: r.user.name, email: r.user.email, password: r.password };
        adding = false;
        await load();
      } catch (x) { err.textContent = x.message; err.hidden = false; }
      busy = false;
    });
    return f;
  }

  function customerCard(c) {
    const copyText = (t, b) => navigator.clipboard?.writeText(t).then(() => { b.textContent = "Kopiert"; });
    return h("article", { class: "panel customer" },
      h("div", { class: "toolbar" }, h("div", null, h("strong", { text: c.name }), h("div", { class: "meta", text: `${c.email}${c.company ? ` · ${c.company}` : ""}` })),
        h("span", { class: "meta", text: c.lastLoginAt ? `zuletzt aktiv ${new Date(c.lastLoginAt).toLocaleDateString("de-DE")}` : "noch nie angemeldet" })),
      c.agents.length ? h("ul", { class: "plain" }, c.agents.map((a) => h("li", null, h("strong", { text: a.name || "Agent" }), h("span", { class: "meta", text: ` · ${a.chats} Chats · ${a.requests} Anfragen` })))) : h("p", { class: "hint", text: "Noch kein Agent zugewiesen." }),
      confirmId === c.id
        ? h("div", { class: "toolbar" }, h("span", { class: "hint", text: "Zugang wirklich entfernen? Der Agent bleibt erhalten." }),
          h("button", { type: "button", class: "btn danger", text: "Ja, entfernen", onclick: async () => { try { await api("DELETE", `/api/customers/${c.id}`); confirmId = null; await load(); } catch (e) { msg = e.message; render(); } } }),
          h("button", { type: "button", class: "btn ghost", text: "Abbrechen", onclick: () => { confirmId = null; render(); } }))
        : h("div", { class: "toolbar" },
          h("button", { type: "button", class: "btn", text: "Neues Passwort", onclick: async () => { try { const r = await api("POST", `/api/customers/${c.id}/reset-password`, {}); secret = { name: c.name, email: c.email, password: r.password }; render(); } catch (e) { msg = e.message; render(); } } }),
          h("button", { type: "button", class: "btn ghost danger", text: "Entfernen", onclick: () => { confirmId = c.id; render(); } })));
  }

  function render() {
    if (!d) { root.replaceChildren(h("p", { class: "hint", text: msg || "Lädt …" })); return; }
    const free = Math.max(0, d.limit - d.used);
    const login = `${getStatus().publicUrl.replace(/\/$/, "")}/`;
    const parts = [
      h("div", { class: "page-head" }, h("div", null, h("span", { class: "eyebrow", text: "Dein Geschäft" }), h("h2", { text: "Kunden" }), h("p", { class: "hint", text: "Live geschaltete Bots für deine Kunden. Übernimm eine fertige Demo, Branding inklusive." }))),
      msg ? h("p", { class: "msg err", role: "alert", text: msg }) : null,
      secret ? h("div", { class: "note" }, h("strong", { text: `Zugang für ${secret.name}: ` }), "Das Passwort wird nur jetzt angezeigt.", h("pre", { class: "code", text: `E-Mail: ${secret.email}\nPasswort: ${secret.password}\nAnmelden: ${login}` }),
        (() => { const b = h("button", { type: "button", class: "btn", text: "Kopieren" }); b.addEventListener("click", () => navigator.clipboard?.writeText(`E-Mail: ${secret.email}\nPasswort: ${secret.password}\nAnmelden: ${login}`).then(() => { b.textContent = "Kopiert"; })); return b; })(),
        h("button", { type: "button", class: "btn ghost", text: "Fertig", onclick: () => { secret = null; render(); } })) : null,
      h("div", { class: "stats" }, tile("chat", d.totals.chats, "Chats gesamt"), tile("users", d.totals.messages, "Nachrichten gesamt"), tile("trend", d.totals.requests, "Anfragen gesamt", "ok")),
      adding ? createForm() : h("button", { type: "button", class: "agent-card add", disabled: free === 0, onclick: () => { adding = true; secret = null; render(); } }, icon("plus", 34), h("span", { text: "Kunde anlegen" }), h("span", { class: "meta", text: free ? `Noch ${free} von ${d.limit} frei` : `Alle ${d.limit} Plätze belegt` })),
      d.customers.length ? h("div", { class: "fields" }, d.customers.map(customerCard)) : h("p", { class: "hint", text: "Noch keine Kunden live. Übernimm eine fertige Demo, das komplette Branding wird automatisch übernommen." }),
    ];
    root.replaceChildren(...parts.filter(Boolean));
  }

  return { show: load, hide() {} };
}
