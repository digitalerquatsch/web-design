// Autopilot view: upload a table, watch every row become an agent with a
// demo link, export the result. Rendered with createElement/textContent only.

const SAMPLE = "Firma;Website;Ansprechpartner;E-Mail\nPhysiotherapie Am Park;physio-ampark.de;Anna Weber;info@physio-ampark.de\nSalon Lindgrün;salon-lindgruen.de;Lena Grün;hallo@salon-lindgruen.de\n";

export function mountAutopilot({ root, api, h, headers, getStatus, openAgent, onReview }) {
  let batches = [];
  let current = null;       // full batch with rows
  let timer = null;
  let file = null;
  let uploadError = "";
  let uploading = false;
  let confirmDelete = false;

  const fmt = (t) => new Date(t).toLocaleString("de-DE", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  const steps = () => getStatus().steps || {};
  const demoUrl = (id) => `${getStatus().publicUrl.replace(/\/$/, "")}/d/${id}`;

  function download(name, blob) {
    const a = h("a", { href: URL.createObjectURL(blob), download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  async function refreshList() {
    try { batches = await api("GET", "/api/batches"); } catch { /* keep the old list */ }
  }
  async function select(id) {
    confirmDelete = false;
    try { current = id ? await api("GET", `/api/batches/${id}`) : null; } catch { current = null; }
    render();
    schedule();
  }
  function schedule() {
    clearTimeout(timer);
    if (root.hidden) return;
    const running = current?.status === "running" || batches.some((b) => b.status === "running");
    if (running) timer = setTimeout(async () => {
      await refreshList();
      if (current) { try { current = await api("GET", `/api/batches/${current.id}`); } catch { /* ignore */ } }
      render();
      schedule();
    }, 2000);
  }

  async function upload(name) {
    if (!file) return;
    uploading = true; uploadError = ""; render();
    try {
      const res = await fetch(`/api/batches?filename=${encodeURIComponent(file.name)}&name=${encodeURIComponent(name)}`, { method: "POST", headers: { ...headers(), "content-type": "application/octet-stream" }, body: file });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || `Fehler ${res.status}`);
      file = null;
      await refreshList();
      await select(j.id);
      if (j.skipped?.length) uploadError = `${j.skipped.length} Zeilen übersprungen: ` + j.skipped.slice(0, 3).map((s) => `${s.value} (${s.reason})`).join(", ") + (j.skipped.length > 3 ? " …" : "");
    } catch (e) {
      uploadError = e.message;
    }
    uploading = false;
    render();
  }

  function uploadCard() {
    const input = h("input", { type: "file", id: "apFile", accept: ".csv,.xlsx,.tsv,.txt,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", hidden: true });
    input.addEventListener("change", () => { file = input.files[0] || null; uploadError = ""; render(); });
    const drop = h("label", { class: "drop" + (file ? " has" : ""), for: "apFile" },
      h("strong", { text: file ? file.name : "Tabelle hierher ziehen oder auswählen" }),
      h("span", { text: file ? `${Math.ceil(file.size / 1024)} KB · klicken zum Ändern` : "Excel (.xlsx) oder CSV, bis 200 Websites" }));
    drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
    drop.addEventListener("dragleave", () => drop.classList.remove("over"));
    drop.addEventListener("drop", (e) => { e.preventDefault(); file = e.dataTransfer.files[0] || null; uploadError = ""; render(); });
    const name = h("input", { class: "input", id: "apName", placeholder: "Name des Durchlaufs (optional), z. B. Physios Freiburg" });
    const start = h("button", { type: "button", class: "btn primary", disabled: !file || uploading || !getStatus().aiConfigured || null, text: uploading ? "Lädt hoch …" : "Autopilot starten", onclick: () => upload(name.value.trim()) });
    return h("div", { class: "panel ap-upload" },
      h("div", { class: "form-head" }, h("span", { class: "eyebrow", text: "Autopilot" }), h("h2", { text: "Viele Agenten auf einmal" }),
        h("p", { text: "Lade eine Tabelle mit Websites hoch. Für jede Zeile liest der Autopilot die Website, baut einen fertigen Agenten und erstellt eine Demo-Seite, auf der der Chat über der echten Website liegt. Den Link schickst du deinem Kunden." })),
      drop, input,
      h("div", { class: "toolbar" }, name, start),
      !getStatus().aiConfigured ? h("div", { class: "err-box", text: `${getStatus().keyName} fehlt in der .env des Servers.` }) : null,
      uploadError ? h("div", { class: uploadError.includes("übersprungen") ? "note" : "err-box", text: uploadError }) : null,
      h("p", { class: "hint" }, "Erkannte Spalten: Website (Pflicht), Firma, Ansprechpartner, E-Mail, Telefon, Ort. ",
        h("button", { type: "button", class: "linkish", text: "Beispiel-Tabelle herunterladen", onclick: () => download("autopilot-beispiel.csv", new Blob(["﻿" + SAMPLE], { type: "text/csv" })) })),
      getStatus().screenshots ? null : h("p", { class: "hint", text: "Screenshots sind auf diesem Server nicht eingerichtet. Die Demos zeigen dann eine nachgebaute Seite in den Farben der Firma (siehe README: playwright)." }));
  }

  function progress(b) {
    const done = b.counts.done, failed = b.counts.failed;
    const bar = h("div", { class: "pbar", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": String(b.total), "aria-valuenow": String(done + failed) },
      h("span", { class: "ok", style: `width:${(done / b.total) * 100}%` }), h("span", { class: "bad", style: `width:${(failed / b.total) * 100}%` }));
    return bar;
  }

  function batchList() {
    if (!batches.length) return h("div", { class: "panel ap-list" }, h("div", { class: "empty" }, h("strong", { text: "Noch kein Durchlauf" }), "Lade oben eine Tabelle hoch. Die Durchläufe erscheinen hier."));
    return h("div", { class: "panel ap-list" }, h("div", { class: "cap-section", text: "Durchläufe" }),
      batches.map((b) => h("button", { type: "button", class: "ap-item", "aria-current": current?.id === b.id ? "true" : null, onclick: () => select(b.id) },
        h("span", { class: "ap-item-top" }, h("strong", { text: b.name }), h("span", { class: "meta", text: `${b.counts.done + b.counts.failed}/${b.total}` })),
        progress(b),
        h("span", { class: "meta", text: fmt(b.createdAt) + (b.status === "running" ? " · läuft" : b.counts.failed ? ` · ${b.counts.failed} fehlgeschlagen` : " · fertig") }))));
  }

  function copy(btn, text, label) {
    const done = (t) => { btn.textContent = t; setTimeout(() => (btn.textContent = label), 1500); };
    if (!navigator.clipboard) return done("Bitte manuell kopieren");
    navigator.clipboard.writeText(text).then(() => done("Kopiert"), () => done("Bitte manuell kopieren"));
  }

  function detail() {
    if (!current) return null;
    const b = current;
    const actions = h("div", { class: "toolbar" },
      b.counts.done ? h("button", { type: "button", class: "btn primary", text: "Durchgehen & senden", onclick: async () => {
        const leads = await api("GET", "/api/leads");
        const order = new Map(b.rows.map((r, i) => [r.agentId, i]));
        const mine = leads.filter((l) => l.batchId === b.id).sort((x, y) => (order.get(x.agentId) ?? 0) - (order.get(y.agentId) ?? 0));
        onReview({ leadIds: mine.map((l) => l.id), label: b.name });
      } }) : null,
      h("button", { type: "button", class: "btn", text: "Ergebnis als Tabelle", disabled: !b.counts.done || null, onclick: async () => {
        const res = await fetch(`/api/batches/${b.id}/export`, { headers: headers() });
        if (res.ok) download(`${b.name.replace(/[^\wäöüÄÖÜß -]+/g, "").trim() || "autopilot"}.csv`, await res.blob());
      } }),
      b.counts.failed ? h("button", { type: "button", class: "btn", text: `${b.counts.failed} erneut versuchen`, onclick: async () => { await api("POST", `/api/batches/${b.id}/retry`); await refreshList(); await select(b.id); } }) : null,
      confirmDelete
        ? h("span", { class: "confirm" }, h("span", { text: `Durchlauf und alle ${b.counts.done} Agenten samt Demo-Links löschen?` }),
          h("button", { type: "button", class: "btn danger", text: "Ja, löschen", onclick: async () => { await api("DELETE", `/api/batches/${b.id}`); current = null; await refreshList(); render(); } }),
          h("button", { type: "button", class: "btn ghost", text: "Abbrechen", onclick: () => { confirmDelete = false; render(); } }))
        : h("button", { type: "button", class: "btn ghost danger", text: "Löschen", onclick: () => { confirmDelete = true; render(); } }));

    const rows = h("div", { class: "ap-rows" });
    for (const r of b.rows) {
      const host = (() => { try { return new URL(r.url).hostname.replace(/^www\./, ""); } catch { return r.url; } })();
      const cells = h("div", { class: "ap-actions" });
      if (r.status === "done") {
        const link = demoUrl(r.agentId);
        const cp = h("button", { type: "button", class: "btn", text: "Link kopieren" });
        cp.addEventListener("click", () => copy(cp, link, "Link kopieren"));
        cells.append(
          h("a", { class: "btn primary", href: `/d/${r.agentId}`, target: "_blank", rel: "noopener", text: "Demo ansehen" }),
          cp,
          h("button", { type: "button", class: "btn ghost", text: "Bearbeiten", onclick: () => openAgent(r.agentId) }));
      }
      rows.append(h("div", { class: "ap-row" },
        h("div", { class: "ap-who" },
          h("strong", { text: r.company || host }),
          h("a", { href: r.url, target: "_blank", rel: "noopener", class: "meta", text: host }),
          r.contact || r.email ? h("span", { class: "meta", text: [r.contact, r.email].filter(Boolean).join(" · ") }) : null),
        h("div", null,
          h("span", { class: "pill s-" + r.status, text: steps()[r.status] || r.status }),
          r.status === "done" && !r.screenshot && getStatus().screenshots ? h("span", { class: "meta", text: " ohne Screenshot" }) : null,
          r.error ? h("p", { class: "ap-err", text: r.error }) : null),
        cells));
    }
    const skipped = b.skipped?.length ? h("details", { class: "note" }, h("summary", { text: `${b.skipped.length} Zeilen beim Hochladen übersprungen` }),
      h("ul", null, b.skipped.map((s) => h("li", { text: `${s.value}: ${s.reason}` })))) : null;

    return h("div", { class: "panel ap-detail" },
      h("div", { class: "ap-detail-head" },
        h("div", null, h("h2", { text: b.name }), h("p", { class: "hint", text: `${b.total} Websites · ${b.counts.done} fertig · ${b.counts.failed} fehlgeschlagen${b.status === "running" ? " · läuft, die Liste aktualisiert sich von selbst" : ""}` })),
        progress(b)),
      actions, skipped, rows);
  }

  function render() {
    root.replaceChildren(h("div", { class: "ap-grid" }, h("div", { class: "ap-side" }, uploadCard(), batchList()), detail() || h("div", { class: "panel ap-detail" },
      h("div", { class: "empty" }, h("strong", { text: "So funktioniert der Autopilot" }),
        h("ol", { class: "ap-steps" },
          h("li", { text: "Tabelle mit Firmen und Websites hochladen." }),
          h("li", { text: "Pro Website: Seiten lesen, Agent mit Wissen, FAQ und Einstiegsfragen bauen, Screenshot erstellen." }),
          h("li", { text: "Demo-Links ansehen, anpassen und per Tabelle exportieren, z. B. für deine Akquise-Mails." }))))));
  }

  return {
    async show() {
      await refreshList();
      if (!current && batches[0]) await select(batches[0].id); else { render(); schedule(); }
    },
    hide() { clearTimeout(timer); },
  };
}
