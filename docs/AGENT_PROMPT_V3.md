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
Du setzt v3 von Display Buddy um: Notiz-Synchronisation über einen eigenen Server, eine installierbare
Offline-Web-App (PWA) für Handy und Tablet und Push-Erinnerungen aufs Handy (ntfy). Änderungen werden auf PC und
Handy mit dem Zeitpunkt der Bearbeitung auf dem Gerät gestempelt; diese Zeitstempel entscheiden beim
Synchronisieren (Neueste gewinnt). Antworte dem Benutzer auf Deutsch; Code, Bezeichner und Commits auf Englisch.

Lies zuerst vollständig, in dieser Reihenfolge:
CLAUDE.md, docs/HANDOFF.md, docs/PLAN.md, docs/DECISIONS.md, docs/PLAN_V3_SYNC.md, docs/AGENT_PROMPT_V3.md.

Deine Rolle: Orchestrator. Du erledigst Phase 0 und Phase F selbst und gibst die Phasen A, B, C1, C2, D, E
(und optional G) an Subagenten, jeweils mit eigenem git-Worktree und den in PLAN_V3_SYNC §11 genannten
exklusiven Ordnern. Gib jedem Subagenten den Block „Gemeinsame Regeln“ (AGENT_PROMPT_V3 §2) und seinen
Phasenauftrag (§3) wörtlich mit. Reihenfolge: 0 → (A ∥ B ∥ C1 ∥ C2) → (D ∥ E) → F → optional G (nur nach
Rückfrage).

Vor Phase 0:
1. Bau-Umgebung wie in HANDOFF §4 einrichten (apt-Pakete, rustup target x86_64-pc-windows-gnu,
   tauri-cli), npm install, und alle bestehenden Checks einmal grün sehen. Rote Checks zuerst melden.
2. Die in PLAN_V3_SYNC §13 genannten Punkte prüfen (sqlx-Version, keyring-Windows-Store-Crate,
   reqwest-TLS unter MinGW, ntfy-Image-Tag, vite-plugin-pwa mit Vite 8, idb, Playwright-WebKit) und das
   Ergebnis als D-Eintrag festhalten.

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
- Zeitstempel-Regel (PLAN_V3_SYNC §5.3) gilt überall: updatedAt = korrigierte Gerätezeit zum Zeitpunkt der
  Bearbeitung, auch offline; der Server stempelt nie um (nur Klemme > 2 min Zukunft); Vergleich als
  Zeitpunkt, Format YYYY-MM-DDTHH:MM:SS.sssZ. LWW nur über die gemeinsamen Funktionen (buddy-core bzw.
  src/lib/sync), nie eigene Vergleiche schreiben.
