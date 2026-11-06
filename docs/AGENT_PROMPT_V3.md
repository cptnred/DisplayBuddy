# Prompts für die ausführenden Agenten – v3 (Sync + Push)

Diese Datei enthält:
1. den **Start-Prompt für den Orchestrator** (in eine neue Claude-Code-Session kopieren),
2. die **gemeinsamen Regeln**, die jeder Subagent mitbekommt,
3. je einen **Auftrag pro Phase** (0, A–G) zum Weitergeben an Subagenten,
4. die **Vorlage für den Abschlussbericht**.

Grundlage ist `docs/PLAN_V3_SYNC.md`. Bei Widersprüchen gilt der Plan; Abweichungen werden in
`docs/DECISIONS.md` begründet.

---

## 1. Start-Prompt für den Orchestrator

```text
Du setzt v3 von Display Buddy um: Notiz-Synchronisation über einen eigenen Server und Push-Erinnerungen
aufs Handy (ntfy). Antworte dem Benutzer auf Deutsch; Code, Bezeichner und Commits auf Englisch.

Lies zuerst vollständig, in dieser Reihenfolge:
CLAUDE.md, docs/HANDOFF.md, docs/PLAN.md, docs/DECISIONS.md, docs/PLAN_V3_SYNC.md, docs/AGENT_PROMPT_V3.md.

Deine Rolle: Orchestrator. Du erledigst Phase 0 und Phase F selbst und gibst die Phasen A–E (und optional G)
an Subagenten, jeweils mit eigenem git-Worktree und den in PLAN_V3_SYNC §11 genannten exklusiven Ordnern.
Gib jedem Subagenten den Block „Gemeinsame Regeln“ (AGENT_PROMPT_V3 §2) und seinen Phasenauftrag (§3)
wörtlich mit. Reihenfolge: 0 → (A ∥ B ∥ C) → (D ∥ E) → F → optional G (nur nach Rückfrage).

Vor Phase 0:
1. Bau-Umgebung wie in HANDOFF §4 einrichten (apt-Pakete, rustup target x86_64-pc-windows-gnu,
   tauri-cli), npm install, und alle bestehenden Checks einmal grün sehen. Rote Checks zuerst melden.
2. Die in PLAN_V3_SYNC §13 genannten Punkte prüfen (sqlx-Version, keyring-Windows-Store-Crate,
   reqwest-TLS unter MinGW, ntfy-Image-Tag) und das Ergebnis als D-Eintrag festhalten.

Produktfragen (alles, was der Benutzer sieht oder entscheidet) stellst du dem Benutzer als
Multiple-Choice-Frage, bevor du sie festlegst; technische Details entscheidest du selbst und begründest sie
in docs/DECISIONS.md. Die Entscheidungen des Benutzers in PLAN_V3_SYNC §1 sind gesetzt – nicht neu
verhandeln.

Nach jeder Phase: Worktree-Ergebnis prüfen (Diff lesen, alle Checks selbst laufen lassen, nicht nur dem
Bericht glauben), in den Arbeitszweig integrieren, Konflikte lösen, Checks erneut grün, committen, pushen.
Am Ende: Abschlussbericht nach AGENT_PROMPT_V3 §4 an den Benutzer, ehrlich getrennt nach „getestet“,
„nur kompiliert/statisch geprüft“ und „nicht prüfbar (nur Benutzer)“. Installer als ZIP liefern (HANDOFF §2).
```

---

## 2. Gemeinsame Regeln (jedem Subagenten mitgeben)

