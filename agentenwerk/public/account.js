// "Konto": profile, password, subscription (pay, manage, cancel), monthly
// usage, and the mentoring that unlocks autopilot and acquisition.

export function mountAccount({ root, api, h, icon, getStatus }) {
  let data = null, message = null, confirmCancel = false;
  const fmtDate = (t) => (t ? new Date(t).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" }) : "");

  async function load() {
    try { data = await api("GET", "/api/account"); await loadSupport(); } catch (e) { message = { kind: "err", text: e.message }; }
    render();
  }
  async function go(action) {
    message = null;
    try {
      const r = await api("POST", `/api/billing/${action}`);
      if (r.url) { location.href = r.url; return; }
      message = { kind: "ok", text: action === "cancel" ? "Gekündigt. Dein Zugang läuft bis zum Ende des bezahlten Monats." : "Die Kündigung ist zurückgenommen." };
    } catch (e) { message = { kind: "err", text: e.message }; }
    confirmCancel = false;
    await load();
  }

  function meter(label, used, limit) {
    const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : 0;
    return h("div", { class: "meter" },
      h("div", { class: "meter-top" }, h("span", { text: label }), h("b", { text: limit ? `${used.toLocaleString("de-DE")} / ${limit.toLocaleString("de-DE")}` : used.toLocaleString("de-DE") })),
      limit ? h("div", { class: "pbar" }, h("span", { class: pct >= 90 ? "bad" : "ok", style: `width:${pct}%` })) : null);
  }

  function billingCard() {
    const b = data.billing, plan = data.plan;
    const active = b && ["active", "trialing", "past_due"].includes(b.status);
    const label = !b ? "Kein Abo" : b.status === "checkout" ? "Bezahlung offen" : b.status === "past_due" ? "Zahlung fehlgeschlagen" : active ? (b.cancelAtPeriodEnd ? `Gekündigt zum ${fmtDate(b.periodEnd)}` : "Aktiv") : "Beendet";
    const actions = h("div", { class: "toolbar" });
    if (!active) actions.append(h("button", { type: "button", class: "btn primary big", disabled: !plan.enabled || null, onclick: () => go("checkout") }, `Jetzt abonnieren · ${plan.price} € / Monat`));
    else {
      actions.append(h("button", { type: "button", class: "btn", onclick: () => go("portal") }, "Zahlungsdaten & Rechnungen"));
      if (b.cancelAtPeriodEnd) actions.append(h("button", { type: "button", class: "btn primary", onclick: () => go("resume") }, "Kündigung zurücknehmen"));
      else if (confirmCancel) actions.append(h("span", { class: "confirm" }, h("span", { text: `Abo zum ${fmtDate(b.periodEnd) || "Ende des Monats"} kündigen?` }),
        h("button", { type: "button", class: "btn danger", text: "Ja, kündigen", onclick: () => go("cancel") }),
        h("button", { type: "button", class: "btn ghost", text: "Abbrechen", onclick: () => { confirmCancel = false; render(); } })));
      else actions.append(h("button", { type: "button", class: "btn ghost danger", text: "Abo kündigen", onclick: () => { confirmCancel = true; render(); } }));
    }
    return h("section", { class: "panel acc-card plan-card" },
      h("div", { class: "sys-head" }, h("span", { class: "stat-ico" }, icon("shield", 20)), h("h3", { text: plan.name }), h("span", { class: "pill " + (active && !b.cancelAtPeriodEnd ? "st-interessiert" : "st-entwurf"), text: label })),
      h("p", { class: "plan-price" }, h("b", { text: `${plan.price} €` }), " pro Monat, monatlich kündbar"),
      active && b.periodEnd && !b.cancelAtPeriodEnd ? h("p", { class: "hint", text: `Nächste Abbuchung am ${fmtDate(b.periodEnd)}.` }) : null,
      b?.status === "checkout" ? h("p", { class: "hint", text: "Du hast dich registriert, die Bezahlung ist aber noch nicht abgeschlossen. Danach steht dir alles sofort zur Verfügung." }) : null,
      !plan.enabled ? h("p", { class: "hint", text: "Die Online-Bezahlung ist noch nicht eingerichtet." }) : null,
      actions);
  }

  function mentoringCard() {
    const m = data.mentoring;
    return h("section", { class: "panel acc-card mentor" },
      h("div", { class: "sys-head" }, h("span", { class: "stat-ico" }, icon("users", 20)), h("h3", { text: "1:1 Mentoring" }), h("span", { class: "pill " + (data.autopilotAllowed ? "st-interessiert" : "st-entwurf"), text: data.autopilotAllowed ? "Autopilot frei" : "Autopilot gesperrt" })),
      h("p", { text: data.autopilotAllowed ? "Autopilot und Akquise sind für dich freigeschaltet." : "Autopilot und Akquise gibt es zusammen mit dem 1:1 Mentoring. Schreib mir auf Instagram: Ich schau mir deine Situation an und schalte dich frei, wenn es passt." }),
      m.url ? h("a", { class: "btn primary big insta", href: m.url, target: "_blank", rel: "noopener" }, icon("chat", 18), `@${m.instagram} auf Instagram schreiben`) : h("p", { class: "hint", text: "Instagram-Name ist noch nicht hinterlegt." }));
  }

  const real = () => !["token", "local"].includes(data.me.id);
  let tf = null; // { challenge } while a code is expected
  let support = null;
  async function loadSupport() { try { support = await api("GET", "/api/account/support"); } catch { support = null; } }
  const say = (kind, text) => { message = { kind, text }; };

  function twofaCard() {
    const me = data.me;
    const body = [];
    if (me.twofaEnabled) {
      const pw = h("input", { class: "input", type: "password", placeholder: "Passwort zum Ausschalten", autocomplete: "current-password", "aria-label": "Passwort" });
      body.push(h("span", { class: "pill s-done", text: "Aktiv" }), h("div", { class: "toolbar" }, pw, h("button", { type: "button", class: "btn ghost", text: "Ausschalten", onclick: async () => { try { await api("POST", "/api/account/2fa/disable", { password: pw.value }); say("ok", "Zwei-Faktor-Anmeldung ist aus."); await load(); } catch (e) { say("err", e.message); render(); } } })));
    } else if (tf) {
      const code = h("input", { class: "input", inputmode: "numeric", autocomplete: "one-time-code", placeholder: "6-stelliger Code", "aria-label": "Code", maxlength: "8" });
      body.push(h("p", { class: "hint", text: "Wir haben dir einen Code per E-Mail geschickt." }), h("div", { class: "toolbar" }, code, h("button", { type: "button", class: "btn primary", text: "Bestätigen", onclick: async () => { try { await api("POST", "/api/account/2fa/confirm", { challenge: tf.challenge, code: code.value }); tf = null; say("ok", "Zwei-Faktor-Anmeldung ist an."); await load(); } catch (e) { say("err", e.message); render(); } } })));
    } else {
      body.push(h("div", { class: "toolbar" }, h("span", { class: "pill", text: "Nicht aktiv" }), h("button", { type: "button", class: "btn primary", onclick: async () => { try { tf = await api("POST", "/api/account/2fa/start", {}); message = null; } catch (e) { say("err", e.message); } render(); } }, icon("shield", 16), "Einschalten")));
    }
    return h("section", { class: "panel acc-card" }, h("div", { class: "sys-head" }, h("span", { class: "stat-ico" }, icon("lock", 20)), h("h3", { text: "Zwei-Faktor-Anmeldung" })),
      h("p", { class: "hint", text: "Nach dem Passwort schicken wir dir zusätzlich einen Code per E-Mail. Wer dein Passwort kennt, kommt damit trotzdem nicht in dein Konto. Ein Gerät, dem du vertraust, fragt 30 Tage lang nicht erneut." }), ...body);
  }

  function supportCard() {
    const on = support?.until > Date.now();
    return h("section", { class: "panel acc-card" }, h("div", { class: "sys-head" }, h("span", { class: "stat-ico" }, icon("users", 20)), h("h3", { text: "Support-Zugriff" })),
      h("p", { class: "hint", text: "Wenn du Hilfe brauchst, kannst du dem Support für 48 Stunden Zugang zu deinem Konto geben. Er sieht dann deine Agenten und Einstellungen und kann dir direkt helfen. Deine Abrechnung bleibt gesperrt, gelöscht werden kann nichts, und jeder Zugriff wird protokolliert. Du kannst die Freigabe jederzeit sofort beenden." }),
      on ? h("p", { class: "hint", text: `Freigegeben bis ${new Date(support.until).toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" })}.` }) : null,
      h("div", { class: "toolbar" }, h("button", { type: "button", class: on ? "btn danger" : "btn primary", text: on ? "Freigabe beenden" : "Support-Zugriff für 48 Stunden erlauben", onclick: async () => { try { await api("POST", "/api/account/support", { on: !on }); } catch (e) { say("err", e.message); } await loadSupport(); render(); } })),
      support?.log?.length ? h("div", null, h("h4", { text: "Zugriffsprotokoll" }), h("ul", { class: "plain" }, support.log.slice(0, 12).map((l) => h("li", { class: "meta", text: `${new Date(l.at).toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" })} · ${l.adminName} · ${l.method} ${l.path}` })))) : null);
  }

  function render() {
    if (!data) { root.replaceChildren(message ? h("div", { class: "err-box", text: message.text }) : h("div", { class: "empty", text: "Lade …" })); return; }
    const me = data.me;
    const isAbo = me.role === "abo";
    const pw = h("form", { class: "fields", style: "gap:10px" },
      h("input", { class: "input", id: "acPwCur", type: "password", placeholder: "Aktuelles Passwort", autocomplete: "current-password", required: true }),
      h("input", { class: "input", id: "acPwNew", type: "password", placeholder: "Neues Passwort (mind. 10 Zeichen)", autocomplete: "new-password", minlength: "10", required: true }),
      h("button", { type: "submit", class: "btn", text: "Passwort ändern" }));
    pw.addEventListener("submit", async (e) => {
      e.preventDefault();
      try { await api("POST", "/api/auth/password", { current: document.getElementById("acPwCur").value, next: document.getElementById("acPwNew").value }); message = { kind: "ok", text: "Passwort geändert." }; } catch (x) { message = { kind: "err", text: x.message }; }
      render();
    });
    const u = data.usage;
    root.replaceChildren(...[
      h("div", { class: "page-head" }, h("div", null, h("span", { class: "eyebrow", text: "Dein Zugang" }), h("h2", { text: "Konto" }))),
      message ? h("div", { class: message.kind === "err" ? "err-box" : "ok-box", role: "status", text: message.text }) : null,
      h("div", { class: "acc-grid" },
        isAbo ? billingCard() : null,
        isAbo ? mentoringCard() : null,
        real() ? twofaCard() : null,
        real() ? supportCard() : null,
        h("section", { class: "panel acc-card" },
          h("div", { class: "sys-head" }, h("span", { class: "avatar" , text: String(me.name || "?").split(/\s+/).map((x) => x[0]).join("").slice(0, 2).toUpperCase() }), h("div", null, h("h3", { text: me.name }), h("span", { class: "meta", text: me.email }))),
          h("p", { class: "hint", text: `Rolle: ${{ admin: "Admin", team: "Team", abo: "Abo", kunde: "Kunde" }[me.role] || me.role}${me.company ? ` · ${me.company}` : ""}` }), pw),
        h("section", { class: "panel acc-card" },
          h("div", { class: "sys-head" }, h("span", { class: "stat-ico" }, icon("trend", 20)), h("h3", { text: "Verbrauch diesen Monat" })),
          meter("Website-Analysen", u.analyses, u.limits?.analyses),
          meter("Chat-Nachrichten (Web und Telefon)", u.chats, u.limits?.chats),
          u.limits ? h("p", { class: "hint", text: `Dazu bis zu ${data.plan.limits.emailsPerDay} Akquise-E-Mails pro Tag. Das Kontingent beginnt jeden Monat neu.` }) : h("p", { class: "hint", text: "Für deinen Zugang gibt es keine Obergrenze." }))),
    ].filter(Boolean));
  }

  return { show: load, hide() {} };
}

export function mountMentoring({ root, h, icon, getStatus }) {
  function render() {
    const s = getStatus();
    const ok = s.me?.autopilotAllowed;
    root.replaceChildren(h("section", { class: "panel mentor-hero" },
      h("span", { class: "next-ico" }, icon(ok ? "check" : "rocket", 28)),
      h("span", { class: "eyebrow", text: "1:1 Mentoring" }),
      h("h2", { text: ok ? "Autopilot und Akquise sind frei" : "Du hast die Technik drauf, jetzt fehlen die Kunden" }),
      h("p", { text: ok
        ? "Leg im Autopiloten deine erste Liste an. Für jeden Betrieb entsteht ein Agent mit Demo, und in der Akquise gehst du sie einzeln durch."
        : "Der Akquise-Autopilot ist Teil des 1:1 Mentorings. Schreib mir auf Instagram. Ich schau mir deine Situation an und sag dir in 15 Minuten ehrlich, ob eine Zusammenarbeit passt. Danach schalte ich Autopilot und Akquise für dich frei." }),
      h("ul", { class: "auth-points" },
        h("li", { text: "Liste hochladen: Agent und Demo für jeden Betrieb" }),
        h("li", { text: "E-Mails mit Beispiel-Chat, einzeln prüfen und senden" }),
        h("li", { text: "Sehen, wer die Demo geöffnet hat, und gezielt nachfassen" })),
      ok ? null : s.mentoring?.url
        ? h("a", { class: "btn primary big wide insta", href: s.mentoring.url, target: "_blank", rel: "noopener" }, icon("chat", 18), `Auf Instagram schreiben (@${s.mentoring.instagram})`)
        : h("p", { class: "hint", text: "Der Instagram-Name ist noch nicht hinterlegt." })));
  }
  return { show: render, hide() {} };
}