- Desktop-Regeln: nur src/lib/api.ts ruft invoke()/listen(); außerhalb state.rs nie .state()/.state::<,
  immer try_app_state/try_state; neuer Command = commands/*.rs + generate_handler! + build.rs COMMANDS +
  capabilities + api.ts + api.test.ts + plan_commands() in tests/contract.rs; neue Settings-Felder =
  types.ts + DEFAULT_SETTINGS + model.rs + Test-JSON + Schlüsselzahl im Vertragstest.
- UI-Texte Deutsch; Animationen nur transform/opacity; prefers-reduced-motion; aria-label überall;
  Tastaturbedienung.

Quellen (verbindliche Reihenfolge)
1. Offizielle Dokumentation und offizielle Beispiele des jeweiligen Projekts (ntfy, axum/tower-http,
   Tauri inkl. plugins-workspace, TipTap, sqlx, Caddy, OWASP Cheat Sheets, RustCrypto, keyring-rs,
   chrono/chrono-tz, Docker; für die Web-App: MDN (mdn/content) inkl. Browser-Kompatibilität
   (mdn/browser-compat-data), vite-plugin-pwa (vite-pwa/docs) bzw. Workbox, idb (jakearchibald/idb),
   WebKit-Blog/-Bugzilla für iOS). Halte dich an die dort beschriebenen Vorgehensweisen.
   Browser-Funktionen nur nutzen, wenn browser-compat-data sie für Chrome Android UND Safari iOS
   ausweist – sonst nur als optionale Zusatzfunktion mit Fallback.
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
2. Reminder.updatedAt (Option<String>, serde default) in buddy-core und types.ts; schedule::set/ack/snooze/
   remove setzen es (mit übergebener „jetzt“-Zeit), fire() NICHT (PLAN_V3_SYNC §5.5). Tests anpassen.
3. In buddy-core: NoteRecord, ReminderRecord, OrderRecord, SyncChanges, PushRequest/PushResult,
   Fehlercodes; LWW-Funktionen note_wins/reminder_wins/order_wins inkl. Tiebreak-Regeln und Zeitstempel-
   Klemme (clamp_future); clock-Modul (Offset aus serverTime/RTT, Median der letzten 5, corrected_now).
4. Gemeinsame Testvektoren crates/buddy-core/tests/fixtures/lww_vectors.json und schedule_vectors.json
   (Gleichstand, Tombstone gegen Bearbeitung, due gegen scheduled, späte Offline-Änderung mit altem
   Zeitstempel, Zukunfts-Klemme; Wiederholungen täglich/werktags/wöchentlich/monatlich inkl. Monatsende und
   Sommerzeitwechsel in Europe/Berlin; Verschieben). Rust-Tests lesen sie.
5. TypeScript-Spiegel: src/lib/sync/ (Record-Typen + lww.ts), src/lib/clock.ts, src/lib/schedule.ts;
   Vitest liest DIESELBEN JSON-Dateien (TZ=Europe/Berlin für die Testläufe festlegen). Beide Sprachen grün.
6. Desktop-Vertrag festschreiben: types.ts + model.rs (Settings-Felder syncEnabled, syncServerUrl,
   syncDeviceName; SyncStatus inkl. pending und clockOffsetMs; NotesChangedPayload), Vertragstest
   (Schlüsselzahl) anpassen. Commands erst in Phase B.
7. DECISIONS.md: die v3-Einträge final machen (Versionen, Prüfergebnisse aus §13).
Checks: npm test, npm run build, cargo test (src-tauri, crates/buddy-core), clippy (Linux + windows-gnu),
cargo fmt --check, NSIS-Cross-Build. Commit, push.
```

### Phase A – Server-Kern (Subagent)

```text
Auftrag: buddy-server ohne Push, gemäß docs/PLAN_V3_SYNC.md §5.3–§5.4, §6 und §7 (ohne §7.3/§7.4).
Ordner (exklusiv): server/ (außer server/Dockerfile, server/src/reminders/, server/src/ntfy/).
Grundlage: crates/buddy-core (nur lesen; Änderungswünsche in den Bericht).

Umsetzen:
- Cargo-Projekt server/ (Rust 2024, eigenes Cargo.lock). axum 0.8.x, tokio, tower-http, sqlx (SQLite,
  runtime-tokio, migrate; query/query_as ohne Offline-Metadaten), argon2, chrono, chrono-tz, serde, tracing,
  rand. Konfiguration aus Umgebungsvariablen (§7.1), klare Fehlermeldung bei fehlenden Werten.
- Migrationen (§7.2), WAL, Transaktionen mit seq-Zählung, Revisionen, Tombstone-Bereinigung (min_cursor,
  410 full_resync_required), nächtliches VACUUM INTO mit 14 Ständen.
- CLI: serve, user add/passwd (Passwort über stdin), device list/revoke, revisions, restore.
- Auth: POST /devices (PC, Geräte-Token, nur SHA-256 gespeichert), DELETE /devices/current;
  POST/DELETE /session für die Web-App – jede Web-App-Instanz ist ein Gerät (kind=web, deviceId wird
  wiederverwendet, Session an device_id gebunden); Cookie __Host-buddy_session (Secure, HttpOnly,
  SameSite=Strict, Path=/), serverseitige Sessions, 30 Tage gleitend; CSRF-Prüfung (Sec-Fetch-Site,
  Origin-Fallback, X-Buddy-Request) für Cookie-Anfragen; Login-Bremse; Argon2id mit mindestens
  OWASP-Parametern. Quellen: OWASP Password Storage, Session Management, CSRF Prevention Cheat Sheets.
- Endpunkte aus §6 (ohne /actions und /events) inkl. Grenzen und Validierung. Es gibt KEINE CRUD-Endpunkte
  mit Serverzeit – geschrieben wird nur über /sync/push. Zeitstempel der Geräte unverändert übernehmen
  (nur Klemme > 2 min Zukunft, buddy-core::clamp_future); received_at nur zur Diagnose. Verlierer-Fassungen
  (replaced UND rejected) in note_revisions. /sync/push idempotent. Jede Antwort mit serverTime
  (Body bzw. Header X-Server-Time) und Cache-Control: no-store.
- Statische Auslieferung der Web-App aus BUDDY_WEB_DIR mit SPA-Fallback auf index.html (axum-Beispiel
  static-file-server); Cache-Header laut vite-plugin-pwa-Doku (no-cache für /, /index.html, /sw.js,
  /manifest.webmanifest und SPA-Pfade; immutable nur für /assets/*), manifest.webmanifest als
  application/manifest+json, CSP inkl. worker-src/manifest-src (§7.5).
- Graceful Shutdown (axum-Beispiel graceful-shutdown).
Tests: Router-Tests per tower::ServiceExt::oneshot (axum-Beispiel testing) gegen SQLite in einem
Temp-Verzeichnis: Login/Fehlversuche, Cookie-Attribute, CSRF-Ablehnung, Geräte-Token widerrufen,
Web-Gerät wiederverwenden, Sync push/pull inkl. LWW mit den gemeinsamen lww_vectors.json, späte
Offline-Änderung mit altem Zeitstempel (verliert gegen neuere, gewinnt gegen ältere), Klemme, Tombstones,
Paginierung, 410, Revisionen (replaced/rejected), Idempotenz, Grenzen, Cache-/CSP-Header, Manifest-MIME.
Checks: cd server && cargo test && cargo clippy --all-targets -- -D warnings && cargo fmt --check.
```

### Phase B – Desktop-Sync (Subagent)

```text
Auftrag: Sync-Client in der Desktop-App gemäß docs/PLAN_V3_SYNC.md §5, §8 (Server-Vertrag §6).
Ordner (exklusiv): src-tauri/src/sync/, src-tauri/src/commands/sync.rs, src/windows/settings/,
src/windows/notes/useNotesStore*, src/lib/api.ts, src/lib/api.test.ts, sowie die nötigen Einträge in
src-tauri/src/lib.rs, src-tauri/build.rs, src-tauri/capabilities/settings.json und notes.json,
src-tauri/tests/contract.rs, src-tauri/Cargo.toml, src-tauri/src/commands/mod.rs.
Hooks in commands/notes.rs und reminders.rs: nur minimale Aufrufe (Outbox markieren), sonst nichts ändern.

Umsetzen:
- HTTP über tauri_plugin_http::reqwest, nur Rust-seitig, keine JS-Permission (Tauri-Doku
  plugin/http-client; Muster D-07). TLS-Feature so wählen, dass der Build mit
  --target x86_64-pc-windows-gnu klappt; das selbst mit dem NSIS-Cross-Build prüfen.
- Token im Windows-Anmeldeinformationsspeicher über keyring-core und das Windows-Store-Crate
  (keyring-rs-README), hinter einem Trait; unter Linux in Tests ein Speicher-Mock.
- Outbox, state.json, Merge (reine Funktionen in sync/merge.rs, LWW nur aus buddy-core), Auslöser,
  Ablauf, Start-Pull vor dem Nachfeuern, Erst-Verbindung, Fehlerzustände (§8.2). Lock-Reihenfolge
  dokumentieren; kein Netz unter einem Lock.
- Uhr-Offset bei jeder Antwort messen (buddy-core::clock), in state.json speichern, über sync-status
  (clockOffsetMs) melden; sync::corrected_now() für die Erinnerungsaktionen in reminders.rs; Warnung bei
  |offset| > 2 min; Hinweis, wenn eine lokale Änderung „stale“ war (PLAN_V3_SYNC §5.3/§5.4).
- Commands sync_status/sync_connect/sync_disconnect/sync_now, Events sync-status und notes-changed
  (§8.3), komplette 4-Stellen-Regel inkl. api.ts, api.test.ts, plan_commands(), Least-Privilege-Test
  (sync_status auch für das Notizfenster).
- useNotesStore: updatedAt über src/lib/clock.ts (korrigierte Gerätezeit; ohne Sync Offset 0 = Verhalten
  wie 0.2.0); notes-changed einarbeiten (§8.4), TipTap setContent(json, { emitUpdate: false });
  Regressionstests in useNotesStore.races.test.ts.
- Einstellungsfenster: Abschnitt „Synchronisation“ (§8.5) mit Tests.
- Ohne Sync muss alles exakt wie 0.2.0 funktionieren.
Tests: Merge/LWW/Outbox als Unit-Tests; Client gegen lokalen HTTP-Mock (Dev-Dependency, z. B. ein
minimaler axum- oder std-TcpListener-Server); Frontend-Tests für Settings-Abschnitt und Store.
Checks: npm test, npm run build, cd src-tauri && cargo test, cargo clippy --all-targets -- -D warnings,
cargo clippy --all-targets --target x86_64-pc-windows-gnu -- -D warnings, cargo fmt --check,
npm run tauri build -- --target x86_64-pc-windows-gnu (muss bauen).
```

### Phase C1 – Web-Datenschicht und Sync-Engine (Subagent)

```text
Auftrag: offline-first Datenhaltung und Synchronisation der Web-App gemäß docs/PLAN_V3_SYNC.md §5.3–§5.5,
§9.2 und §9.3 gegen den API-Vertrag §6.
Ordner (exklusiv): src/web/data/, src/web/sync/ (+ devDependency fake-indexeddb und dependency idb in
package.json – nur diese Einträge). src/lib/sync/, src/lib/clock.ts, src/lib/schedule.ts nur benutzen,
nicht ändern (Wünsche in den Bericht).
Quellen: idb-README (openDB/upgrade), MDN Using IndexedDB, Storage quotas and eviction criteria,
StorageManager.persist, navigator.onLine, Web Locks API, Broadcast Channel API, Background Synchronization
API; mdn/browser-compat-data für die Verfügbarkeit (Background Sync nur Chromium → nur optional).

Umsetzen:
- src/web/data/: IndexedDB „display-buddy“ v1 mit Stores notes, reminders, meta, outbox; Upgrade-Pfad;
  die Schnittstelle aus §9.2 exakt (listNotes, getNote, saveNote, deleteNote, saveOrder, setReminder,
  removeReminder, ackReminder, snoozeReminder, pendingCount, subscribe, signOut). Jede Änderung: updatedAt
  = clock.correctedNow(), Datensatz + Outbox-Eintrag in EINER Transaktion; Outbox fasst je Dokument auf die
  letzte Fassung zusammen. Erinnerungsaktionen offline über src/lib/schedule.ts. storage.persist() nach dem
  Login. signOut mit Rückfrage-Möglichkeit bei offenen Änderungen.
- src/web/sync/: Engine mit Auslösern (Start, online, visibilitychange, 60 s sichtbar, 2 s nach Änderung,
  manuell), Backoff 5 s/30 s/2 min/5 min, navigator.onLine nur als Hinweis; Push ≤ 200 → Ergebnisse
  (stale → Serverfassung übernehmen + Hinweis-Ereignis) → Pull ab cursor → Merge über src/lib/sync/lww.ts;
  Uhr-Offset messen (Median der letzten 5, RTT < 5 s); 401 → Zustand „Anmeldung nötig“, Outbox bleibt;
  410 → Voll-Neuladen + Merge, Outbox bleibt; navigator.locks.request('buddy-sync') gegen parallele Läufe;
  BroadcastChannel('buddy-data') für andere Tabs; optional SyncManager, falls vorhanden. Eine einzige
  fetch-Stelle (src/web/sync/http.ts: credentials same-origin, Header X-Buddy-Request: 1, Fehlercodes →
  deutsche Meldungen). Status als beobachtbarer Zustand für die Oberfläche (state, pending, lastSyncAt,
  clockOffsetMs, message).
Tests (Vitest mit fake-indexeddb und gemocktem fetch, simulierte Uhr): Offline-Bearbeitung landet in
IndexedDB + Outbox; App-Neustart (neue DB-Verbindung) behält alles; Wiederverbindung sendet die Outbox;
Szenarien 16a/16b/16c aus PLAN_V3_SYNC §12; stale-Hinweis; 401/410; Backoff; Zusammenfassen der Outbox;
Lock verhindert Doppel-Sync; BroadcastChannel-Benachrichtigung.
Checks: npm test, npm run build.
```

### Phase C2 – Web-Oberfläche und installierbare PWA (Subagent)

```text
Auftrag: Oberfläche und PWA-Hülle gemäß docs/PLAN_V3_SYNC.md §9.1 und §9.4.
Ordner (exklusiv): src/web/ui/, src/web/main.tsx, web.html, vite.web.config.ts, public-web/,
package.json (nur Skripte dev:web/build:web, devDependency vite-plugin-pwa, ggf. Vitest-Include).
Geteilte Komponenten (src/components/editor/, src/lib/search.ts, src/lib/datetime.ts) nur lesen.
Bis C1 fertig ist, gegen einen In-Memory-Fake der Schnittstelle §9.2 und des Sync-Status entwickeln
(src/web/ui/testing/fakeData.ts); nach der Integration läuft alles über src/web/data und src/web/sync.
Quellen: MDN Making PWAs installable, Installing, Trigger install prompt, Create a standalone app, Define
app icons; vite-plugin-pwa-Doku (Getting Started, PWA Minimal Requirements, Prompt for update, React,
Register service worker, generateSW, Deployment/Cache-Control); TipTap-Doku (Schema-Parität, setContent).

Umsetzen:
- vite.web.config.ts mit vite-plugin-pwa: generateSW, registerType 'prompt', injectRegister null,
  navigateFallback '/index.html', navigateFallbackDenylist [/^\/api\//], cleanupOutdatedCaches; Ausgabe
  dist-web/. Prüfe, dass die gewählte vite-plugin-pwa-Version Vite 8 unterstützt (sonst im Bericht melden
  und mit dem Orchestrator eine Alternative nach Workbox-Doku abstimmen).
- Manifest laut §9.1 (name, short_name, description, lang de, start_url, scope, display standalone,
  theme/background color, Icons 192/512 + maskable), web.html mit viewport, title, description, favicon,
  apple-touch-icon 180, theme-color. Icons aus dem Buddy-Smiley erzeugen (eigenes Motiv, kein fremdes Logo).
- Installieren: beforeinstallprompt (nur Chromium) → Knopf „App installieren“; iOS/Firefox → Hinweiskarte
  (Safari: Teilen → „Zum Home-Bildschirm“, mit dem Hinweis, dass Offline-Daten nur in der installierten App
  dauerhaft bleiben); installiert erkannt über display-mode: standalone.
- Update-Banner über useRegisterSW (needRefresh → „Neue Version verfügbar – Aktualisieren“); vor
  updateServiceWorker(true) warten, bis alle Speichervorgänge in IndexedDB abgeschlossen sind.
- Seiten /login, /, /notes/<id>, /new, /setup, /settings; dieselben TipTap-Extensions wie am Desktop;
  NoteEditor/Toolbar wiederverwenden; Suche, Farbe, Erinnerungen inkl. fälliger Liste/Banner; Statusleiste
  (synchronisiert/offline mit Anzahl wartender Änderungen/Konflikt-Hinweis/Uhr-Warnung); Login-Seite zeigt
  „n Änderungen werden nach dem Anmelden übertragen“; Abmelden mit Rückfrage bei offenen Änderungen.
- Mobilgerecht (Ziele ≥ 44 px, umbrechende Toolbar, Safe-Area im Standalone-Modus), aria-label, Tastatur,
  prefers-reduced-motion, deutsche Texte.
Tests: Vitest + Testing Library gegen den Fake: Login, Liste/Suche, Bearbeiten + Autosave, Erinnerungs-
aktionen, Offline-Status, Install-Knopf/-Hinweis (beforeinstallprompt simulieren, iOS-UA), Update-Banner;
Build-Test: dist-web enthält manifest.webmanifest mit allen Pflichtfeldern, sw.js und Icons in 192/512.
Checks: npm test, npm run build (Desktop unverändert), npm run build:web.
```

### Phase D – Erinnerungen und ntfy auf dem Server (Subagent)

```text
Auftrag: Server-Scheduler und Push gemäß docs/PLAN_V3_SYNC.md §5.5, §7.3, §7.4.
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
  ntfy-Benutzer/ACL/Token (ntfy user/access/token), buddy-server user add, Handy einrichten (Web-App
  öffnen, anmelden, installieren – Android: „App installieren“, iOS: Safari → Teilen → „Zum
  Home-Bildschirm“; ntfy-App + Topic), PC einrichten, Backup außer Haus, Updates (Hinweis: die Web-App
  zeigt danach „Neue Version verfügbar“), Fehlersuche. Jeder Befehl kopierbar.
- Caddy darf die Cache-Header von buddy-server nicht überschreiben (kein zusätzliches Caching für
  /, /index.html, /sw.js, /manifest.webmanifest).
Prüfen: Ist Docker verfügbar, das Image bauen und `docker compose config` ausführen; sonst
statisch prüfen und das ehrlich berichten. Den Server-Start ohne Docker mit den Beispiel-Variablen testen.
```

### Phase F – Integration (Orchestrator selbst)

```text
1. Alle Zweige integrieren; buddy-core-Änderungswünsche aus den Berichten umsetzen.
2. Lokaler End-to-End-Aufbau: buddy-server (Temp-DB) + Fake-ntfy (kleiner HTTP-Server, der Veröffentlichungen
   und Clear-Aufrufe protokolliert) + Desktop-App (Linux-Debug-Build unter Xvfb, XDG_DATA_HOME auf ein
   Testverzeichnis, HANDOFF §4) + Web-App (dist-web über den Server auf http://localhost – laut MDN für
   Service Worker/Installierbarkeit zulässig; Bedienung mit Playwright, Chromium ist vorinstalliert, nicht
   neu installieren; WebKit nur, falls vorhanden). Offline über context.setOffline(true); Handy-Uhr-
   Abweichung über eine überschriebene Zeit im Browser-Kontext (z. B. page.clock) simulieren.
3. Alle 20 Abnahmeszenarien aus PLAN_V3_SYNC §12 durchspielen und dokumentieren (Befehle, Screenshots),
   besonders 13–20 (Installierbarkeit, Offline-Start, Offline-Bearbeitung, Zeitstempel-Fälle 16a–c,
   abgelaufene Session, Update, zwei Tabs, gleiche Entscheidungen in Rust und TypeScript).
4. docs/MANUAL_TESTS.md um v3 erweitern (Handtests nur für den Benutzer: VPS, Installation unter Android
   und iOS, Flugmodus-Bearbeitung, 7-Tage-Test auf iOS, ntfy unter Android/iOS, Windows-
   Anmeldeinformationsspeicher, zwei PCs). README, HANDOFF (Stand, Lektionen, offene Punkte) aktualisieren.
5. Version 0.3.0 (package.json, Cargo.toml, tauri.conf.json), NSIS-Installer cross-bauen, als ZIP liefern.
6. Abschlussbericht (§4).
```

### Phase G – optional (nur nach Rückfrage beim Benutzer)

```text
- SSE /api/v1/events (axum-Beispiel sse) + Desktop/Web hören darauf statt 60-s-Takt.
- GitHub Actions: windows-latest mit MSVC (npm run tauri build, Tests, clippy) – erfüllt die ToDo aus
  HANDOFF §8 – und ein Workflow, der das Server-Image nach GHCR baut.
- Web Push direkt in der installierten Web-App (VAPID; iOS nur für Home-Bildschirm-Apps) als mögliche
  Alternative zur ntfy-App – nur nach Entscheidung des Benutzers, vorher MDN Push API und
  browser-compat-data prüfen.
```

---

## 4. Vorlage Abschlussbericht (an den Benutzer, Deutsch)

```text
## v3 – Ergebnis
**Was neu ist** (für den Benutzer verständlich, 5–8 Punkte)
**Getestet** (Befehl → Ergebnis; Abnahmeszenarien 1–20 mit Status)
**Nur kompiliert / statisch geprüft** (z. B. Docker-Compose ohne Docker, Windows-spezifischer Code)
**Nicht prüfbar – bitte selbst testen** (Verweis auf MANUAL_TESTS v3, die wichtigsten 5 Schritte)
**Entscheidungen** (neue D-Einträge, je ein Satz)
**Bekannte Einschränkungen / nächste Schritte**
**Lieferung** (Installer-ZIP, Pfad; Anleitung deploy/README.md)
```