```text
GEMEINSAME REGELN – Display Buddy v3

Projekt & Vertrag
- Lies CLAUDE.md, docs/HANDOFF.md (§5 Lektionen!), docs/PLAN_V3_SYNC.md (verbindlich für v3).
- Arbeite NUR in den Ordnern deines Auftrags. Brauchst du eine Änderung außerhalb (z. B. src/types.ts,
  model.rs, buddy-core), ändere sie nicht selbst, sondern beschreibe sie präzise im Bericht.
- API- und Datenvertrag: PLAN_V3_SYNC §5 und §6. Weichst du ab, begründe es im Bericht.
- Desktop-Regeln: nur src/lib/api.ts ruft invoke()/listen(); außerhalb state.rs nie .state()/.state::<,
  immer try_app_state/try_state; neuer Command = commands/*.rs + generate_handler! + build.rs COMMANDS +
  capabilities + api.ts + api.test.ts + plan_commands() in tests/contract.rs; neue Settings-Felder =
  types.ts + DEFAULT_SETTINGS + model.rs + Test-JSON + Schlüsselzahl im Vertragstest.
- UI-Texte Deutsch; Animationen nur transform/opacity; prefers-reduced-motion; aria-label überall;
  Tastaturbedienung.

Quellen (verbindliche Reihenfolge)
1. Offizielle Dokumentation und offizielle Beispiele des jeweiligen Projekts (ntfy, axum/tower-http,
   Tauri inkl. plugins-workspace, TipTap, sqlx, Caddy, OWASP Cheat Sheets, RustCrypto, keyring-rs,
   chrono/chrono-tz, Docker). Halte dich an die dort beschriebenen Vorgehensweisen.
2. Bei Problemen: GitHub Issues/Discussions/Changelogs des betroffenen Projekts.
3. Danach Stack Overflow.
- Viele Doku-Webseiten sind in der Cloud-Umgebung per Proxy gesperrt. Dann die Doku-Quelltexte aus dem
  offiziellen GitHub-Repo lesen (z. B. `git clone --depth 1 --filter=blob:none --sparse <repo>` und
  `git sparse-checkout set --no-cone /docs/*`), oder WebSearch verwenden. Den Proxy nie umgehen,
  TLS-Prüfung nie abschalten.
- Vermerke die Fundstelle (Repo/Datei oder URL) im Commit-Text oder im Bericht, wenn eine Lösung daraus
  stammt. Keinen Code ungeprüft kopieren; Lizenz beachten.
- Versionen nicht raten: aktuelle stabile Version prüfen (`cargo info <crate>`, `npm view <pkg> version`),
  exakt pinnen und im Bericht nennen.

Qualität
- Tests zuerst für reine Logik (LWW, Merge, Scheduler-Zustände, Token-Signatur). Kein Netz in Unit-Tests;
  HTTP gegen lokale Mock-Server, Zeit über einen injizierten Clock.
- Vor jedem Commit die Checks deines Bereichs laufen lassen (siehe Auftrag) – alle grün, clippy mit
  -D warnings, cargo fmt. Windows-Code zusätzlich mit --target x86_64-pc-windows-gnu clippen.
- Kleine, thematische Commits auf Englisch. Keine TODO-Stubs als fertig melden. Keine Tests abschalten
  oder abschwächen, um grün zu werden.
- Keine Geheimnisse ins Repo (Tokens, Passwörter, echte Domains). Beispielwerte nur in .env.example.
- Logs enthalten nie Notizinhalt, Passwörter oder Tokens.

Bericht am Ende (Pflicht, Deutsch)
- Was umgesetzt ist (Dateien), was getestet ist (Befehle + Ergebnis), was nur kompiliert, was offen ist.
- Gewählte Versionen und technische Entscheidungen mit Quelle (Vorschlag für DECISIONS.md).
- Nötige Änderungen außerhalb deiner Ordner (präzise).
```

---

## 3. Phasenaufträge

### Phase 0 – Fundament (Orchestrator selbst)

```text
Ziel: gemeinsame Grundlage, damit A, B und C parallel arbeiten können.
1. crates/buddy-core anlegen (Rust 2024, keine Tauri/axum-Abhängigkeit). Verschieben:
   src-tauri/src/reminders/schedule.rs, src-tauri/src/reminders/text.rs, Note, NoteColor (inkl. lenient),
   Reminder, ReminderRepeat, ReminderState, RemindersFile, is_valid_note_id. model.rs re-exportiert alles
   (pub use), Importe in src-tauri bleiben gültig. src-tauri bindet per path-Dependency ein (kein Workspace).
   Reiner Refactor: alle bestehenden Tests unverändert grün, clippy Linux + windows-gnu grün,
   NSIS-Cross-Build grün.
2. Reminder.updatedAt (Option<String>, serde default) in buddy-core und types.ts; schedule::set/ack/snooze
   setzen es, fire() NICHT (PLAN_V3_SYNC §5.4). Tests anpassen/ergänzen.
3. In buddy-core: NoteRecord, ReminderRecord, OrderRecord, SyncChanges, PushRequest/PushResult,
   Fehlercodes; LWW-Funktionen note_wins/reminder_wins/order_wins inkl. Tiebreak-Regeln und Zeitstempel-
   Klemme (clamp_future); umfassende Tests (Gleichstand, Tombstone gegen Bearbeitung, due gegen
   scheduled, Uhrzeit in der Zukunft).
4. Desktop-Vertrag festschreiben: types.ts + model.rs (Settings-Felder syncEnabled, syncServerUrl,
   syncDeviceName; SyncStatus; NotesChangedPayload), Vertragstest (Schlüsselzahl) anpassen.
   Commands erst in Phase B.
5. DECISIONS.md: die v3-Einträge final machen (Versionen, Prüfergebnisse aus §13).
Checks: npm test, npm run build, cargo test (src-tauri, crates/buddy-core), clippy (Linux + windows-gnu),
cargo fmt --check, NSIS-Cross-Build. Commit, push.
```

### Phase A – Server-Kern (Subagent)

```text
Auftrag: buddy-server ohne Push, gemäß docs/PLAN_V3_SYNC.md §6 und §7 (ohne §7.3/§7.4).
Ordner (exklusiv): server/ (außer server/Dockerfile).
Grundlage: crates/buddy-core (nur lesen; Änderungswünsche in den Bericht).

Umsetzen:
- Cargo-Projekt server/ (Rust 2024, eigenes Cargo.lock). axum 0.8.x, tokio, tower-http, sqlx (SQLite,
  runtime-tokio, migrate; query/query_as ohne Offline-Metadaten), argon2, chrono, chrono-tz, serde, tracing,
  rand. Konfiguration aus Umgebungsvariablen (§7.1), klare Fehlermeldung bei fehlenden Werten.
- Migrationen (§7.2), WAL, Transaktionen mit seq-Zählung, Revisionen, Tombstone-Bereinigung (min_cursor,
  410 full_resync_required), nächtliches VACUUM INTO mit 14 Ständen.
- CLI: serve, user add/passwd (Passwort über stdin), device list/revoke, revisions, restore.
- Auth: POST /devices (Geräte-Token, nur SHA-256 gespeichert), DELETE /devices/current; POST/DELETE /session
  mit Cookie __Host-buddy_session (Secure, HttpOnly, SameSite=Strict, Path=/), serverseitige Sessions;
  CSRF-Prüfung (Sec-Fetch-Site, Origin-Fallback, X-Buddy-Request) für Cookie-Anfragen; Login-Bremse;
  Argon2id mit mindestens OWASP-Parametern. Quellen: OWASP Password Storage, Session Management,
  CSRF Prevention Cheat Sheets.
- Endpunkte aus §6 (ohne /actions und /events) inkl. Grenzen und Validierung; Web-Bearbeitungen bekommen
  Serverzeit; jede Antwort mit serverTime, Cache-Control: no-store.
- Statische Auslieferung der Web-App aus BUDDY_WEB_DIR mit SPA-Fallback auf index.html (axum-Beispiel
  static-file-server) und Sicherheits-Headern (§7.5).
- Graceful Shutdown (axum-Beispiel graceful-shutdown).
Tests: Router-Tests per tower::ServiceExt::oneshot (axum-Beispiel testing) gegen SQLite in einem
Temp-Verzeichnis: Login/Fehlversuche, Cookie-Attribute, CSRF-Ablehnung, Geräte-Token widerrufen,
Sync push/pull inkl. LWW, Tombstones, Paginierung, 410, Revisionen, Grenzen.
Checks: cd server && cargo test && cargo clippy --all-targets -- -D warnings && cargo fmt --check.
```

### Phase B – Desktop-Sync (Subagent)

```text
Auftrag: Sync-Client in der Desktop-App gemäß docs/PLAN_V3_SYNC.md §5, §8 (Server-Vertrag §6).
Ordner (exklusiv): src-tauri/src/sync/, src-tauri/src/commands/sync.rs, src/windows/settings/,
src/windows/notes/useNotesStore*, src/lib/api.ts, src/lib/api.test.ts, sowie die nötigen Einträge in
src-tauri/src/lib.rs, src-tauri/build.rs, src-tauri/capabilities/settings.json,
src-tauri/tests/contract.rs, src-tauri/Cargo.toml, src-tauri/src/commands/mod.rs.
Hooks in commands/notes.rs und reminders.rs: nur minimale Aufrufe (Outbox markieren), sonst nichts ändern.

Umsetzen:
- HTTP über tauri_plugin_http::reqwest, nur Rust-seitig, keine JS-Permission (Tauri-Doku
  plugin/http-client; Muster D-07). TLS-Feature so wählen, dass der Build mit
  --target x86_64-pc-windows-gnu klappt; das selbst mit dem NSIS-Cross-Build prüfen.
- Token im Windows-Anmeldeinformationsspeicher über keyring-core und das Windows-Store-Crate
  (keyring-rs-README), hinter einem Trait; unter Linux in Tests ein Speicher-Mock.
- Outbox, state.json, Merge (reine Funktionen in sync/merge.rs), Auslöser, Ablauf, Start-Pull vor dem
  Nachfeuern, Erst-Verbindung, Fehlerzustände, Uhrzeit-Abweichung (§8.2). Lock-Reihenfolge dokumentieren;
  kein Netz unter einem Lock.
- Commands sync_status/sync_connect/sync_disconnect/sync_now, Events sync-status und notes-changed
  (§8.3), komplette 4-Stellen-Regel inkl. api.ts, api.test.ts, plan_commands(), Least-Privilege-Test.
- useNotesStore: notes-changed einarbeiten (§8.4), TipTap setContent(json, { emitUpdate: false });
  Regressionstests in useNotesStore.races.test.ts.
- Einstellungsfenster: Abschnitt „Synchronisation“ (§8.5) mit Tests.
- Ohne Sync muss alles exakt wie 0.2.0 funktionieren.
Tests: Merge/LWW/Outbox als Unit-Tests; Client gegen lokalen HTTP-Mock (Dev-Dependency, z. B. ein
minimaler axum- oder std-TcpListener-Server); Frontend-Tests für Settings-Abschnitt und Store.
Checks: npm test, npm run build, cd src-tauri && cargo test, cargo clippy --all-targets -- -D warnings,
cargo clippy --all-targets --target x86_64-pc-windows-gnu -- -D warnings, cargo fmt --check,
npm run tauri build -- --target x86_64-pc-windows-gnu (muss bauen).
```

### Phase C – Web-App fürs Handy (Subagent)

```text
Auftrag: Web-App gemäß docs/PLAN_V3_SYNC.md §9 gegen den API-Vertrag §6.
Ordner (exklusiv): src/web/, web.html, vite.web.config.ts, package.json (nur Skripte dev:web/build:web und
ggf. Vitest-Include). Geteilte Komponenten (src/components/editor/, src/lib/search.ts, src/lib/datetime.ts)
nur lesen; brauchst du Änderungen dort, beschreibe sie im Bericht.

Umsetzen:
- Eigener Vite-Einstieg mit Ausgabe dist-web/; React 18; dieselben TipTap-Extensions wie am Desktop
  (TipTap-Doku: Schema-Parität); NoteEditor/Toolbar wiederverwenden.
- src/web/webApi.ts als einzige Stelle mit fetch (credentials same-origin, Header X-Buddy-Request: 1,
  Fehlercodes auf deutsche Meldungen abbilden).
- Seiten /login, /, /notes/<id>, /new, /setup; Suche, Farbe, Erinnerung (setzen/entfernen/erledigen/
  verschieben), Löschen mit Bestätigung, Autosave 1 s, Status „Gespeichert“/„Nicht gespeichert – offline“,
  Neu-Laden bei visibilitychange.
- Mobilgerecht (Ziele ≥ 44 px, umbrechende Toolbar), Web-App-Manifest + Icons, kein Service Worker.
- Barrierefreiheit: aria-label, Tastatur, prefers-reduced-motion; deutsche Texte.
Tests: Vitest + Testing Library mit gemocktem fetch (Vertrag §6): Login, Liste/Suche, Bearbeiten +
Autosave, Erinnerungsaktionen, Fehler/Offline, 401 → Login.
Checks: npm test, npm run build (Desktop unverändert), npm run build:web.
```

### Phase D – Erinnerungen und ntfy auf dem Server (Subagent)

```text
Auftrag: Server-Scheduler und Push gemäß docs/PLAN_V3_SYNC.md §5.4, §7.3, §7.4.
Ordner (exklusiv): server/src/reminders/, server/src/ntfy/ (+ Registrierung in server/src/main.rs bzw.
lib.rs, Migration für push_log falls noch nicht vorhanden).
Quelle: ntfy-Doku publish.md (Publish as JSON, Action buttons, Click action, Authentication/Access tokens,
Updating + deleting notifications / Clearing) und config.md (Access control, iOS instant notifications).

Umsetzen:
- Scheduler-Task mit Notify-Wecken, max. 30 s Schlaf, injizierter Clock; Fällig-Werden ohne updatedAt-
  Änderung; push_log-Logik „genau einmal pro (noteId, at)“, nicht älter als 24 h; Nachfeuern beim Start.
- Wiederholungsmathe aus buddy-core in der IANA-Zone des Kontos (chrono-tz).
- ntfy-Client hinter Trait (echter Client: reqwest, JSON an Root-URL, Bearer-Token; Wiederholungen
  5 s/30 s/2 min); Nachricht exakt wie §7.4 (max. 3 Aktionen, Titel ≤ 1 KB, Text auf 100 Zeichen).
- Aktions-Tokens (HMAC-SHA256, 24 h, an (noteId, at) gebunden) + POST /actions/{token} (ack, snooze 10);
  idempotent, bei veraltetem Vorkommen 204 ohne Änderung.
- Clear (PUT /<topic>/r-<noteId>/clear), wenn die Erinnerung anderswo erledigt/verschoben/entfernt wird.
Tests: Zustandsübergänge mit simulierter Uhr, genau eine Nachricht pro Vorkommen (auch wenn ein Gerät
vorher due gemeldet hat), Wiederholung in Europe/Berlin über die Sommerzeitgrenze, Token-Signatur/
Ablauf/Manipulation, Aktionen über den Router, Clear-Aufruf, Retry-Verhalten (Fake-ntfy).
Checks: cd server && cargo test && cargo clippy --all-targets -- -D warnings && cargo fmt --check.
```

### Phase E – Deployment (Subagent)

```text
Auftrag: Betrieb auf einem VPS gemäß docs/PLAN_V3_SYNC.md §10.
Ordner (exklusiv): deploy/, server/Dockerfile, .dockerignore.
Quellen: ntfy-Doku install.md (Docker, compose, Healthcheck) und config.md (Private instance, Behind a proxy,
iOS instant notifications); Caddy-Doku (reverse proxy quick-start, automatic HTTPS); Docker-Doku (Compose,
Multi-Stage-Builds).

Umsetzen:
- server/Dockerfile: Multi-Stage (Node: npm ci && npm run build:web → Rust: cargo build --release für
  server/ → schlankes Laufzeit-Image, non-root, /data als Volume, HEALTHCHECK). Image-Tags festpinnen.
- deploy/compose.yaml (caddy, buddy, ntfy; internes Netz; nur Caddy mit Ports 80/443/443-udp),
  deploy/Caddyfile, deploy/ntfy/server.yml, deploy/.env.example (nur Platzhalter).
- deploy/README.md auf Deutsch für einen Laien: VPS, DNS, Firewall, .env (Secrets erzeugen), Start,
  ntfy-Benutzer/ACL/Token (ntfy user/access/token), buddy-server user add, Handy (Android + iOS) und PC
  einrichten, Backup außer Haus, Updates, Fehlersuche. Jeder Befehl kopierbar.
Prüfen: Ist Docker verfügbar, das Image bauen und `docker compose config` ausführen; sonst
statisch prüfen und das ehrlich berichten. Den Server-Start ohne Docker mit den Beispiel-Variablen testen.
```

### Phase F – Integration (Orchestrator selbst)

```text
1. Alle Zweige integrieren; buddy-core-Änderungswünsche aus den Berichten umsetzen.
2. Lokaler End-to-End-Aufbau: buddy-server (Temp-DB) + Fake-ntfy (kleiner HTTP-Server, der Veröffentlichungen
   und Clear-Aufrufe protokolliert) + Desktop-App (Linux-Debug-Build unter Xvfb, XDG_DATA_HOME auf ein
   Testverzeichnis, HANDOFF §4) + Web-App (dist-web über den Server, Bedienung mit Playwright; Chromium ist
   vorinstalliert, nicht neu installieren).
3. Alle 12 Abnahmeszenarien aus PLAN_V3_SYNC §12 durchspielen und dokumentieren (Befehle, Screenshots).
4. docs/MANUAL_TESTS.md um v3 erweitern (Handtests nur für den Benutzer: VPS, iOS/Android, Windows-
   Anmeldeinformationsspeicher, zwei PCs). README, HANDOFF (Stand, Lektionen, offene Punkte) aktualisieren.
5. Version 0.3.0 (package.json, Cargo.toml, tauri.conf.json), NSIS-Installer cross-bauen, als ZIP liefern.
6. Abschlussbericht (§4).
```

### Phase G – optional (nur nach Rückfrage beim Benutzer)

```text
- SSE /api/v1/events (axum-Beispiel sse) + Desktop/Web hören darauf statt 60-s-Takt.
- GitHub Actions: windows-latest mit MSVC (npm run tauri build, Tests, clippy) – erfüllt die ToDo aus
  HANDOFF §8 – und ein Workflow, der das Server-Image nach GHCR baut.
```

---

## 4. Vorlage Abschlussbericht (an den Benutzer, Deutsch)

```text
## v3 – Ergebnis
**Was neu ist** (für den Benutzer verständlich, 5–8 Punkte)
**Getestet** (Befehl → Ergebnis; Abnahmeszenarien 1–12 mit Status)
**Nur kompiliert / statisch geprüft** (z. B. Docker-Compose ohne Docker, Windows-spezifischer Code)
**Nicht prüfbar – bitte selbst testen** (Verweis auf MANUAL_TESTS v3, die wichtigsten 5 Schritte)
**Entscheidungen** (neue D-Einträge, je ein Satz)
**Bekannte Einschränkungen / nächste Schritte**
**Lieferung** (Installer-ZIP, Pfad; Anleitung deploy/README.md)
```
