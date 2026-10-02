# Agentenwerk

Ein No-Code-Builder für Website-Chatbots. Du gibst deine Website-Adresse ein. Agentenwerk liest die wichtigsten Seiten und richtet daraus einen Chat-Assistenten ein, inklusive passender Fragen für deine Besucher. Den Assistenten kannst du anpassen und testen. Danach baust du ihn mit einer Zeile Code in deine Website ein.

## So benutzt du es (online stellen in 6 Schritten)

Agentenwerk läuft auf einem eigenen kleinen Server. Kunden, Demo-Links, Widget und Telefon brauchen eine öffentliche https-Adresse.

1. **Server mieten.** Ein kleiner Linux-Server (Ubuntu 24.04) reicht, z. B. bei Hetzner, netcup oder IONOS. Standort Deutschland.
2. **Adresse festlegen.** Bei deinem Domain-Anbieter einen DNS-Eintrag `A` für z. B. `bots.deine-agentur.de` auf die IP des Servers setzen.
3. **Docker installieren** (per SSH auf dem Server):
   ```bash
   curl -fsSL https://get.docker.com | sh
   ```
4. **Agentenwerk holen und starten:**
   ```bash
   git clone https://github.com/digitalerquatsch/web-design.git
   cd web-design/agentenwerk
   printf "DOMAIN=bots.deine-agentur.de\nADMIN_TOKEN=%s\n" "$(openssl rand -hex 24)" > .env
   cat .env          # ADMIN_TOKEN notieren
   docker compose up -d --build
   ```
   Caddy holt das https-Zertifikat automatisch.
5. **Im Browser einrichten:** `https://bots.deine-agentur.de` öffnen, den ersten Admin anlegen (dafür einmal den `ADMIN_TOKEN` eingeben). Dann links auf **System**:
   - **KI:** Mistral-Schlüssel von console.mistral.ai
   - **E-Mail-Versand:** SMTP deines Postfachs, dann „Test-E-Mail an mich“
   - **Allgemein:** Name deiner Agentur und dein Instagram-Name
   - **Abo & Bezahlung:** Stripe-Schlüssel und Webhook (siehe unten), Preis 30 €, 5 Plätze, Links zu AGB, Datenschutz, Impressum
   - **Telefon-Bot:** Twilio-Zugangsdaten (optional)
6. **Kunden reinlassen:** Unter **Nutzer** „Registrierung offen“ einschalten und die Adresse teilen. Neue Kunden registrieren sich, zahlen bei Stripe und legen sofort los. Ab dem 6. Kunden kommt die Warteliste.

**Updates:** `git pull && docker compose up -d --build`. **Sicherung:** Alle Daten liegen im Docker-Volume `agentenwerk-data` (Agenten, Leads, Nutzer, Einstellungen inklusive Schlüssel). Sichere es regelmäßig, z. B. mit `docker run --rm -v agentenwerk_agentenwerk-data:/d -v $PWD:/b alpine tar czf /b/backup.tgz -C /d .`

### Stripe einrichten (für das 30-€-Abo)

1. Konto bei stripe.com anlegen und verifizieren.
2. **Entwickler → API-Schlüssel:** den Secret Key (`sk_live_…`) unter System eintragen. Zum Ausprobieren zuerst den Testmodus (`sk_test_…`) nehmen.
3. **Entwickler → Webhooks → Endpunkt hinzufügen:** die Adresse von der System-Seite (`…/api/public/stripe/webhook`), Ereignisse `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`. Den Signaturschlüssel (`whsec_…`) unter System eintragen.
4. **Einstellungen → Kundenportal** aktivieren (Rechnungen, Zahlungsmethode, Kündigung). Den Button „Zahlungsdaten & Rechnungen“ im Konto deiner Kunden gibt es dann automatisch.

Preis, Plätze und Kontingente änderst du jederzeit unter System. Neue Abos zahlen den neuen Preis.

### Rechtliches beim Abo-Verkauf (bitte prüfen lassen)

