// Login, access request and first-admin setup screens.

export async function renderAuth({ root, h, message = "", onSuccess, onToken }) {
  let state;
  try {
    const r = await fetch("/api/auth/state", { headers: { "x-agentenwerk": "1" } });
    state = await r.json();
    if (!r.ok) throw new Error(state.error || `Fehler ${r.status}`);
  } catch (e) {
    root.replaceChildren(h("div", { class: "auth-card panel" }, h("h2", { text: "Server nicht erreichbar" }), h("p", { class: "hint", text: e.message })));
    return;
  }
  let mode = state.setupNeeded ? "setup" : "login";
  let info = message;
  let twofa = null; // { challenge, email } between password and code

  async function post(path, body, extraHeaders = {}) {
    const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json", "x-agentenwerk": "1", ...extraHeaders }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `Fehler ${r.status}`);
    return j;
  }
  const field = (id, label, type = "text", attrs = {}) => h("div", { class: "field" }, h("label", { for: id, text: label }), h("input", { class: "input", id, type, required: true, ...attrs }));
  const val = (id) => document.getElementById(id)?.value || "";

  function form(title, lead, fields, submitLabel, onSubmit, links = []) {
    const err = h("div", { class: "err-box", role: "alert", hidden: true });
    const btn = h("button", { type: "submit", class: "btn primary big", text: submitLabel });
    const f = h("form", { class: "fields auth-form" }, ...fields, err, btn);
    f.addEventListener("submit", async (e) => {
      e.preventDefault();
      btn.disabled = true; err.hidden = true;
      try { await onSubmit(); } catch (x) { err.textContent = x.message; err.hidden = false; }
      btn.disabled = false;
    });
    return h("div", { class: "auth-card panel" },
      h("h2", { text: title }), lead ? h("p", { class: "hint", text: lead }) : null,
      info ? h("div", { class: "note", text: info }) : null,
      f,
      links.length ? h("div", { class: "auth-links" }, links) : null);
  }
  const link = (text, m) => h("button", { type: "button", class: "linkish", text, onclick: () => { mode = m; info = ""; render(); } });

  function render() {
    let card;
    if (mode === "setup") {
      card = form("Ersten Admin anlegen", "Willkommen! Lege den ersten Zugang an. Er bekommt alle Rechte und kann weitere Nutzer freischalten.", [
        field("su_name", "Name", "text", { autocomplete: "name" }),
        field("su_email", "E-Mail", "email", { autocomplete: "email" }),
        field("su_pw", "Passwort (mindestens 10 Zeichen)", "password", { autocomplete: "new-password", minlength: "10" }),
        state.setupNeedsToken ? field("su_token", "ADMIN_TOKEN aus der .env", "password") : null,
      ].filter(Boolean), "Admin anlegen", async () => {
        await post("/api/auth/setup", { name: val("su_name"), email: val("su_email"), password: val("su_pw") }, state.setupNeedsToken ? { authorization: "Bearer " + val("su_token") } : {});
        onSuccess();
      });
    } else if (mode === "register" && state.plan?.enabled && state.plan.seatsLeft <= 0) {
      card = form("Alle Plätze sind vergeben", `${state.plan.name} startet mit ${state.plan.seats} Kunden, und die sind gerade voll. Trag dich ein, dann melden wir uns, sobald ein Platz frei wird.`, [
        field("wl_name", "Name", "text", { autocomplete: "name" }),
        field("wl_email", "E-Mail", "email", { autocomplete: "email" }),
      ], "Auf die Warteliste", async () => {
        const r = await fetch("/api/public/waitlist", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: val("wl_name"), email: val("wl_email") }) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || "Das hat nicht geklappt.");
        mode = "login"; info = j.message; render();
      }, [link("Ich habe schon einen Zugang", "login")]);
    } else if (mode === "register" && state.plan?.enabled) {
      const p = state.plan;
      const terms = h("input", { type: "checkbox", id: "rg_terms", required: true });
      const termsLabel = h("label", { class: "check", for: "rg_terms" }, terms, h("span", null, "Ich akzeptiere die ",
        p.termsUrl ? h("a", { href: p.termsUrl, target: "_blank", rel: "noopener", text: "AGB" }) : "AGB", " und habe die ",
        p.privacyUrl ? h("a", { href: p.privacyUrl, target: "_blank", rel: "noopener", text: "Datenschutzerklärung" }) : "Datenschutzerklärung", " gelesen."));
      card = form("Abo abschließen", null, [
        h("div", { class: "plan-box" },
          h("div", { class: "plan-box-top" }, h("strong", { text: p.name }), h("span", { class: "pill st-entwurf", text: `noch ${p.seatsLeft} von ${p.seats} Plätzen` })),
          h("p", { class: "plan-price" }, h("b", { text: `${p.price} €` }), " pro Monat, monatlich kündbar"),
          h("ul", { class: "auth-points" },
            h("li", { text: "Agenten aus jeder Website in einer Minute" }),
            h("li", { text: `${p.limits.analyses} Website-Analysen und ${p.limits.chats.toLocaleString("de-DE")} Chat-Nachrichten im Monat` }),
            h("li", { text: "Demo-Seiten, Widget zum Einbinden, Telefon-Bot" }))),
        field("rg_name", "Name", "text", { autocomplete: "name" }),
        field("rg_email", "E-Mail", "email", { autocomplete: "email" }),
        h("div", { class: "field" }, h("label", { for: "rg_company", text: "Firma (optional)" }), h("input", { class: "input", id: "rg_company", autocomplete: "organization" })),
        field("rg_pw", "Passwort (mindestens 10 Zeichen)", "password", { autocomplete: "new-password", minlength: "10" }),
        termsLabel,
        h("p", { class: "hint", text: "Weiter geht es zur sicheren Bezahlung bei Stripe. Danach steht dir alles sofort zur Verfügung." }),
      ], "Zahlungspflichtig abonnieren", async () => {
        const r = await post("/api/auth/register", { name: val("rg_name"), email: val("rg_email"), company: val("rg_company"), password: val("rg_pw"), acceptTerms: document.getElementById("rg_terms").checked });
        if (r.checkoutUrl) location.href = r.checkoutUrl;
      }, [link("Ich habe schon einen Zugang", "login")]);
    } else if (mode === "register") {
      card = form("Zugang beantragen", "Ein Admin prüft deine Anfrage und schaltet dich frei.", [
        field("rg_name", "Name", "text", { autocomplete: "name" }),
        field("rg_email", "E-Mail", "email", { autocomplete: "email" }),
        h("div", { class: "field" }, h("label", { for: "rg_company", text: "Firma (optional)" }), h("input", { class: "input", id: "rg_company", autocomplete: "organization" })),
        field("rg_pw", "Passwort (mindestens 10 Zeichen)", "password", { autocomplete: "new-password", minlength: "10" }),
        h("div", { class: "field" }, h("label", { for: "rg_note", text: "Wofür brauchst du den Zugang? (optional)" }), h("textarea", { class: "textarea", id: "rg_note", rows: 2 })),
      ], "Anfrage senden", async () => {
        const r = await post("/api/auth/register", { name: val("rg_name"), email: val("rg_email"), company: val("rg_company"), password: val("rg_pw"), note: val("rg_note") });
        mode = "login"; info = r.message; render();
      }, [link("Ich habe schon einen Zugang", "login")]);
    } else if (mode === "token") {
      card = form("Mit Admin-Token anmelden", "Für Notfälle und Automationen: der ADMIN_TOKEN aus der .env.", [
        field("tk_token", "ADMIN_TOKEN", "password", { autocomplete: "off" }),
      ], "Anmelden", async () => { onToken(val("tk_token")); }, [link("Zurück zur Anmeldung", "login")]);
    } else if (mode === "twofa" && twofa) {
      card = form("Code eingeben", `Wir haben einen 6-stelligen Code an ${twofa.email} geschickt. Er gilt 10 Minuten.`, [
        field("tf_code", "Code", "text", { inputmode: "numeric", autocomplete: "one-time-code", maxlength: "8", pattern: "[0-9 ]{6,8}" }),
        h("label", { class: "check", for: "tf_trust" }, h("input", { type: "checkbox", id: "tf_trust" }), h("span", { text: "Diesem Gerät 30 Tage vertrauen" })),
      ], "Bestätigen", async () => {
        await post("/api/auth/2fa", { challenge: twofa.challenge, code: val("tf_code"), trust: document.getElementById("tf_trust").checked });
        onSuccess();
      }, [link("Zurück zur Anmeldung", "login")]);
    } else {
      card = form("Anmelden", null, [
        field("li_email", "E-Mail", "email", { autocomplete: "username" }),
        field("li_pw", "Passwort", "password", { autocomplete: "current-password" }),
      ], "Anmelden", async () => {
        const r = await post("/api/auth/login", { email: val("li_email"), password: val("li_pw") });
        if (r.twofa) { twofa = { challenge: r.challenge, email: r.email }; mode = "twofa"; info = ""; render(); return; }
        onSuccess();
      }, [state.signupOpen ? link(state.plan?.enabled ? `Jetzt registrieren · ${state.plan.price} € / Monat` : "Zugang beantragen", "register") : null, state.tokenLogin ? link("Mit Admin-Token", "token") : null].filter(Boolean));
    }
    root.replaceChildren(h("div", { class: "auth" },
      h("div", { class: "auth-hero" },
        h("div", { class: "brand-mark big", "aria-hidden": "true", text: "A" }),
        h("h1", { class: "neon", text: "Agentenwerk" }),
        h("p", { text: "Website-Chatbots bauen, als Demo zeigen und Kunden gewinnen. Mit KI aus der EU." }),
        h("ul", { class: "auth-points" },
          h("li", { text: "Website einlesen, Agent fertig" }),
          h("li", { text: "Autopilot für ganze Listen" }),
          h("li", { text: "Akquise mit Demo-Links" }))),
      card));
    root.querySelector("input")?.focus();
  }
  render();
}
