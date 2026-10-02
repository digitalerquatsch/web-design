// "Konto": profile, password, subscription (pay, manage, cancel), monthly
// usage, and the mentoring that unlocks autopilot and acquisition.

export function mountAccount({ root, api, h, icon, getStatus }) {
  let data = null, message = null, confirmCancel = false;
  const fmtDate = (t) => (t ? new Date(t).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" }) : "");

  async function load() {
    try { data = await api("GET", "/api/account"); } catch (e) { message = { kind: "err", text: e.message }; }
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
