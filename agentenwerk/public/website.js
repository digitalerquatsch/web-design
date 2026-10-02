// "Deine Website": settings for the public agency page at /s/<slug>.
// Saved explicitly; images are scaled in the browser before upload.

const NICHE_ORDER = ["allgemein", "handwerk", "praxen", "auto", "immobilien", "gastro", "beauty", "beratung"];
const COLORS = ["#3b82f6", "#06b6d4", "#10b981", "#f97316", "#ef4444", "#ff2e93"];

function scaleImage(file, maxSide, type) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, maxSide / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(img.width * k)); c.height = Math.max(1, Math.round(img.height * k));
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL(type, 0.85));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Das Bild konnte nicht gelesen werden.")); };
    img.src = url;
  });
}

export function mountWebsite({ root, api, h, icon }) {
  let s = null;
  let msg = null;
  let busy = false;
  let refineOpen = false;
  let agents = [];

  async function load() {
    try { [s, agents] = await Promise.all([api("GET", "/api/site"), api("GET", "/api/agents").catch(() => [])]); msg = null; } catch (e) { msg = { kind: "err", text: e.message }; }
    render();
  }
  async function save(extra = {}, okText = "Gespeichert.") {
    if (busy) return;
    busy = true;
    try {
      const body = { ...s, ...extra };
      delete body.url; delete body.missing; delete body.niches; delete body.countries; delete body.views; delete body.cnameTarget; delete body.domainVerified;
      if (!("domain" in extra)) delete body.domain;
      s = await api("PUT", "/api/site", body);
      msg = { kind: "ok", text: okText };
    } catch (e) { msg = { kind: "err", text: e.message }; }
    busy = false;
    render();
  }

  const input = (key, label, opts = {}) => h("div", { class: "field" }, h("label", { for: `ws_${key}`, text: label }), opts.hint ? h("p", { class: "hint", text: opts.hint }) : null,
    h("input", { class: "input", id: `ws_${key}`, type: opts.type || "text", value: s[key] || "", placeholder: opts.ph || "", autocomplete: "off", oninput: (e) => { s[key] = e.target.value; } }));
  const area = (key, label, rows, hint) => {
    const t = h("textarea", { class: "textarea", id: `ws_${key}`, rows, oninput: (e) => { s[key] = e.target.value; } });
    t.value = s[key] || "";
    return h("div", { class: "field" }, h("label", { for: `ws_${key}`, text: label }), hint ? h("p", { class: "hint", text: hint }) : null, t);
  };
  const choice = (items, current, pick) => h("div", { class: "chips", role: "group" }, items.map(([v, label]) => h("button", { type: "button", class: "chip", "aria-pressed": String(current === v), text: label, onclick: () => { pick(v); render(); } })));
  const panel = (title, lead, ...kids) => h("section", { class: "panel" }, h("h3", { text: title }), lead ? h("p", { class: "hint", text: lead }) : null, h("div", { class: "fields" }, kids.filter(Boolean)));

  function image(key, label, hint, maxSide, type) {
    const file = h("input", { type: "file", accept: "image/png,image/jpeg,image/webp", hidden: true });
    file.addEventListener("change", async () => {
      const f = file.files?.[0]; if (!f) return;
      try { s[key] = await scaleImage(f, maxSide, type); msg = null; await save({}, "Bild gespeichert."); } catch (e) { msg = { kind: "err", text: e.message }; render(); }
    });
    return h("div", { class: "field" }, h("span", { class: "lbl", text: label }),
      s[key] ? h("img", { class: "ws-img", src: s[key], alt: "" }) : null,
      h("div", { class: "toolbar" }, h("button", { type: "button", class: "btn", onclick: () => file.click() }, icon("upload", 16), s[key] ? "Ändern" : "Hochladen"), file,
        s[key] ? h("button", { type: "button", class: "btn ghost", "aria-label": "Bild entfernen", onclick: () => { s[key] = null; save({}, "Bild entfernt."); } }, "Entfernen") : null),
      h("p", { class: "hint", text: hint }));
  }

  async function useTemplates() {
    if ((s.imprint || s.privacy) && !confirm("Vorhandene Rechtstexte durch die Vorlage ersetzen?")) return;
    try { const t = await api("GET", "/api/site/legal"); s.imprint = t.imprint; s.privacy = t.privacy; msg = { kind: "ok", text: "Vorlage eingesetzt. Bitte die Platzhalter in [eckigen Klammern] ausfüllen." }; } catch (e) { msg = { kind: "err", text: e.message }; }
    render();
  }

  function reviewsEditor() {
    const list = h("div", { class: "fields" }, s.reviews.map((r, i) => h("div", { class: "ws-review" },
      h("input", { class: "input", "aria-label": "Name", placeholder: "Name", value: r.name, oninput: (e) => { r.name = e.target.value; } }),
      h("input", { class: "input", "aria-label": "Rolle oder Firma", placeholder: "Rolle oder Firma (optional)", value: r.role, oninput: (e) => { r.role = e.target.value; } }),
      (() => { const t = h("textarea", { class: "textarea", rows: 3, "aria-label": "Bewertung", placeholder: "Was sagt die Person?", oninput: (e) => { r.text = e.target.value; } }); t.value = r.text; return t; })(),
      h("button", { type: "button", class: "btn ghost", text: "Entfernen", onclick: () => { s.reviews.splice(i, 1); render(); } }))));
    return h("div", { class: "fields" }, list, s.reviews.length < 12 ? h("div", null, h("button", { type: "button", class: "btn", onclick: () => { s.reviews.push({ name: "", role: "", text: "" }); render(); } }, icon("plus", 16), "Bewertung hinzufügen")) : null,
      h("p", { class: "hint", text: "Eingetragene Namen und Zitate müssen echt und mit Einverständnis der Person veröffentlicht sein." }));
  }

  async function checkDomain() {
    try { const r = await api("POST", "/api/site/domain/check", {}); s.domainVerified = r.ok; msg = r.ok ? { kind: "ok", text: "Die Domain ist verbunden." } : { kind: "err", text: r.found.length ? `Der CNAME zeigt auf ${r.found.join(", ")}, erwartet wird ${r.target}.` : `Noch kein CNAME gefunden. DNS-Änderungen können bis zu einigen Stunden dauern.` }; }
    catch (e) { msg = { kind: "err", text: e.message }; }
    render();
  }
  function domainEditor() {
    const inp = h("input", { class: "input", id: "ws_domain", value: s.domain || "", placeholder: "www.deine-agentur.de", autocomplete: "off", spellcheck: "false", "aria-label": "Deine Domain" });
    return h("div", { class: "fields" },
      h("p", { class: "hint", text: "Nimm eine Subdomain wie www.deine-agentur.de oder demo.deine-agentur.de. Deine bestehende Seite bleibt, wo sie ist." }),
      inp, h("div", { class: "toolbar" }, h("button", { type: "button", class: "btn primary", text: "Verbinden", onclick: () => save({ domain: inp.value }, "Domain gespeichert. Richte jetzt den CNAME ein.") }),
        s.domain ? h("button", { type: "button", class: "btn ghost", text: "Entfernen", onclick: () => save({ domain: "" }, "Domain entfernt.") }) : null),
      s.domain ? h("div", { class: "ws-domain" },
        h("div", { class: "toolbar" }, h("strong", { text: s.domain }), h("span", { class: "pill " + (s.domainVerified ? "s-done" : ""), text: s.domainVerified ? "Aktiv" : "Wartet auf DNS" }), h("button", { type: "button", class: "btn", onclick: checkDomain }, icon("check", 16), "Jetzt prüfen")),
        h("h4", { text: "Deine DNS-Daten" }),
        h("p", null, "Typ: ", h("code", { text: "CNAME" }), "  Name: ", h("code", { text: s.domain.split(".")[0] }), "  Ziel: ", h("code", { text: s.cnameTarget || "" })),
        h("p", { class: "hint", text: "Einen A-Record gibt es nicht, die Verbindung läuft über CNAME. Das Zertifikat (https) wird automatisch beim ersten Aufruf ausgestellt. Die Seite muss dafür online sein." })) : null);
  }

  function refine() {
    const d = h("details", { class: "panel ws-refine", open: refineOpen });
    d.addEventListener("toggle", () => { refineOpen = d.open; });
    d.append(h("summary", { text: "Texte feinschleifen" }), h("div", { class: "fields" },
      h("p", { class: "hint", text: "Leer lassen nutzt den Text passend zur Branche." }),
      input("heroTitle", "Überschrift oben"), area("heroSub", "Text darunter", 3), input("ctaHeading", "Überschrift am Ende")));
    return d;
  }

  function statsCard() {
    const v = s.views || { today: 0, d7: 0, d30: 0, series: [] };
    const max = Math.max(1, ...v.series);
    const bars = h("div", { class: "ws-bars", role: "img", "aria-label": `Seitenaufrufe der letzten 30 Tage: ${v.d30}` });
    for (const n of v.series) { const b = h("i", { title: String(n) }); b.style.height = `${Math.max(3, Math.round((n / max) * 100))}%`; bars.append(b); }
    return h("section", { class: "panel" }, h("h3", { text: "Seitenaufrufe" }), h("p", { class: "hint", text: "Letzte 30 Tage, ohne Cookies gezählt." }),
      h("div", { class: "stats" }, [["Heute", v.today], ["7 Tage", v.d7], ["30 Tage", v.d30]].map(([l, n]) => h("div", { class: "stat" }, h("strong", { text: n.toLocaleString("de-DE") }), h("span", { text: l })))),
      bars, h("p", { class: "hint", text: "Gezählt werden Aufrufe, keine Personen. Es werden keine Cookies gesetzt, keine IP-Adressen gespeichert, und offensichtliche Crawler werden herausgefiltert." }));
  }

  function render() {
    if (!s) { root.replaceChildren(h("p", { class: "hint", text: msg?.text || "Lädt …" })); return; }
    const online = s.online;
    const copyBtn = h("button", { type: "button", class: "btn", text: "Link kopieren" });
    copyBtn.addEventListener("click", () => navigator.clipboard?.writeText(s.url).then(() => { copyBtn.textContent = "Kopiert"; }));
    const parts = [
      h("div", { class: "page-head" }, h("div", null, h("span", { class: "eyebrow", text: "Für deine Kunden" }), h("h2", { text: "Deine Website" }), h("p", { class: "hint", text: "Deine eigene Agentur-Seite, damit Kunden sehen, was du anbietest." }))),
      msg ? h("p", { class: `msg ${msg.kind === "err" ? "err" : "ok"}`, role: msg.kind === "err" ? "alert" : "status", text: msg.text }) : null,
      h("section", { class: "panel" },
        h("span", { class: "pill " + (online ? "s-done" : "") , text: online ? "Online" : "Offline" }),
        s.url ? h("p", null, online ? h("a", { href: s.url, target: "_blank", rel: "noopener", text: s.url }) : h("span", { class: "meta", text: s.url })) : null,
        h("div", { class: "toolbar" },
          h("button", { type: "button", class: "btn primary", disabled: busy, onclick: () => save({}, "Gespeichert."), text: "Speichern" }),
          online ? h("button", { type: "button", class: "btn", onclick: () => save({ online: false, ...{} }, "Seite ist offline."), text: "Offline nehmen" })
            : h("button", { type: "button", class: "btn", disabled: busy || s.missing.length > 0, onclick: () => save({ online: true }, "Seite ist online."), text: "Veröffentlichen" }),
          s.url && online ? copyBtn : null),
        !online && s.missing.length ? h("p", { class: "hint", text: `Zum Veröffentlichen fehlt: ${s.missing.join(", ")}.` }) : null,
        h("div", { class: "field" }, h("label", { for: "ws_slug", text: "Adresse deiner Seite" }),
          h("div", { class: "kb-url" }, h("span", { class: "meta", text: `${location.origin}/s/` }), h("input", { class: "input", id: "ws_slug", value: s.slug || "", placeholder: "meine-agentur", autocomplete: "off", spellcheck: "false", oninput: (e) => { s.slug = e.target.value.toLowerCase(); } })))),
      panel("1. Für wen arbeitest du?", "Bestimmt die Texte auf deiner Seite.", choice(NICHE_ORDER.map((k) => [k, s.niches[k]]), s.niche, (v) => { s.niche = v; })),
      panel("2. Dein Stil", null,
        choice([["signature", "Signature"], ["editorial", "Editorial"]], s.style, (v) => { s.style = v; }),
        h("p", { class: "hint", text: s.style === "editorial" ? "Ruhige Serifen-Typografie, Zeilen statt Karten." : "Verläufe und weiche Formen." }),
        choice([["dark", "Dunkel"], ["light", "Hell"]], s.theme, (v) => { s.theme = v; }),
        h("div", { class: "swatches" }, COLORS.map((c) => { const b = h("button", { type: "button", class: "swatch", "aria-label": c, "aria-pressed": String(s.color.toLowerCase() === c), onclick: () => { s.color = c; render(); } }); b.style.background = c; return b; }),
          h("input", { type: "color", "aria-label": "Eigene Farbe", value: s.color, onchange: (e) => { s.color = e.target.value; render(); } })),
        h("label", { class: "check" }, h("input", { type: "checkbox", checked: s.showIntegrations, onchange: (e) => { s.showIntegrations = e.target.checked; } }), h("span", null, h("strong", { text: "Werkzeuge zeigen. " }), "Zeigt, mit welchen Werkzeugen sich der Assistent verbinden lässt.")),
        image("logo", "Dein Logo (optional)", "PNG mit transparentem Hintergrund sieht am besten aus. Wird auf 320 px Breite verkleinert.", 320, "image/png"),
        h("div", { class: "field" }, h("span", { class: "lbl", text: "Größe im Kopf" }), choice([["klein", "Klein"], ["mittel", "Mittel"], ["gross", "Groß"]], s.logoSize, (v) => { s.logoSize = v; }))),
      panel("3. Name und Kontakt", "Ohne E-Mail oder Terminlink kann dich niemand erreichen.",
        h("div", { class: "field" }, h("span", { class: "lbl", text: "Wo sitzt du?" }), choice(Object.entries(s.countries), s.country, (v) => { s.country = v; }), h("p", { class: "hint", text: "Steuert die Entwürfe für Impressum und Datenschutzerklärung." })),
        input("agencyName", "Name deiner Agentur"), input("city", "Ort"), input("email", "E-Mail", { type: "email" }), input("phone", "Telefon", { type: "tel" }),
        input("ctaText", "Text auf dem Knopf", { ph: "Kostenloses Erstgespräch" }), input("bookingUrl", "Terminlink (optional)", { ph: "https://calendly.com/…" })),
      panel("4. Über dich (optional)", "Ohne Text erscheint der Abschnitt gar nicht auf deiner Seite.",
        input("aboutEyebrow", "Kleine Zeile darüber", { ph: "Über mich" }), input("aboutHeading", "Große Überschrift", { hint: "Leer lassen: wird aus deinem Namen gebildet." }), area("aboutText", "Dein Text", 6, "Name, Ort und wofür du stehst: der einzige Ort, an dem Interessenten erfahren, mit wem sie es zu tun haben."),
        image("photo", "Dein Foto (optional)", "Ein Bild von dir wirkt stärker als ein Logo. Wird auf 640 px verkleinert.", 640, "image/jpeg")),
      panel("5. Bewertungen", "Nur echte Stimmen. Ohne Einträge wird der Abschnitt gar nicht angezeigt.", reviewsEditor()),
      panel("6. Dein Bot auf der Seite", "Deine eigene Seite mit deinem eigenen Bot. Die beste Demo, die du zeigen kannst.",
        (() => { const sel = h("select", { class: "input select", id: "ws_agent", "aria-label": "Agent auf der Seite", onchange: (e) => { s.agentId = e.target.value; } }, h("option", { value: "", text: "Kein Bot auf der Seite" }), agents.map((a) => h("option", { value: a.id, text: `${a.name || "Agent"}${a.company ? ` (${a.company})` : ""}` }))); sel.value = s.agentId || ""; return sel; })(),
        h("p", { class: "hint", text: "Der Bot sieht auf deiner Seite so aus wie im Editor: Logo, Farbe, Begrüßung und Schnellantworten kommen von dort." })),
      panel("7. Impressum und Datenschutz", "Pflicht für geschäftliche Websites. Ohne diese Angaben lässt sich nicht veröffentlichen.",
        h("div", { class: "toolbar" }, h("button", { type: "button", class: "btn", onclick: useTemplates, text: "Vorlage einsetzen" })),
        h("div", { class: "note", text: "Die Vorlagen sind Entwürfe und ersetzen keine Rechtsberatung. Prüfe und ergänze sie, vor allem die Platzhalter in [eckigen Klammern]." }),
        area("imprint", "Impressum", 9), area("privacy", "Datenschutzerklärung", 12)),
      panel("8. Eigene Domain (optional)", "Deine Seite ist immer unter der Agentenwerk-Adresse erreichbar. Mit einer eigenen Domain sieht niemand mehr, womit sie gebaut ist.", domainEditor()),
      refine(),
      h("div", { class: "toolbar" }, h("button", { type: "button", class: "btn primary", disabled: busy, onclick: () => save({}, "Gespeichert."), text: "Speichern" })),
      statsCard(),
    ];
    root.replaceChildren(...parts.filter(Boolean));
  }

  return { show: load, hide() {} };
}