- **Impressum, AGB, Datenschutzerklärung** müssen auf deiner Website stehen und unter System verlinkt sein. Die Registrierung verlangt die Bestätigung von AGB und Datenschutz.
- **Bestell-Button:** Er heißt „Zahlungspflichtig abonnieren“ (Button-Lösung, § 312j BGB).
- **Kündigen:** Kunden kündigen im Konto mit „Abo kündigen“ zum Ende des bezahlten Monats (Kündigungsbutton, § 312k BGB). Lass prüfen, ob für dich zusätzlich ein öffentlicher Link „Verträge hier kündigen“ nötig ist.
- **Auftragsverarbeitung:** Deine Kunden verarbeiten Daten ihrer Website-Besucher über deinen Server. Du brauchst AV-Verträge mit deinen Kunden und selbst welche mit Mistral, Stripe, deinem Mail-Anbieter, Twilio und dem Server-Hoster.
- Das ist keine Rechtsberatung.

## Was es kann

- **Website einlesen:** Startseite plus bis zu 7 Unterseiten (Kontakt, Impressum, Leistungen, Preise, FAQ, Über uns). Daraus entstehen Firmenwissen, Öffnungszeiten, Leistungen, 6–10 FAQ mit Antworten, Einstiegsfragen als Buttons, Begrüßung, Markenfarbe und Link zur Datenschutzerklärung. Was auf der Website fehlt, wird als Hinweis angezeigt.
- **Eigene Projekte als Wissen:** Im Editor unter „Wissen“ ein GitHub-Repository eingeben (z. B. `digitalerquatsch/jarvis`). Agentenwerk liest README, Dateistruktur und ein paar Doku-Dateien, die KI macht daraus Zusammenfassung, Funktionen, Anleitung und typische Fragen. Der Agent kann dann Auskunft zu deinen Projekten geben. Mit „Aktualisieren“ liest er sie neu ein. Private Repos gehen mit einem GitHub-Token unter System.
- **Konfigurieren in 8 Schritten:** Grundlagen, Persönlichkeit, Wissen, Ziel & Aktionen, Regeln, Widget, System-Prompt, Einbinden. Dazu 6 Vorlagen (Terminbuchung, Kundenservice, Lead-Qualifizierung, Produktberatung, Tischreservierung, Leer).
- **Testchat** im Builder mit dem aktuellen Stand, auch vor dem Speichern.
- **Aktionen im Gespräch:** Der Agent speichert Leads (`save_lead`) und Terminanfragen (`book_appointment`). Beides erscheint im Builder unter „Erfasst“, zusammen mit den Gesprächsverläufen.
- **Autopilot:** Tabelle hochladen (Excel oder CSV, bis 200 Websites). Für jede Zeile entsteht automatisch ein fertiger Agent und eine **Demo-Seite**, auf der der Chat über einem Screenshot der echten Website liegt. Die Ergebnisliste mit Demo-Links und Einbau-Code gibt es als Tabelle zum Download, etwa für Akquise-Mails.
- **Akquise-Dashboard:** Jede fertige Website aus dem Autopiloten wird ein Lead. Mistral schreibt pro Lead eine kurze, persönliche E-Mail mit Demo-Link. Du prüfst sie und sendest mit einem Klick. Das Dashboard zeigt, wer die Demo geöffnet oder darin gechattet hat, wann Nachfassen fällig ist und wie die Pipeline steht.
- **Abo:** Selbst-Registrierung mit monatlicher Zahlung über Stripe (Standard: 30 €/Monat, 5 Plätze, danach Warteliste). Jeder Abo-Kunde arbeitet in seinem eigenen Bereich mit eigenen Agenten, Listen, Leads und Absenderdaten, mit Monatskontingent für Website-Analysen und Chat-Nachrichten.
- **1:1 Mentoring:** Autopilot und Akquise sind für Abo-Kunden gesperrt. Ein Button führt zu deinem Instagram, und du schaltest sie unter Nutzer frei.
- **Telefon-Bot:** Derselbe Agent nimmt Anrufe an (über eine Twilio-Nummer), beantwortet Fragen mit Stimme und nimmt Rückrufwünsche und Termine auf.
- **Alles im Browser einstellen:** KI-Schlüssel, E-Mail-Versand, Bezahlung, Telefon, Instagram und Kontingente unter **System**, ohne `.env` und ohne Neustart.
- **Nutzerverwaltung:** Konten mit E-Mail und Passwort. Neue Leute beantragen einen Zugang, ein Admin schaltet sie frei. Rollen: Admin, Team, Kunde. Kunden sehen nur die Agenten, die du ihnen zuweist.
- **KI aus der EU:** Standard ist Mistral AI (Sitz Paris). Claude von Anthropic ist als Alternative einstellbar.
- **Widget zum Einbinden:** ein Script-Tag, Darstellung im Shadow DOM (die CSS deiner Seite stört nicht), mobil im Vollbild. Logo und Farbe des Betriebs, eigener Chat-Titel, hell oder dunkel, Begrüßungsbildschirm mit den Einstiegsfragen als Liste und der Hinweis „Sie schreiben mit einem KI-Assistenten“ (Transparenzpflicht nach EU AI Act). Optional nur für freigegebene Domains.

