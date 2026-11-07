# Übergabe-Prompt – v4 planen: Benutzerkonten, Registrierung, QR-Anmeldung, Standard-Server

Diesen Text als erste Nachricht an eine neue Claude-Code-Sitzung geben (Repo `cptnred/DisplayBuddy`, Branch
`claude/display-buddy-v3-c9w0c8` bzw. dessen Nachfolger).

---

```text
Du planst v4 von Display Buddy. Deine Aufgabe ist NUR die Planung – kein Produktivcode. Ergebnis sind
Planungsdokumente, die danach ein Orchestrator mit Subagenten umsetzt (wie in v3).
Antworte dem Benutzer auf Deutsch; Code-Beispiele, Bezeichner und Commits auf Englisch.

## Ziel (Wünsche des Benutzers, gesetzt)
1. Benutzerverwaltung und Registrierung: Benutzerkonten werden in der Desktop-App (Display Buddy unter Windows)
   angelegt („Registrieren“), nicht mehr nur per Server-Kommandozeile.
2. Anmelden der Handy-Apps (PWA und native Android/iOS-App) durch Scannen eines QR-Codes, den die Desktop-App
   anzeigt. Kein Abtippen von Server-Adresse, Benutzer und Passwort am Handy.
3. Standard-Server ist https://buddy.pev-point.de (vom Projekt betrieben). Nur für selbst gehostete Varianten
   kann man eine eigene Server-Adresse eintragen.

## Zuerst vollständig lesen (in dieser Reihenfolge)
CLAUDE.md, docs/HANDOFF.md (§5 Lektionen, §7a v3-Stand), docs/PLAN_V3_SYNC.md, docs/DECISIONS.md (v. a. D-28…D-83),
docs/AGENT_PROMPT_V3.md (Format der Phasenaufträge), deploy/README.md, mobile/README.md.
Danach den Code, auf den sich die Planung stützt (Fakten prüfen, nicht aus der Doku übernehmen):
- server/migrations/*.sql, server/src/{api.rs,auth/*,sync.rs,cli.rs,config.rs,lib.rs}, server/tests/*
- crates/buddy-core/src/sync.rs (API-Nachrichten), src/lib/sync/types.ts (TS-Spiegel)
- Desktop: src-tauri/src/sync/*, src-tauri/src/commands/sync.rs, src/windows/settings/SyncSection.tsx,
  src-tauri/capabilities/*.json, src/lib/api.ts
- Web/Handy: src/web/contract.ts, src/web/sync/{engine,http}.ts, src/web/ui/pages/LoginPage.tsx,
  src/web/notify/native-shell.ts, mobile/src/main.tsx, mobile/src-tauri/{build.rs,src/lib.rs,src/server_url.rs,
  capabilities/main.json}, vite.web.config.ts, deploy/compose*.yaml, deploy/Caddyfile

## Ausgangslage (v3, Stand 2026-11-07 – im Code nachprüfen)
- Server (axum + SQLite): Tabellen sind bereits mandantenfähig (`users`; notes/reminders/devices/sessions/… mit
  `user_id`, ON DELETE CASCADE). Benutzer entstehen nur per CLI `buddy-server user add` (Passwort ≥ 12 Zeichen,
  Argon2id). Es gibt keine Registrierung, keine Passwort-Änderung per API, keine Konto-Löschung per API.
- Auth: Desktop und native App melden sich mit Benutzer+Passwort per `POST /api/v1/devices` an und bekommen ein
  Bearer-Token (nur SHA-256 gespeichert); die PWA nutzt `POST /session` mit `__Host-`-Cookie. CSRF-Regeln D-66,
  Login-Bremse D-67, Geräte widerrufbar (CLI `device revoke`, `DELETE /devices/current`).
- Server-Adresse:
  - Desktop: Feld in Einstellungen → „Synchronisation“ (`syncServerUrl`, geschützt, D-62), Standard leer.
  - Native App: wird beim Bauen fest eingetragen (`BUDDY_PUBLIC_URL`, build.rs); der HTTP-Scope des
    Tauri-HTTP-Plugins ist zur Laufzeit nur für diese Origin + `/api/v1/*` freigegeben.
  - PWA: immer dieselbe Origin wie der Server, der sie ausliefert (CSP `connect-src 'self'`).
- Ursprüngliche v3-Annahme „ein Benutzerkonto, private Verteilung“ und das Nicht-Ziel „mehrere Benutzerkonten“
  (PLAN_V3_SYNC §15) fallen mit v4 weg – das ist ein Kurswechsel, den der Plan ausdrücklich behandeln muss.
- Der Benutzer betreibt seinen Server hinter Nginx Proxy Manager (deploy/compose.npm.yaml, Variante B).

## Was dein Plan klären muss (mindestens)
A. Konten & Registrierung
   - Wer darf sich registrieren (offen, Einladungscode, Freischaltung durch Admin, E-Mail-Bestätigung)?
     Missbrauchsschutz (Rate-Limits pro IP, Proof-of-Work/Captcha ohne Drittanbieter?), Passwort-Regeln,
     doppelte Benutzernamen, Benutzername vs. E-Mail.
   - Konto-Funktionen: Passwort ändern/vergessen (ohne E-Mail-Versand möglich? Wiederherstellungscode?),
     Geräte anzeigen/abmelden, Konto löschen (DSGVO Art. 17), Datenexport (Art. 20), Admin-Rolle und
     Admin-Werkzeuge (CLI und/oder Oberfläche), Kontingente (Speicher, Anzahl Notizen/Geräte).
   - Wo im Desktop: eigener Bereich in den Einstellungen? Erst-Start-Assistent? Texte Deutsch.
B. QR-Anmeldung (Pairing)
   - Protokoll: kurzlebiger Einmal-Code (z. B. 2–5 min, einmal einlösbar), vom angemeldeten Desktop beim Server
     angefordert; QR enthält Server-Origin + Code; das Handy tauscht den Code gegen ein Geräte-Token (native)
     bzw. eine Session (PWA). Bedrohungen: abfotografierter QR, Replay, Brute-Force des Codes, Phishing-Server
     im QR (Origin prüfen/anzeigen und bestätigen lassen), Bestätigung am Desktop („Gerät X anmelden?“).
   - PWA: Scannen mit der System-Kamera öffnet eine URL wie https://<server>/pair#<code> (Fragment landet nicht
     in Server-Logs) – oder Kamera in der App? `BarcodeDetector` laut browser-compat-data prüfen (Safari iOS!);
     Fallback: Code zum Abtippen.
   - Native App: offizielles `@tauri-apps/plugin-barcode-scanner` bzw. tauri-plugin-barcode-scanner prüfen
     (Version, Android/iOS, Kamera-Berechtigungen im Manifest/Info.plist), Fallback Code-Eingabe.
   - Was passiert mit bestehenden Logins mit Passwort (behalten als Alternative?).
C. Standard-Server buddy.pev-point.de und eigener Server
   - Desktop: Standard vorbelegt, „Eigener Server“ als erweiterte Option; Migration bestehender Installationen
     (wer schon einen eigenen Server eingetragen hat, behält ihn).
   - Native App: statt nur der fest eingebauten Origin auch eine im QR-Code/von Hand eingetragene Origin
     erlauben → HTTP-Scope zur Laufzeit erweitern (Sicherheit: nur https, nur /api/v1/*, Bestätigung durch den
     Benutzer, Speicherung). Build-Variable BUDDY_PUBLIC_URL wird zum Standard (buddy.pev-point.de).
   - PWA: läuft immer auf ihrem Server; Selbst-Hoster nutzen die PWA ihres Servers. Klären, ob die PWA auf
     pev-point.de jemals mit fremden Servern reden soll (CSP, Cookies) – vermutlich nein.
   - Betrieb von buddy.pev-point.de: Impressum/Datenschutzerklärung (in der PWA und App verlinkt), Backups,
     Überwachung, Verfügbarkeit, Kosten, Push-Schlüssel (VAPID, Firebase) gehören dem Betreiber, Logs ohne Inhalte.
     Ende-zu-Ende-Verschlüsselung war in v3 ein Nicht-Ziel – bei einem öffentlichen Dienst neu bewerten
     (Produktfrage an den Benutzer, mit ehrlichen Folgen: Push-Text, Server-Suche, Passwort vergessen).
D. Verträge und Tests
   - Neue/geänderte Endpunkte (z. B. POST /accounts, POST /pairing, POST /pairing/redeem, PUT /me/password,
     DELETE /me, GET /me/devices …) mit Nachrichten in crates/buddy-core/src/sync.rs + src/lib/sync/types.ts und
     Beispielen in api_examples.json; DB-Migrationen (nur additive, 0003_*.sql …).
   - Desktop: neue Commands nach der 4-Stellen-Regel (HANDOFF §5.7) + Vertragstests; Settings-Felder.
   - Abnahmeszenarien (registrieren, QR am Android/iOS/PWA, abgelaufener/benutzter Code, falscher Server im QR,
     Konto löschen, Selbst-Hoster, Migration einer v3-Installation) und was nur der Benutzer testen kann.

## Vorgehen
1. Lesen (siehe oben), Fakten im Code prüfen. Offizielle Quellen für Versionen/Fähigkeiten (npm view, cargo info,
   tauri-docs, plugins-workspace, MDN/browser-compat-data, OWASP Authentication/Session/Forgot-Password Cheat Sheets).
   Proxy nie umgehen, TLS-Prüfung nie abschalten.
2. Produktfragen stellst du dem Benutzer als Multiple-Choice (er beantwortet sie gern so), technische Details
   entscheidest du selbst und begründest sie. Stelle die wichtigsten Produktfragen FRÜH, gebündelt
   (max. 4 Fragen pro Runde), z. B.: Registrierung offen/Einladung/Freischaltung; E-Mail ja/nein; Passwort
   vergessen über Wiederherstellungscode vs. E-Mail; E2E-Verschlüsselung jetzt/später/nie; Passwort-Login am
   Handy zusätzlich behalten; Konto löschen sofort oder mit Frist.
3. Schreibe:
   - docs/PLAN_V4_ACCOUNTS.md – verbindlicher Plan im Stil von PLAN_V3_SYNC.md: Ziel + Entscheidungstabelle,
     Architektur, Datenmodell/Migrationen, API-Vertrag, Sicherheitsanalyse (Bedrohung → Gegenmaßnahme),
     Abläufe (Registrierung, Pairing, Server-Wahl) als Schrittfolgen, UI-Texte (Deutsch), Phasen mit exklusiven
     Ordnern und Abhängigkeiten, Tests/Abnahme, Risiken, Nicht-Ziele.
   - docs/AGENT_PROMPT_V4.md – Start-Prompt für den Orchestrator + Phasenaufträge im Format von
     docs/AGENT_PROMPT_V3.md (die „Gemeinsamen Regeln“ dort übernehmen und nur ergänzen).
   - Neue Entscheidungen als Vorschläge D-84 ff. in docs/DECISIONS.md (Abschnitt „v4 (geplant)“).
4. Kleine, thematische Commits (Englisch) mit den Attribution-Zeilen aus deiner Sitzung; auf den vom Benutzer
   genannten Branch pushen. Keine Pull Requests ohne ausdrücklichen Wunsch.
5. Abschluss an den Benutzer (Deutsch): die Antworten auf seine Fragen, die 5–10 wichtigsten Entscheidungen,
   offene Punkte, Phasenübersicht mit grobem Aufwand, und was er vor der Umsetzung erledigen muss
   (z. B. DNS/Server für buddy.pev-point.de, Impressum/Datenschutz, Firebase/VAPID für den öffentlichen Dienst).

## Grenzen
- Kein Produktivcode, keine Änderungen an server/, src-tauri/, src/, mobile/ außer Doku. Prototypen nur im
  Scratchpad, nicht committen.
- Keine Geheimnisse ins Repo. Bestehende Entscheidungen (D-01…D-83) nur mit Begründung ändern.
- Ehrlich trennen: was du im Code geprüft hast, was du aus Doku/Quellen ableitest, was offen ist.
```
