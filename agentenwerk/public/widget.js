/* Agentenwerk chat widget.
 * Embed:  <script src="https://DEIN-SERVER/widget.js" data-agent="AGENT_ID" defer></script>
 * Renders into a shadow root so the host page's CSS cannot reach it,
 * and never inserts HTML: every message is set as text. */
(function () {
  "use strict";
  var script = document.currentScript || document.querySelector("script[data-agent][src*='widget.js']");
  if (!script) return;
  var agentId = script.getAttribute("data-agent");
  if (!agentId || window["__agentenwerk_" + agentId]) return;
  window["__agentenwerk_" + agentId] = true;
  var api = new URL(script.src, location.href).origin + "/api/public/agents/" + encodeURIComponent(agentId);
  var convKey = "agentenwerk.conv." + agentId;

  function store(k, v) {
    try { if (v === undefined) return sessionStorage.getItem(k); if (v === null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, v); } catch (e) { return null; }
  }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function inkFor(hex) {
    var n = parseInt(hex.slice(1), 16), r = n >> 16 & 255, g = n >> 8 & 255, b = n & 255;
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.6 ? "#111111" : "#ffffff";
  }

  var CSS = [
    ":host{all:initial}",
    "*{box-sizing:border-box;font-family:system-ui,-apple-system,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif}",
    ".root{--pb:#ffffff;--bb:#f4f5f7;--card:#ffffff;--ln:#e3e5e9;--tx:#16181d;--mu:#6b7280;position:fixed;bottom:20px;z-index:2147483000;display:flex;flex-direction:column;align-items:flex-end;gap:12px}",
    ".root.dark{--pb:#14161b;--bb:#1b1e25;--card:#232731;--ln:#2e3340;--tx:#eef0f4;--mu:#9aa1ae}",
    ".root.left{left:20px;align-items:flex-start}.root.right{right:20px}",
    ".launcher{width:58px;height:58px;border-radius:50%;border:0;background:var(--w);color:var(--wi);box-shadow:0 6px 20px rgba(0,0,0,.22);cursor:pointer;display:grid;place-items:center;transition:transform .15s}",
    ".launcher:hover{transform:scale(1.05)}.launcher:focus-visible,button:focus-visible,input:focus-visible{outline:3px solid var(--w);outline-offset:2px}",
    ".launcher svg{width:26px;height:26px}",
    ".panel{width:380px;max-width:calc(100vw - 40px);height:600px;max-height:calc(100vh - 110px);background:var(--pb);color:var(--tx);border-radius:18px;box-shadow:0 12px 40px rgba(0,0,0,.28);display:flex;flex-direction:column;overflow:hidden}",
    ".panel[hidden]{display:none}",
    ".head{background:var(--w);color:var(--wi);padding:12px 12px 12px 14px;display:flex;align-items:center;gap:11px}",
    ".av{width:38px;height:38px;border-radius:50%;background:rgba(255,255,255,.22);display:grid;place-items:center;font-weight:700;font-size:14px;flex:none}",
    ".logo{height:36px;max-width:92px;object-fit:contain;background:#fff;border-radius:8px;padding:3px 5px;flex:none}",
    ".title{display:flex;flex-direction:column;min-width:0;margin-right:auto}.title b{font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
    ".title span{font-size:12px;opacity:.9;display:flex;align-items:center;gap:5px}.title span:before{content:'';width:7px;height:7px;border-radius:50%;background:#4ade80}",
    ".icon{background:none;border:0;color:inherit;opacity:.85;cursor:pointer;width:32px;height:32px;border-radius:8px;font-size:20px;line-height:1}.icon:hover{opacity:1;background:rgba(255,255,255,.15)}",
    ".ai{font-size:12px;color:var(--mu);text-align:center;padding:7px 10px;border-bottom:1px solid var(--ln);background:var(--bb)}",
    ".body{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:9px;background:var(--bb)}",
    ".welcome{display:flex;flex-direction:column;align-items:center;text-align:center;gap:14px;padding:10px 4px}",
    ".wlogo{width:72px;height:72px;border-radius:50%;background:#fff;object-fit:contain;padding:8px;box-shadow:0 2px 10px rgba(0,0,0,.08)}",
    ".wav{width:64px;height:64px;border-radius:50%;background:var(--w);color:var(--wi);display:grid;place-items:center;font-weight:700;font-size:22px}",
    ".wtext{font-size:16px;font-weight:600;line-height:1.45;color:var(--tx);white-space:pre-wrap;overflow-wrap:anywhere}",
    ".qlist{display:flex;flex-direction:column;gap:8px;width:100%}",
    ".qlist button{display:flex;justify-content:space-between;align-items:center;gap:10px;width:100%;text-align:left;border:1px solid var(--ln);background:var(--card);color:var(--tx);border-radius:12px;padding:12px 14px;font-size:14px;cursor:pointer}",
    ".qlist button:hover{border-color:var(--w)}.qlist button:after{content:'\\203A';color:var(--w);font-size:20px;line-height:1}",
    ".msg{max-width:85%;padding:9px 12px;border-radius:14px;font-size:14px;line-height:1.5;white-space:pre-wrap;overflow-wrap:anywhere}",
    ".bot{background:var(--card);color:var(--tx);border:1px solid var(--ln);border-bottom-left-radius:4px;align-self:flex-start}",
    ".user{background:var(--w);color:var(--wi);border-bottom-right-radius:4px;align-self:flex-end}",
    ".typing{color:var(--mu);font-style:italic}",
    ".err{background:#fdecee;color:#a1202c;align-self:stretch;max-width:none;font-size:13px}",
    ".ok{align-self:center;font-size:12px;background:#e3f4ea;color:#1c6b43;padding:3px 10px;border-radius:999px}",
    "form{display:flex;gap:8px;padding:10px;border-top:1px solid var(--ln);background:var(--pb)}",
    "input{flex:1;min-width:0;border:1px solid var(--ln);border-radius:999px;padding:10px 14px;font-size:14px;color:var(--tx);background:var(--bb)}",
    "form button{border:0;background:var(--w);color:var(--wi);border-radius:999px;padding:0 16px;font-weight:600;font-size:14px;cursor:pointer}",
    "form button:disabled{opacity:.5;cursor:default}",
    ".foot{font-size:11px;color:var(--mu);text-align:center;padding:0 10px 8px;background:var(--pb)}.foot a{color:inherit}",
    "@media (max-width:480px){.root{bottom:12px}.root.right{right:12px}.root.left{left:12px}.panel{position:fixed;inset:0;width:100vw;max-width:none;height:100%;max-height:none;border-radius:0}}",
    "@media (prefers-reduced-motion:reduce){.launcher{transition:none}}",
  ].join("");

  function start(cfg) {
    var host = document.createElement("div");
    host.setAttribute("data-agentenwerk", agentId);
    var shadow = host.attachShadow({ mode: "open" });
    var style = el("style"); style.textContent = CSS; shadow.appendChild(style);
    var root = el("div", "root " + (cfg.position === "left" ? "left" : "right") + (cfg.theme === "dark" ? " dark" : ""));
    root.style.setProperty("--w", cfg.color);
    root.style.setProperty("--wi", inkFor(cfg.color));

    var panel = el("div", "panel"); panel.hidden = true;
    panel.setAttribute("role", "dialog"); panel.setAttribute("aria-label", "Chat mit " + (cfg.name || "Assistent"));
    var head = el("div", "head");
    var initials = (cfg.initials || (cfg.name || "A").slice(0, 2)).toUpperCase();
    function logoOr(cls, fallbackCls) {
      var fallback = el("div", fallbackCls, initials);
      if (!cfg.logoUrl) return fallback;
      var img = el("img", cls); img.alt = cfg.company || ""; img.src = cfg.logoUrl; img.referrerPolicy = "no-referrer";
      img.addEventListener("error", function () { if (img.parentNode) img.parentNode.replaceChild(fallback, img); });
      return img;
    }
    head.appendChild(logoOr("logo", "av"));
    var title = el("div", "title");
    title.appendChild(el("b", null, cfg.title || (cfg.name + (cfg.company ? " · " + cfg.company : ""))));
    title.appendChild(el("span", null, "Antwortet sofort"));
    head.appendChild(title);
    var restart = el("button", "icon", "↺"); restart.type = "button"; restart.title = "Neue Unterhaltung"; restart.setAttribute("aria-label", "Neue Unterhaltung");
    var close = el("button", "icon", "×"); close.type = "button"; close.setAttribute("aria-label", "Chat schließen");
    head.appendChild(restart); head.appendChild(close);
    var body = el("div", "body"); body.setAttribute("aria-live", "polite");
    var form = el("form");
    var input = el("input"); input.type = "text"; input.maxLength = 2000; input.placeholder = "Nachricht schreiben …"; input.setAttribute("aria-label", "Nachricht");
    var sendBtn = el("button", null, "Senden"); sendBtn.type = "submit";
    form.appendChild(input); form.appendChild(sendBtn);
    var foot = el("div", "foot");
    foot.appendChild(document.createTextNode("KI-Assistent · Antworten können Fehler enthalten"));
    if (cfg.privacyUrl) {
      foot.appendChild(document.createTextNode(" · "));
      var a = el("a", null, "Datenschutz"); a.href = cfg.privacyUrl; a.target = "_blank"; a.rel = "noopener";
      foot.appendChild(a);
    }
    // Transparency: visitors must know they are talking to an AI (EU AI Act, Art. 50).
    var notice = el("div", "ai", "Sie schreiben mit einem KI-Assistenten");
    panel.appendChild(head); panel.appendChild(notice); panel.appendChild(body); panel.appendChild(form); panel.appendChild(foot);

    var launcher = el("button", "launcher"); launcher.type = "button"; launcher.setAttribute("aria-label", "Chat öffnen");
    launcher.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/></svg>'; // static icon, no user content
    root.appendChild(panel); root.appendChild(launcher);
    shadow.appendChild(root);
    document.body.appendChild(host);

    var busy = false, started = false;
    function scroll() { body.scrollTop = body.scrollHeight; }
    function bubble(cls, text) { var b = el("div", "msg " + cls, text); body.appendChild(b); scroll(); return b; }
    // Before the first message: logo, welcome text and the suggested questions as a list.
    function showWelcome() {
      started = false;
      while (body.firstChild) body.removeChild(body.firstChild);
      var w = el("div", "welcome");
      w.appendChild(logoOr("wlogo", "wav"));
      w.appendChild(el("div", "wtext", cfg.welcome || "Hallo! Wie kann ich helfen?"));
      var list = el("div", "qlist");
      (cfg.quickReplies || []).forEach(function (q) {
        var b = el("button", null, q); b.type = "button";
        b.addEventListener("click", function () { send(q); });
        list.appendChild(b);
      });
      if (list.firstChild) w.appendChild(list);
      body.appendChild(w);
    }
    function reset() { store(convKey, null); showWelcome(); input.focus(); }
    function toggle(open) {
      panel.hidden = !open;
      launcher.setAttribute("aria-label", open ? "Chat schließen" : "Chat öffnen");
      if (open) { input.focus(); scroll(); } else launcher.focus();
    }

    function send(text) {
      if (busy || !text) return;
      busy = true; sendBtn.disabled = true;
      if (!started) {
        started = true;
        while (body.firstChild) body.removeChild(body.firstChild);
        bubble("bot", cfg.welcome || "Hallo! Wie kann ich helfen?");
      }
      bubble("user", text);
      var out = bubble("bot typing", "schreibt …");
      var got = "";
      fetch(api + "/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: text, conversationId: store(convKey) || undefined }),
      }).then(function (res) {
        if (!res.ok || !res.body) {
          return res.json().catch(function () { return {}; }).then(function (j) { throw new Error(j.error || "Der Chat ist gerade nicht erreichbar."); });
        }
        var reader = res.body.getReader(), dec = new TextDecoder(), buf = "";
        function handle(name, data) {
          if (name === "conversation") store(convKey, data.id);
          else if (name === "text") { got += data.delta; out.className = "msg bot"; out.textContent = got; scroll(); }
          else if (name === "replace") { got = data.text; out.className = "msg bot"; out.textContent = got; }
          else if (name === "captured") { var ok = el("div", "ok", data.type === "termin" ? "Terminanfrage übermittelt" : "Kontaktdaten übermittelt"); body.insertBefore(ok, out.nextSibling); scroll(); }
          else if (name === "error") throw new Error(data.message);
        }
        function pump() {
          return reader.read().then(function (r) {
            if (r.done) return;
            buf += dec.decode(r.value, { stream: true });
            var parts = buf.split("\n\n"); buf = parts.pop();
            parts.forEach(function (chunk) {
              var name = "message", data = "";
              chunk.split("\n").forEach(function (line) {
                if (line.indexOf("event: ") === 0) name = line.slice(7);
                else if (line.indexOf("data: ") === 0) data += line.slice(6);
              });
              if (data) handle(name, JSON.parse(data));
            });
            return pump();
          });
        }
        return pump();
      }).then(function () {
        if (!got.trim()) { out.className = "msg bot"; out.textContent = "…"; }
      }).catch(function (e) {
        if (!got) out.remove();
        bubble("err", e.message || "Der Chat ist gerade nicht erreichbar.");
      }).then(function () {
        busy = false; sendBtn.disabled = false; input.focus();
      });
    }

    launcher.addEventListener("click", function () { toggle(panel.hidden); });
    close.addEventListener("click", function () { toggle(false); });
    restart.addEventListener("click", reset);
    form.addEventListener("submit", function (e) { e.preventDefault(); var v = input.value.trim(); input.value = ""; send(v); });
    panel.addEventListener("keydown", function (e) { if (e.key === "Escape") toggle(false); });
    showWelcome();
    // data-open="1" opens the chat by itself (used by the demo pages), not on phones.
    var auto = script.getAttribute("data-open");
    if (auto === "force" || (auto === "1" && window.matchMedia("(min-width: 641px)").matches)) setTimeout(function () { if (panel.hidden) { panel.hidden = false; launcher.setAttribute("aria-label", "Chat schließen"); } }, auto === "force" ? 50 : 1200);
  }

  fetch(api).then(function (r) { return r.ok ? r.json() : null; }).then(function (cfg) {
    if (!cfg) return;
    if (document.body) start(cfg); else document.addEventListener("DOMContentLoaded", function () { start(cfg); });
  }).catch(function () { /* agent unavailable: show nothing */ });
})();