## Aufbau der Oberfläche

Links steht eine Navigation, auf dem Handy über den Menü-Button oben links:

- **Start:** Begrüßung, *ein* nächster Schritt passend zum Stand (z. B. „2 Anfragen warten“, „Bau deine erste Demo“, „3 Betriebe haben die Demo geöffnet“), Kennzahlen-Cards (Agenten, Demos geöffnet/verschickt, Gespräche, Leads aus Chats), „Dein Weg zum ersten Kunden“ in 8 Stationen, Schnellzugriffe und die zuletzt bearbeiteten Agenten.
- **Agenten:** alle Agenten als Cards mit Typ (Termin-, Service-, Lead-, Berater-Agent), Firma, Modell, „Aus Website“/„Demo“ und den Buttons Demo und Bearbeiten.
- **Editor:** der Builder für den gewählten Agenten.
- **Autopilot**, **Akquise**, **Nutzer:** wie oben beschrieben.

Kunden sehen nur Start, Agenten und Editor.

## Eigene Projekte (GitHub)

Damit dein Agent deine Projekte kennt, zum Beispiel als Berater auf deiner Agentur-Website oder am Telefon:

1. Im Editor des Agenten links auf **Wissen**, oben im Feld „Deine Projekte“ das Repository eintragen: `owner/repo` oder die GitHub-Adresse.
2. **Projekt einlesen.** Nach etwa einer halben Minute steht das Projekt als Card da, mit Zusammenfassung, Funktionen und Anzahl der Fragen.
3. Im Testchat rechts fragen, ob die Antworten stimmen. Der Agent nutzt nur, was eingelesen wurde.
4. Änderungen am Repository kommen mit **Aktualisieren** an. **Entfernen** nimmt ein Projekt wieder aus dem Wissen.

Öffentliche Repositories brauchen keinen Zugang. Für **private** Repositories und mehr Abrufe: unter **System → GitHub (Projekte)** einen Token eintragen (GitHub → Settings → Developer settings → Fine-grained token, nur lesen für die gewünschten Repos). Gelesen wird ausschließlich über `api.github.com`: README, Hauptverzeichnis und wenige Dateien wie `CLAUDE.md`, `SKILL.md`, `AGENTS.md`. Quellcode wird nicht gelesen. Ein Import zählt als eine Website-Analyse im Monatskontingent. README-Texte behandelt die KI als Material, nicht als Anweisung.

Hinweis: Alles, was im README steht, kann der Agent Besuchern erzählen. Bei privaten Repositories also nur einlesen, was öffentlich werden darf.

## Telefon-Bot

1. Unter **System → Telefon-Bot** Twilio Account SID und Auth Token eintragen (twilio.com → Console).
2. Bei Twilio eine deutsche Nummer kaufen (Twilio verlangt dafür einen Adressnachweis).
3. Im Editor des Agenten unter **Telefon** „Anrufe beantworten“ einschalten und die angezeigte Adresse kopieren.
4. Bei Twilio: Phone Numbers → Nummer → Voice Configuration → „A call comes in“ → Webhook, HTTP POST, Adresse einfügen.

Der Agent begrüßt mit dem Hinweis „Sie sprechen mit dem KI-Assistenten von …“ (Transparenzpflicht EU AI Act). Er antwortet kurz und ohne Links. Rückrufwünsche und Termine landen unter „Erfasst“, mit der Nummer des Anrufers. Jede Anfrage von Twilio wird über die Signatur geprüft. Spracherkennung und Stimme laufen bei Twilio (USA, mit EU-Option). Nimm das in deine Datenschutzerklärung auf.

## Design

Die Oberfläche ist bewusst dunkel mit Neon-Pink als einziger Akzentfarbe: Cards mit leichtem Glanz, leuchtende Primär-Buttons, Fokus-Rahmen und Datenbalken in Pink. Die Farben stehen als Variablen oben in `public/app.css` (`--accent` ist das Pink). Widget, Demo-Seiten und Abmeldeseite bleiben hell und in den Farben der jeweiligen Firma, weil Endkunden sie sehen.

