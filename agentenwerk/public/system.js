// "System": everything that used to live in .env, editable in the browser by
// admins. Secrets are write-only: the page shows whether one is set.

export function mountSystem({ root, api, h, icon, onSaved }) {
  let data = null;
  let message = null;

  async function load() {
    try { data = await api("GET", "/api/system"); } catch (e) { message = { kind: "err", text: e.message }; }
    render();
  }

  function field(key, label, opts = {}) {
    const v = data.system[key];
    const id = `sy_${key}`;
    let input;
    if (opts.secret) {
      input = h("input", { class: "input", id, type: "password", autocomplete: "new-password", placeholder: v.set ? `gespeichert (${v.hint}) · neu eingeben zum Ändern` : "noch nicht gesetzt" });
    } else if (opts.options) {
      input = h("select", { class: "input select", id });
      for (const [val, text] of opts.options) input.append(h("option", { value: val, text }));
      input.value = v;
    } else if (opts.bool) {
      input = h("input", { type: "checkbox", id, role: "switch" });
      input.checked = Boolean(v);
      return h("label", { class: "switch", for: id }, input, label);
    } else {
      input = h("input", { class: "input", id, type: opts.type || "text", value: v ?? "", placeholder: opts.ph || "" });
    }
    return h("div", { class: "field" }, h("label", { for: id, text: label }), opts.hint ? h("p", { class: "hint", text: opts.hint }) : null, input,
      opts.secret && v.set ? h("button", { type: "button", class: "linkish small", text: "Entfernen", onclick: () => save({ [key]: null }, "Entfernt.") }) : null);
  }

  function collect(keys) {
    const out = {};
    for (const k of keys) {
      const el = document.getElementById(`sy_${k}`);
      if (!el) continue;
      const v = data.system[k];
      if (v && typeof v === "object" && "set" in v) { if (el.value.trim()) out[k] = el.value.trim(); }
      else if (el.type === "checkbox") out[k] = el.checked;
      else out[k] = el.type === "number" ? Number(el.value) : el.value;
    }
    return out;
  }

  async function save(body, ok = "Gespeichert.") {
    message = null;
    try { const r = await api("PUT", "/api/system", body); data = { ...data, ...r }; message = { kind: "ok", text: ok }; onSaved?.(); } catch (e) { message = { kind: "err", text: e.message }; }
    render();
  }

  function card(title, ic, status, children, keys, extra) {
    return h("section", { class: "panel sys-card" },
      h("div", { class: "sys-head" }, h("span", { class: "stat-ico" }, icon(ic, 20)), h("h3", { text: title }), status ? h("span", { class: "pill " + (status[0] ? "st-interessiert" : "st-entwurf"), text: status[1] }) : null),
      ...children,
      h("div", { class: "toolbar" }, h("button", { type: "button", class: "btn primary", text: "Speichern", onclick: () => save(collect(keys)) }), extra || null));
  }

  function render() {
    if (!data) { root.replaceChildren(message ? h("div", { class: "err-box", text: message.text }) : h("div", { class: "empty", text: "Lade …" })); return; }
    const s = data.system;
    const billingOn = s.stripeSecretKey.set && s.stripeWebhookSecret.set && s.planPrice > 0;
    const phoneOn = s.twilioAccountSid && s.twilioAuthToken.set;
    const copy = (text) => { const b = h("button", { type: "button", class: "btn", text: "Kopieren" }); b.addEventListener("click", () => navigator.clipboard?.writeText(text).then(() => { b.textContent = "Kopiert"; setTimeout(() => (b.textContent = "Kopieren"), 1500); })); return b; };
    root.replaceChildren(...[
      h("div", { class: "page-head" }, h("div", null, h("span", { class: "eyebrow", text: "Nur für Admins" }), h("h2", { text: "System" })),
        h("p", { class: "hint", text: "Alles, was früher in der .env stand. Änderungen wirken sofort, ohne Neustart." })),
      message ? h("div", { class: message.kind === "err" ? "err-box" : "ok-box", role: "status", text: message.text }) : null,
      h("div", { class: "sys-grid" },
        card("Allgemein", "globe", null, [
          field("publicUrl", "Öffentliche Adresse", { type: "url", ph: "https://bots.deine-agentur.de", hint: "Unter dieser Adresse ist der Server im Internet erreichbar. Daraus entstehen Demo-Links, Einbau-Code und Webhooks." }),
          h("div", { class: "row2" }, field("agencyName", "Name deiner Agentur"), field("agencyContact", "Kontakt auf Demo-Seiten", { ph: "hallo@agentur.de" })),
          field("instagram", "Instagram-Name fürs Mentoring", { ph: "deinname", hint: "Abo-Kunden schreiben dir dort, um Autopilot und Akquise freizuschalten." }),
        ], ["publicUrl", "agencyName", "agencyContact", "instagram"]),
        card("KI", "spark", [data.ai, data.ai ? "verbunden" : "fehlt"], [
          field("aiProvider", "Anbieter", { options: [["mistral", "Mistral AI (EU, Paris)"], ["anthropic", "Claude (Anthropic)"]] }),
          field("mistralApiKey", "Mistral API-Schlüssel", { secret: true, hint: "Bekommst du unter console.mistral.ai → API Keys." }),
          field("mistralModel", "Mistral-Modell", { ph: "mistral-medium-latest" }),
          h("details", null, h("summary", { class: "hint", text: "Claude als Alternative" }), field("anthropicApiKey", "Anthropic API-Schlüssel", { secret: true }), field("anthropicModel", "Claude-Modell", { ph: "claude-opus-5-5" })),
        ], ["aiProvider", "mistralApiKey", "mistralModel", "anthropicApiKey", "anthropicModel"]),
        card("E-Mail-Versand", "send", [data.mail, data.mail ? "eingerichtet" : "fehlt"], [
          h("div", { class: "row2" }, field("smtpHost", "SMTP-Server", { ph: "smtp.ionos.de" }), field("smtpPort", "Port", { type: "number", ph: "587" })),
          h("div", { class: "row2" }, field("smtpUser", "Benutzer", { ph: "info@agentur.de" }), field("smtpPass", "Passwort", { secret: true })),
          field("smtpFrom", "Absender", { ph: "Alex Berger <info@agentur.de>" }),
          field("smtpSecure", "SSL/TLS direkt (Port 465)", { bool: true }),
          field("dailyLimit", "Höchstens E-Mails pro Tag (dein Bereich)", { type: "number" }),
        ], ["smtpHost", "smtpPort", "smtpUser", "smtpPass", "smtpFrom", "smtpSecure", "dailyLimit"],
          h("button", { type: "button", class: "btn ghost", text: "Test-E-Mail an mich", onclick: async () => { message = null; try { const r = await api("POST", "/api/system/test-mail"); message = { kind: "ok", text: `Test-E-Mail an ${r.to} gesendet.` }; } catch (e) { message = { kind: "err", text: e.message }; } render(); } })),
        card("Abo & Bezahlung", "shield", [billingOn, billingOn ? "aktiv" : "aus"], [
          h("p", { class: "hint", text: "Mit Stripe registrieren sich Kunden selbst und zahlen monatlich. Ohne Stripe sind Registrierungen Anfragen, die du freischaltest." }),
          h("div", { class: "row2" }, field("planName", "Name des Abos"), field("planPrice", "Preis pro Monat in €", { type: "number" })),
          h("div", { class: "row2" }, field("planSeats", "Plätze insgesamt", { type: "number", hint: "Danach kommt die Warteliste." }), field("planDailyEmails", "E-Mails pro Tag je Kunde", { type: "number" })),
          h("div", { class: "row2" }, field("planMonthlyAnalyses", "Website-Analysen pro Monat", { type: "number" }), field("planMonthlyChats", "Chat-Nachrichten pro Monat", { type: "number" })),
          field("stripeSecretKey", "Stripe Secret Key", { secret: true, hint: "dashboard.stripe.com → Entwickler → API-Schlüssel (sk_live_… oder zum Testen sk_test_…)." }),
          field("stripeWebhookSecret", "Stripe Webhook-Signaturschlüssel", { secret: true, hint: "Lege in Stripe einen Webhook auf die Adresse unten an, mit den Ereignissen checkout.session.completed und customer.subscription.*." }),
          h("div", { class: "copyrow" }, h("code", { class: "code", text: data.webhookUrl }), copy(data.webhookUrl)),
          h("div", { class: "row2" }, field("termsUrl", "AGB", { type: "url" }), field("privacyUrl", "Datenschutzerklärung", { type: "url" })),
          field("imprintUrl", "Impressum", { type: "url" }),
        ], ["planName", "planPrice", "planSeats", "planDailyEmails", "planMonthlyAnalyses", "planMonthlyChats", "stripeSecretKey", "stripeWebhookSecret", "termsUrl", "privacyUrl", "imprintUrl"]),
        card("Telefon-Bot", "chat", [phoneOn, phoneOn ? "aktiv" : "aus"], [
          h("p", { class: "hint", text: "Anrufe laufen über eine Telefonnummer bei Twilio. Twilio wandelt Sprache in Text, dein Agent antwortet, Twilio liest die Antwort vor." }),
          field("twilioAccountSid", "Twilio Account SID", { ph: "AC…" }),
          field("twilioAuthToken", "Twilio Auth Token", { secret: true }),
          field("twilioVoice", "Stimme", { options: [["Polly.Vicki-Neural", "Vicki (weiblich, natürlich)"], ["Polly.Daniel-Neural", "Daniel (männlich, natürlich)"], ["Google.de-DE-Neural2-F", "Google, weiblich"], ["Google.de-DE-Neural2-B", "Google, männlich"]] }),
          h("p", { class: "hint", text: "Die Webhook-Adresse pro Agent steht im Editor unter „Telefon“." }),
        ], ["twilioAccountSid", "twilioAuthToken", "twilioVoice"])),
    ].filter(Boolean));
  }

  return { show: load, hide() {} };
}
