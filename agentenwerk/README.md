# Agentenwerk

Ein No-Code-Builder für Website-Chatbots. Du gibst deine Website-Adresse ein. Agentenwerk liest die wichtigsten Seiten und richtet daraus einen Chat-Assistenten ein, inklusive passender Fragen für deine Besucher. Den Assistenten kannst du anpassen und testen. Danach baust du ihn mit einer Zeile Code in deine Website ein.

## Was es kann

- **Website einlesen:** Startseite plus bis zu 7 Unterseiten (Kontakt, Impressum, Leistungen, Preise, FAQ, Über uns). Daraus entstehen Firmenwissen, Öffnungszeiten, Leistungen, 6–10 FAQ mit Antworten, Einstiegsfragen als Buttons, Begrüßung, Markenfarbe und Link zur Datenschutzerklärung. Was auf der Website fehlt, wird als Hinweis angezeigt.
- **Konfigurieren in 8 Schritten:** Grundlagen, Persönlichkeit, Wissen, Ziel & Aktionen, Regeln, Widget, System-Prompt, Einbinden. Dazu 6 Vorlagen (Terminbuchung, Kundenservice, Lead-Qualifizierung, Produktberatung, Tischreservierung, Leer).
- **Testchat** im Builder mit dem aktuellen Stand, auch vor dem Speichern.
- **Aktionen im Gespräch:** Der Agent speichert Leads (`save_lead`) und Terminanfragen (`book_appointment`). Beides erscheint im Builder unter „Erfasst“, zusammen mit den Gesprächsverläufen.
- **Widget zum Einbinden:** ein Script-Tag, Darstellung im Shadow DOM (die CSS deiner Seite stört nicht), mobil im Vollbild. Optional nur für freigegebene Domains.

## Starten

Voraussetzung ist Node.js 20.12 oder neuer.

```bash
cd agentenwerk
npm install
cp .env.example .env      # ANTHROPIC_API_KEY eintragen
npm start                 # http://localhost:3000
```

Ohne API-Key startet der Builder trotzdem. Website-Analyse und Chat antworten aber erst, wenn ein Key eingetragen ist.

## Einbinden

Unter **Einbinden** findest du den Code für deine Website:

```html
<script src="https://bots.deine-firma.de/widget.js" data-agent="AGENT_ID" defer></script>
```

Damit Besucher chatten können, muss der Server öffentlich erreichbar sein. Dafür brauchst du:

1. einen Server oder Hoster mit Node.js (zum Beispiel Hetzner, netcup, Render oder Fly.io; für EU-Hosting einen Anbieter mit Rechenzentrum in der EU),
2. davor einen Reverse-Proxy mit HTTPS (Caddy oder nginx),
3. in der `.env`: `HOST=0.0.0.0`, `ADMIN_TOKEN` (ein langes Zufallspasswort) und `PUBLIC_URL`.

Trage unter **Erlaubte Websites** deine Domain ein. Dann lässt sich dein Agent nicht auf fremden Seiten einbinden.

## Konfiguration (`.env`)

| Variable | Bedeutung |
|---|---|
| `ANTHROPIC_API_KEY` | Pflicht für Analyse und Chat |
| `AGENT_MODEL` | Modell, Standard `claude-opus-5-5` |
| `PORT`, `HOST` | Standard `3000`, `127.0.0.1` |
| `ADMIN_TOKEN` | Schützt Builder und Verwaltungs-API. Ohne Token ist der Builder nur über `localhost` erreichbar |
| `PUBLIC_URL` | Öffentliche Adresse für den Einbau-Code |
| `DATA_DIR` | Speicherort für Agenten, Leads und Gespräche, Standard `./data` |

## Sicherheit und Datenschutz

- **Verwaltung:** Admin-Anfragen brauchen den Header `X-Agentenwerk`, den Browser nur nach einem CORS-Preflight senden, den der Server nie erlaubt. Fremde Websites können die API also nicht über den Browser deiner Besucher fernsteuern. Mit `ADMIN_TOKEN` ist zusätzlich ein Bearer-Token Pflicht.
- **Website-Abruf:** Der Crawler ruft nur öffentliche Adressen ab. Jede Weiterleitung wird einzeln geprüft, damit ein Link nicht auf `localhost` oder interne Netze (`10.x`, `192.168.x`, `169.254.169.254` usw.) führt. Eine verbleibende Lücke ist DNS-Rebinding zwischen Prüfung und Abruf. Wer den Builder für Fremde öffnet, sollte ausgehenden Traffic zusätzlich per Firewall auf das Internet beschränken.
- **Widget:** Es sieht nur Name, Farbe, Begrüßung und Schnellantworten. System-Prompt und Wissen bleiben auf dem Server. Inhalte werden nur als Text eingefügt (kein `innerHTML`).
- **Missbrauch:** Pro IP gelten höchstens 20 Chat-Nachrichten und 6 Analysen pro Minute. Nachrichten sind auf 2.000 Zeichen und Gespräche auf 40 Runden begrenzt.
- **DSGVO:** Leads und Gespräche liegen als JSON-Dateien in `DATA_DIR` auf deinem Server. Chat-Inhalte gehen zur Beantwortung an die Anthropic-API. Nimm das in deine Datenschutzerklärung auf und schließe bei Bedarf einen Auftragsverarbeitungsvertrag ab. Der Builder lädt keine externen Schriften oder Skripte.

## Aufbau

```
server.js            Start, lädt .env
src/app.js           HTTP-Routen: Verwaltung, Analyse (SSE), Chat (SSE), statische Dateien
src/crawl.js         Website lesen: SSRF-Schutz, Link-Auswahl, HTML zu Text, Boilerplate entfernen
src/analyze.js       Website-Text zu Agent-Konfiguration (Structured Outputs mit Zod)
src/chat.js          Eine Gesprächsrunde: Streaming, Werkzeuge, append-only Verlauf
src/ai.js            Claude-API über das offizielle SDK
src/store.js         JSON-Dateien mit atomaren Schreibvorgängen
src/security.js      Admin-Prüfung, Rate-Limit, erlaubte Domains
public/prompt.js     Vorlagen und Prompt-Generator (Browser und Server)
public/app.js        Builder-Oberfläche
public/widget.js     Einbettbares Chat-Widget
public/demo.html     Testseite für das Widget
```

## Tests

```bash
npm test
```

Die Tests nutzen Fakes für Website und Claude-API. Sie brauchen weder Netzwerk noch API-Key.

## Grenzen

- Seiten, die ihren Inhalt erst per JavaScript aufbauen, liefern kaum Text. Das meldet die Analyse, und du trägst die Infos dann von Hand ein.
- Terminbuchung bedeutet hier eine *Anfrage*, die dein Team bestätigt. Eine Kalender-Anbindung (Google Calendar, Cal.com) gibt es noch nicht.
- Leads gehen nicht automatisch per E-Mail raus. Sie stehen im Builder unter „Erfasst“.
- Ein Prozess, ein Speicher: Für mehrere Server-Instanzen braucht es eine Datenbank statt der JSON-Dateien.