## Starten

Voraussetzung ist Node.js 20.12 oder neuer.

```bash
cd agentenwerk
npm install
cp .env.example .env      # MISTRAL_API_KEY eintragen
npm start                 # http://localhost:3000
```

Den Mistral-Key bekommst du unter console.mistral.ai. Ohne Key startet der Builder trotzdem. Website-Analyse und Chat antworten aber erst, wenn ein Key eingetragen ist.

## Nutzer und Rollen

Beim ersten Start legst du im Browser den ersten Admin an (über `http://localhost:3000`). Danach ist die Anmeldung Pflicht.

Im Builder oben auf **Nutzer** (nur für Admins). Eine Zahl am Tab zeigt offene Anfragen.

- **Wartet auf Freischaltung:** Wer sich über „Zugang beantragen“ registriert, erscheint hier als Card mit Namen, Firma und Begründung. Rolle wählen, dann **Freischalten** oder **Ablehnen**. Ist SMTP eingerichtet, bekommt die Person eine E-Mail.
- **Nutzer einladen:** legt direkt einen aktiven Zugang an und zeigt ein Einmal-Passwort an, einmalig. Gib es sicher weiter.
- **Alle Zugänge:** Rolle ändern, **Sperren**/**Entsperren** (laufende Sitzungen enden sofort), **Passwort zurücksetzen**, **Löschen**. Bei Kunden: **Agenten zuweisen**.
- **Registrierung offen:** Schalter oben rechts. Ist er aus, kommen neue Leute nur noch per Einladung rein.

| Rolle | Darf |
|---|---|
| Admin | alles, auch Nutzer und System |
| Team | Builder, Autopilot, Akquise im Hauptbereich (deine Agentur) |
| Abo | eigener, abgetrennter Bereich. Autopilot und Akquise erst nach Freischaltung im Mentoring. Monatskontingent |
| Kunde | nur die zugewiesenen Agenten im Builder bearbeiten und testen, keine Website-Analyse, kein Löschen |

Es bleibt immer mindestens ein aktiver Admin übrig, das prüft der Server. Jeder kann sein Passwort über das Menü oben rechts ändern.

**Sicherheit:** Passwörter werden mit scrypt gehasht, Sitzungen liegen in einem HttpOnly-Cookie (SameSite=Lax, `Secure` bei HTTPS) und gelten 14 Tage. Pro IP und E-Mail sind höchstens 10 Anmeldeversuche in 15 Minuten möglich. `ADMIN_TOKEN` funktioniert weiter als Generalschlüssel für die API.

## Autopilot

1. Im Builder oben auf **Autopilot** wechseln.
2. Tabelle hochladen. Erkannt werden die Spalten `Website` (Pflicht), `Firma`, `Ansprechpartner`, `E-Mail`, `Telefon` und `Ort`. Die Überschriften dürfen auch anders heißen (z. B. „Webseite“, „Unternehmen“). Fehlen Überschriften, sucht der Autopilot die Spalte mit den Adressen selbst. Doppelte und ungültige Adressen werden übersprungen und angezeigt.
3. Der Autopilot arbeitet zwei Websites gleichzeitig ab: Seiten lesen, Agent bauen, Screenshot erstellen. Der Fortschritt aktualisiert sich live. Bricht der Server ab, macht er nach dem Neustart weiter.
4. Pro Zeile: **Demo ansehen**, **Link kopieren** oder **Bearbeiten** (öffnet den Agenten im Builder). Fehlgeschlagene Zeilen lassen sich erneut versuchen.
5. **Ergebnis als Tabelle** lädt eine CSV mit Firma, Kontakt, Status, Demo-Link, Einbau-Code und Hinweisen („Fehlt auf der Website: …“) herunter. Sie öffnet sich direkt in Excel.

Die Demo-Seite (`/d/AGENT_ID`) ist ohne Anmeldung erreichbar, damit du den Link verschicken kannst. Sie zeigt nur, was ohnehin auf der Website des Kunden steht, und ist für Suchmaschinen gesperrt (`noindex`). Mit `AGENCY_NAME` und `AGENCY_CONTACT` steht oben „Erstellt von …“.

**Screenshots** brauchen Playwright mit Chromium:

```bash
npm install                      # installiert playwright als optionale Abhängigkeit
npx playwright install chromium  # lädt den Browser
```

Ohne Chromium zeigt die Demo eine nachgebaute Seite in der Markenfarbe, mit Firmenname, Beschreibung und Leistungen. Cookie-Banner der üblichen Anbieter werden für den Screenshot ausgeblendet. Auch der Browser darf nur öffentliche Adressen laden.

**Kosten:** Pro Website fällt ein Analyse-Aufruf an die KI an (etwa 15.000–30.000 Eingabe-Tokens, je nach Textmenge), pro E-Mail-Entwurf ein kleiner weiterer. Die aktuellen Preise pro Token stehen bei Mistral unter mistral.ai/pricing.

## Akquise-Dashboard

Im Builder oben auf **Akquise**. Oben stehen die Kennzahlen: Leads, kontaktiert, Demo angesehen (mit Quote), Chats in Demos, Interessierte, Kunden. Darunter folgen die Pipeline und „Heute zu tun“ (Entwürfe prüfen, Nachfassen fällig, Leads ohne E-Mail-Adresse). Unten steht die Lead-Liste mit Filtern, Suche und Mehrfachauswahl.

So läuft es:

1. **Einstellungen** öffnen und Absender eintragen: Name, Firma, E-Mail, Anschrift. Die Anschrift steht unter jeder E-Mail, das ist bei geschäftlichen E-Mails Pflicht. Optional kommen ein Satz zu deinem Angebot und die Frist fürs Nachfassen dazu.
2. Leads auswählen und **E-Mails schreiben**. Mistral schreibt im Hintergrund pro Firma eine E-Mail mit Bezug auf deren Leistungen und mit dem Demo-Link. Status: „Entwurf prüfen“.
3. Lead anklicken, Text lesen und anpassen, **Vorschau** zeigt die fertige E-Mail mit Signatur, Anschrift und Abmeldelink. Dann **Senden**, einzeln oder für die Auswahl.
4. Öffnet der Empfänger die Demo, springt der Lead auf **Demo angesehen**. Chats und hinterlassene Kontaktdaten in der Demo erscheinen im Verlauf. Aufrufe aus dem Dashboard (Button „Demo öffnen“) zählen nicht mit.
5. Ohne Antwort nach X Tagen erscheint der Lead unter **Nachfassen fällig**. Mistral schreibt dann eine kurze Nachfass-E-Mail.
6. Interessiert, Kunde oder kein Interesse setzt du von Hand. Notizen gibt es pro Lead.

**Durchgehen:** Mit **Einzeln durchgehen** (Akquise) oder **Durchgehen & senden** (Autopilot) arbeitest du Betrieb für Betrieb ab:

- links die echte Demo im Browser-Rahmen, auf der Website des Betriebs mit geöffnetem Chat,
- rechts der Betrieb (E-Mail-Adresse direkt korrigierbar) und „Das geht raus“: Farbe, Hell/Dunkel und Begrüßung ändern und **Übernehmen**, die Demo aktualisiert sich sofort,
- darunter die E-Mail genau so, wie sie ankommt, mit Beispiel-Chat in den Farben des Betriebs und Button „Demo selbst ausprobieren“,
- **Vorschau an mich** schickt dir die E-Mail zur Kontrolle, **Senden** verschickt sie und springt zum nächsten Betrieb, **Überspringen** lässt ihn aus.

Fehlt einem Betrieb noch der Entwurf, schreibt Mistral ihn beim Öffnen automatisch.

**Die E-Mail** geht als HTML mit Textversion raus: Anrede, kurzer Text, ein Beispiel-Chat (Begrüßung, eine typische Frage aus den FAQ und die Antwort des Assistenten), der Demo-Button, deine Signatur, Anschrift und Abmeldelink.

**Versand:** über das SMTP deines Postfachs (`SMTP_*` in der `.env`). Es gibt ein Tageslimit (`OUTREACH_DAILY_LIMIT`, Standard 40), damit dein Postfach nicht als Spam eingestuft wird. Jede E-Mail hat einen Abmeldelink und den Header `List-Unsubscribe` (Ein-Klick-Abmeldung in Gmail/Outlook). Wer sich abmeldet, landet auf einer Sperrliste und bekommt nie wieder eine E-Mail. Ohne SMTP kannst du die Texte kopieren.

**Was nicht passiert:** Nichts wird automatisch verschickt. Jede E-Mail geht erst nach deinem Klick raus. Es gibt auch keine Tracking-Pixel in E-Mails. Gezählt werden nur Aufrufe der Demo-Seite auf deinem eigenen Server.

> **Rechtlicher Hinweis:** Werbe-E-Mails ohne vorherige ausdrückliche Einwilligung sind in Deutschland auch an Unternehmen grundsätzlich unzulässig (§ 7 Abs. 2 Nr. 2 UWG) und werden abgemahnt. Nutze den Versand für Kontakte, die eingewilligt haben oder mit denen du schon im Gespräch bist (z. B. nach einem Telefonat, auf einer Messe, auf Anfrage). Für die Kaltakquise eignen sich Telefon und LinkedIn. Die Entwürfe sind dafür ein guter Gesprächsleitfaden. Das ist keine Rechtsberatung.

## Einbinden

Unter **Einbinden** findest du den Code für deine Website:

```html
<script src="https://bots.deine-firma.de/widget.js" data-agent="AGENT_ID" defer></script>
```

Damit Besucher chatten können, muss der Server öffentlich erreichbar sein. Dafür brauchst du:

1. einen Server oder Hoster mit Node.js (zum Beispiel Hetzner, netcup, Render oder Fly.io; für EU-Hosting einen Anbieter mit Rechenzentrum in der EU),
2. davor einen Reverse-Proxy mit HTTPS (Caddy oder nginx),
3. in der `.env`: `HOST=0.0.0.0` und `PUBLIC_URL`. Lege den ersten Admin an, *bevor* der Server öffentlich erreichbar ist (lokal oder per SSH-Tunnel). Sonst setze `ADMIN_TOKEN`, dann lässt sich der erste Admin nur mit diesem Token anlegen.

Trage unter **Erlaubte Websites** deine Domain ein. Dann lässt sich dein Agent nicht auf fremden Seiten einbinden.

## Konfiguration (`.env`)

| Variable | Bedeutung |
|---|---|
| `MISTRAL_API_KEY` | Pflicht für Analyse, Chat und E-Mail-Entwürfe |
| `MISTRAL_MODEL` | Modell, Standard `mistral-medium-latest` |
| `AI_PROVIDER` | `mistral` (Standard) oder `anthropic` |
| `ANTHROPIC_API_KEY`, `AGENT_MODEL` | Nur für `AI_PROVIDER=anthropic` |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | E-Mail-Versand im Akquise-Dashboard |
| `OUTREACH_DAILY_LIMIT` | Höchstens so viele E-Mails pro 24 Stunden, Standard 40 |
| `PORT`, `HOST` | Standard `3000`, `127.0.0.1` |
| `ADMIN_TOKEN` | Generalschlüssel für die API (Bearer). Nötig, um den ersten Admin von außerhalb von localhost anzulegen |
| `PUBLIC_URL` | Öffentliche Adresse für den Einbau-Code |
| `DATA_DIR` | Speicherort für Agenten, Leads, Gespräche und Screenshots, Standard `./data` |
| `AGENCY_NAME`, `AGENCY_CONTACT` | Absender auf den Demo-Seiten |
| `CHROMIUM_PATH` | Eigener Chromium für Screenshots |

## Sicherheit und Datenschutz

- **Verwaltung:** Admin-Anfragen brauchen eine Sitzung (oder `ADMIN_TOKEN`) und zusätzlich den Header `X-Agentenwerk`, den Browser nur nach einem CORS-Preflight senden, den der Server nie erlaubt. Fremde Websites können die API also nicht über den Browser deiner Besucher fernsteuern. Vor dem ersten Konto ist der Builder nur über `localhost` erreichbar.
- **Website-Abruf:** Der Crawler ruft nur öffentliche Adressen ab. Jede Weiterleitung wird einzeln geprüft, damit ein Link nicht auf `localhost` oder interne Netze (`10.x`, `192.168.x`, `169.254.169.254` usw.) führt. Eine verbleibende Lücke ist DNS-Rebinding zwischen Prüfung und Abruf. Wer den Builder für Fremde öffnet, sollte ausgehenden Traffic zusätzlich per Firewall auf das Internet beschränken.
- **Widget:** Es sieht nur Name, Farbe, Begrüßung und Schnellantworten. System-Prompt und Wissen bleiben auf dem Server. Inhalte werden nur als Text eingefügt (kein `innerHTML`).
- **Missbrauch:** Pro IP gelten höchstens 20 Chat-Nachrichten und 6 Analysen pro Minute. Nachrichten sind auf 2.000 Zeichen und Gespräche auf 40 Runden begrenzt.
- **DSGVO:** Leads und Gespräche liegen als JSON-Dateien in `DATA_DIR` auf deinem Server. Chat-Inhalte, Website-Texte und E-Mail-Entwürfe gehen zur Verarbeitung an Mistral AI (EU-Anbieter mit Sitz in Paris). Nimm das in deine Datenschutzerklärung auf und schließe mit Mistral einen Auftragsverarbeitungsvertrag (DPA) ab. Mit `AI_PROVIDER=anthropic` gilt das entsprechend für Anthropic. Der Builder lädt keine externen Schriften oder Skripte.

## Aufbau

```
server.js            Start, lädt .env
src/app.js           HTTP-Routen: Verwaltung, Analyse (SSE), Chat (SSE), statische Dateien
src/crawl.js         Website lesen: SSRF-Schutz, Link-Auswahl, HTML zu Text, Boilerplate entfernen
src/analyze.js       Website-Text zu Agent-Konfiguration (Structured Outputs mit Zod)
src/chat.js          Eine Gesprächsrunde: Streaming, Werkzeuge, append-only Verlauf
src/ai.js            Wahl des KI-Anbieters; Claude über das offizielle SDK
src/ai-mistral.js    Mistral AI: Structured Outputs, Streaming, Function Calling
src/outreach.js      Leads, Pipeline, E-Mail-Entwürfe, SMTP-Versand, Abmeldung
src/autopilot.js     Warteschlange: Tabelle → Agenten + Demos, setzt nach Neustart fort
src/table.js         CSV- und XLSX-Leser (ohne Zusatzbibliothek), Spalten-Erkennung, CSV-Export
src/screenshot.js    Website-Screenshots mit Playwright (optional)
src/users.js         Konten, Passwörter (scrypt), Sitzungen, Rollen und Rechte
src/system.js        Einstellungen aus dem Browser (System-Seite), Schlüssel nur maskiert
src/billing.js       Stripe: Checkout, Kundenportal, Kündigung, signierte Webhooks
src/github.js        GitHub-Repo einlesen und für den Agenten zusammenfassen
src/voice.js         Telefon über Twilio: TwiML, Signaturprüfung, Text fürs Vorlesen
src/store.js         JSON-Dateien mit atomaren Schreibvorgängen
src/security.js      Admin-Prüfung, Rate-Limit, erlaubte Domains
public/prompt.js     Vorlagen und Prompt-Generator (Browser und Server)
public/app.js        App-Rahmen (Navigation, Anmeldung) und Builder
public/home.js       Startseite
public/review.js     Durchgehen: Demo, Feinschliff, E-Mail, Senden/Überspringen
public/agents.js     Agenten-Übersicht (Cards)
public/icons.js      Linien-Icons
public/autopilot.js  Autopilot-Oberfläche
public/acquisition.js Akquise-Dashboard
public/users.js      Nutzerverwaltung (Cards), Abo-Status, Autopilot-Freischaltung, Warteliste
public/system.js     System-Seite
public/account.js    Konto (Abo, Verbrauch, Passwort) und 1:1 Mentoring
public/auth.js       Anmelden, Zugang beantragen, ersten Admin anlegen
public/unsubscribe.html Abmeldeseite (/abmelden/TOKEN)
public/preview.html  Demo-Seite für Kunden (/d/AGENT_ID)
public/widget.js     Einbettbares Chat-Widget
public/demo.html     Testseite für das Widget
```

## Tests

```bash
npm test
```

Die Tests nutzen Fakes für Websites, KI-Anbieter und Mailserver. Sie brauchen weder Netzwerk noch API-Key.

## Grenzen

- Seiten, die ihren Inhalt erst per JavaScript aufbauen, liefern kaum Text. Das meldet die Analyse, und du trägst die Infos dann von Hand ein.
- Terminbuchung bedeutet hier eine *Anfrage*, die dein Team bestätigt. Eine Kalender-Anbindung (Google Calendar, Cal.com) gibt es noch nicht.
- Leads, die Besucher im Chat hinterlassen, gehen nicht automatisch per E-Mail an dich. Sie stehen im Builder unter „Erfasst“.
- Antworten auf Akquise-E-Mails landen in deinem Postfach. Das Dashboard liest das Postfach nicht mit, den Status setzt du von Hand.
- Ein Prozess, ein Speicher: Für mehrere Server-Instanzen braucht es eine Datenbank statt der JSON-Dateien.
