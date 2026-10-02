// "Deine Agenten": every agent as a card, plus the shared card renderer the
// start page uses for its recent list.

export const GOAL_BADGE = { booking: "Termin-Agent", support: "Service-Agent", leads: "Lead-Agent", sales: "Berater-Agent" };

export function ago(t) {
  if (!t) return "";
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return "gerade eben";
  if (m < 60) return `vor ${m} Min.`;
  const hrs = Math.round(m / 60);
  if (hrs < 24) return `vor ${hrs} Std.`;
  const d = Math.round(hrs / 24);
  return d < 30 ? `vor ${d} ${d === 1 ? "Tag" : "Tagen"}` : new Date(t).toLocaleDateString("de-DE");
}

export function modelLabel(status) {
  const m = String(status.model || "");
  const nice = m.replace(/-latest$/, "").replace(/^mistral-/, "Mistral ").replace(/^claude-/, "Claude ").replace(/-/g, " ");
  return nice.replace(/\b(\w)/g, (c) => c.toUpperCase()) || "KI";
}

const INT_ICON = { email: "mail", webhook: "link", slack: "chat", discord: "chat", telegram: "send" };

export function agentCard({ h, icon, a, status, onEdit, select = null, onMenu = null }) {
  const tags = [a.fromWebsite || a.source ? "Aus Website" : null, a.demo || a.batchId ? "Demo" : null].filter(Boolean);
  const mark = h("span", { class: "agent-mark" }, icon("bot", 22));
  if (/^#[0-9a-f]{6}$/i.test(a.color || "")) mark.style.setProperty("--agent", a.color);
  const ints = (a.integrations || []).filter((i) => i.enabled);
  const known = (a.sources?.length || 0) + (a.projects?.length || 0) + (a.faqs?.length || 0);
  const pick = select ? h("input", { type: "checkbox", class: "pick", "aria-label": `${a.name || "Agent"} auswählen`, checked: select.has(a.id), onchange: (e) => select.toggle(a.id, e.target.checked) }) : null;
  return h("article", { class: "agent-card" + (select?.has(a.id) ? " picked" : "") },
    h("div", { class: "agent-card-top" }, pick, mark, h("span", { class: "badge-soft", text: GOAL_BADGE[a.goal] || "Agent" }),
      onMenu && !select ? h("button", { type: "button", class: "kebab", "aria-label": "Weitere Aktionen", "aria-haspopup": "menu", onclick: (e) => onMenu(a, e.currentTarget) }, "⋮") : null),
    h("div", { class: "agent-ints" }, h("span", { class: "lbl", text: "Integrationen" }),
      h("div", { class: "ints-row" },
        h("span", { class: "int-ic" + (known ? " on" : ""), title: `Wissen: ${known} Einträge` }, icon("book", 16)),
        a.phoneEnabled ? h("span", { class: "int-ic on", title: "Telefon aktiv" }, icon("phone", 16)) : null,
        ints.length ? ints.map((i) => h("span", { class: "int-ic on", title: i.type }, icon(INT_ICON[i.type] || "link", 16))) : h("span", { class: "meta", text: "Keine Verbindungen" }))),
    h("div", { class: "agent-card-body" },
      h("h3", { text: a.name || "Ohne Namen" }),
      h("p", { class: "agent-sub", text: a.company || "Ohne Firma" }),
      tags.length ? h("div", { class: "tags" }, tags.map((t) => h("span", { class: "tag", text: t }))) : null),
    h("div", { class: "agent-card-foot" },
      h("span", { class: "meta", text: `${modelLabel(status)} · ${ago(a.updatedAt)}` }),
      h("div", { class: "toolbar" },
        h("a", { class: "btn ghost", href: `/d/${a.id}?intern=1`, target: "_blank", rel: "noopener", title: "Demo-Seite öffnen" }, icon("external", 16), "Demo"),
        h("button", { type: "button", class: "btn", onclick: () => onEdit(a.id) }, icon("edit", 16), "Bearbeiten"))));
}

export function mountAgents({ root, api, h, icon, getStatus, onNew, onEdit, onSeed }) {
  let agents = [];
  let query = "";
  let goal = "alle";
  let selecting = false;
  const picked = new Set();
  const isKunde = () => getStatus().me?.role === "kunde";

  async function load() {
    try { agents = await api("GET", "/api/agents"); } catch { agents = []; }
    render();
  }

  function openMenu(a, anchor) {
    document.getElementById("agMenu")?.remove();
    const close = () => { menu.remove(); document.removeEventListener("click", close, true); };
    const item = (label, fn, danger) => h("button", { type: "button", role: "menuitem", class: danger ? "danger" : "", text: label, onclick: async () => { close(); await fn(); } });
    const menu = h("div", { class: "ag-menu", id: "agMenu", role: "menu" },
      item("Bearbeiten", () => onEdit(a.id)),
      item("Duplizieren", async () => { try { await api("POST", `/api/agents/${a.id}/duplicate`, {}); } catch { /* list reload shows the truth */ } load(); }),
      item("Löschen", async () => { if (confirm(`„${a.name || "Agent"}“ samt Gesprächen und Kontakten löschen?`)) { try { await api("DELETE", `/api/agents/${a.id}`); } catch { /* reloaded below */ } load(); } }, true));
    const r = anchor.getBoundingClientRect();
    menu.style.top = `${r.bottom + window.scrollY + 4}px`;
    menu.style.left = `${Math.max(8, Math.min(r.right - 170, window.innerWidth - 178)) + window.scrollX}px`;
    document.body.append(menu);
    setTimeout(() => document.addEventListener("click", close, true));
  }
  async function deleteSelected() {
    if (!picked.size || !confirm(`${picked.size} Agenten samt Gesprächen und Kontakten löschen?`)) return;
    try { await api("POST", "/api/agents/bulk-delete", { ids: [...picked] }); } catch { /* reloaded below */ }
    picked.clear(); selecting = false; load();
  }

  function renderGrid() {
    const q = query.trim().toLowerCase();
    const list = agents.filter((a) => (goal === "alle" || a.goal === goal) && (!q || `${a.name} ${a.company} ${a.website}`.toLowerCase().includes(q)));
    const sel = selecting ? { has: (id) => picked.has(id), toggle: (id, on) => { on ? picked.add(id) : picked.delete(id); render(); } } : null;
    const cards = list.map((a) => agentCard({ h, icon, a, status: getStatus(), onEdit, select: sel, onMenu: isKunde() ? null : openMenu }));
    if (!isKunde() && !selecting && goal === "alle" && !q) cards.unshift(h("button", { type: "button", class: "agent-card add", onclick: onNew }, icon("plus", 34), h("span", { text: "Agent erstellen" }), h("span", { class: "meta", text: "aus Website oder Vorlage" })));
    if (!cards.length) cards.push(h("div", { class: "panel empty" }, h("strong", { text: "Nichts gefunden" }), "Ändere Filter oder Suche."));
    return cards;
  }

  function render() {
    const search = h("input", { class: "input", type: "search", id: "agSearch", placeholder: "Name, Firma, Website", value: query });
    search.addEventListener("input", () => { query = search.value; document.getElementById("agGrid").replaceChildren(...renderGrid()); });
    const counts = Object.fromEntries(Object.keys(GOAL_BADGE).map((k) => [k, agents.filter((a) => a.goal === k).length]));
    const chip = (k, label, n) => h("button", { type: "button", class: "chip", "aria-pressed": String(goal === k), onclick: () => { goal = k; render(); } }, label, h("span", { class: "count", text: String(n) }));
    root.replaceChildren(...[
      h("div", { class: "page-head" },
        h("div", null, h("span", { class: "eyebrow", text: isKunde() ? "Dein Zugang" : "Übersicht" }), h("h2", { text: `Deine Agenten (${agents.length})` })),
        h("div", { class: "toolbar" }, search,
          isKunde() || !agents.length ? null : h("button", { type: "button", class: "btn", "aria-pressed": String(selecting), onclick: () => { selecting = !selecting; picked.clear(); render(); } }, icon("check", 16), selecting ? "Abbrechen" : "Auswählen"),
          selecting ? h("button", { type: "button", class: "btn danger", disabled: !picked.size, onclick: deleteSelected, text: `${picked.size} löschen` }) : null,
          isKunde() || !onSeed ? null : h("button", { type: "button", class: "btn", title: "Legt einen fertigen Agenten an, der deine 7 GitHub-Projekte kennt", onclick: onSeed }, icon("rocket", 16), "Agent mit meinen Projekten"),
          isKunde() ? null : h("button", { type: "button", class: "btn primary", onclick: onNew }, icon("plus", 16), "Agent erstellen"))),
      agents.length > 3 ? h("div", { class: "chips" }, chip("alle", "Alle", agents.length), Object.entries(GOAL_BADGE).filter(([k]) => counts[k]).map(([k, v]) => chip(k, v, counts[k]))) : null,
      agents.length || !isKunde()
        ? h("div", { class: "agent-grid", id: "agGrid" }, renderGrid())
        : h("div", { class: "panel empty" }, h("strong", { text: "Noch kein Agent zugewiesen" }), "Sobald deine Agentur dir einen Agenten freigibt, erscheint er hier.")].filter(Boolean));
  }

  return { show: load, hide() {} };
}
