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

export function agentCard({ h, icon, a, status, onEdit }) {
  const tags = [a.fromWebsite || a.source ? "Aus Website" : null, a.demo || a.batchId ? "Demo" : null].filter(Boolean);
  const mark = h("span", { class: "agent-mark" }, icon("bot", 22));
  if (/^#[0-9a-f]{6}$/i.test(a.color || "")) mark.style.setProperty("--agent", a.color);
  return h("article", { class: "agent-card" },
    h("div", { class: "agent-card-top" }, mark, h("span", { class: "badge-soft", text: GOAL_BADGE[a.goal] || "Agent" })),
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

export function mountAgents({ root, api, h, icon, getStatus, onNew, onEdit }) {
  let agents = [];
  let query = "";
  let goal = "alle";
  const isKunde = () => getStatus().me?.role === "kunde";

  async function load() {
    try { agents = await api("GET", "/api/agents"); } catch { agents = []; }
    render();
  }

  function renderGrid() {
    const q = query.trim().toLowerCase();
    const list = agents.filter((a) => (goal === "alle" || a.goal === goal) && (!q || `${a.name} ${a.company} ${a.website}`.toLowerCase().includes(q)));
    const cards = list.map((a) => agentCard({ h, icon, a, status: getStatus(), onEdit }));
    if (!isKunde() && goal === "alle" && !q) cards.unshift(h("button", { type: "button", class: "agent-card add", onclick: onNew }, icon("plus", 34), h("span", { text: "Agent erstellen" }), h("span", { class: "meta", text: "aus Website oder Vorlage" })));
    if (!cards.length) cards.push(h("div", { class: "panel empty" }, h("strong", { text: "Nichts gefunden" }), "Ändere Filter oder Suche."));
    return cards;
  }

  function render() {
    const search = h("input", { class: "input", type: "search", id: "agSearch", placeholder: "Name, Firma, Website", value: query });
    search.addEventListener("input", () => { query = search.value; document.getElementById("agGrid").replaceChildren(...renderGrid()); });
    const counts = Object.fromEntries(Object.keys(GOAL_BADGE).map((k) => [k, agents.filter((a) => a.goal === k).length]));
    const chip = (k, label, n) => h("button", { type: "button", class: "chip", "aria-pressed": String(goal === k), onclick: () => { goal = k; render(); } }, label, h("span", { class: "count", text: String(n) }));
    root.replaceChildren(
      h("div", { class: "page-head" },
        h("div", null, h("span", { class: "eyebrow", text: isKunde() ? "Dein Zugang" : "Übersicht" }), h("h2", { text: `Deine Agenten (${agents.length})` })),
        h("div", { class: "toolbar" }, search, isKunde() ? null : h("button", { type: "button", class: "btn primary", onclick: onNew }, icon("plus", 16), "Agent erstellen"))),
      agents.length > 3 ? h("div", { class: "chips" }, chip("alle", "Alle", agents.length), Object.entries(GOAL_BADGE).filter(([k]) => counts[k]).map(([k, v]) => chip(k, v, counts[k]))) : null,
      agents.length || !isKunde()
        ? h("div", { class: "agent-grid", id: "agGrid" }, renderGrid())
        : h("div", { class: "panel empty" }, h("strong", { text: "Noch kein Agent zugewiesen" }), "Sobald deine Agentur dir einen Agenten freigibt, erscheint er hier."));
  }

  return { show: load, hide() {} };
}
