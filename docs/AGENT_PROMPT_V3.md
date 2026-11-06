# Prompts für die ausführenden Agenten – v3

Diese Datei enthält:
1. den **Start-Prompt für den Orchestrator** (in eine neue Claude-Code-Session kopieren),
2. die **gemeinsamen Regeln** für jeden Subagenten,
3. je einen **Auftrag pro Phase** (0, A, B, C1, C2, D, E, N1, N2, F, G),
4. die **Vorlage für den Abschlussbericht**.

Grundlage ist `docs/PLAN_V3_SYNC.md` (dritte Fassung). Bei Widersprüchen gilt der Plan; Abweichungen werden in
`docs/DECISIONS.md` begründet.

---

## 1. Start-Prompt für den Orchestrator

```text
Du setzt v3 von Display Buddy um:
- Notiz-Synchronisation über einen eigenen Server (VPS);
- eine installierbare Offline-Web-App (PWA), die Erinnerungen selbst per Web Push anzeigt;
- eine native Android/iOS-Hülle (Tauri 2 Mobile), die synchronisierte Erinnerungen lokal plant und deshalb auch
  ohne Internet klingelt;
- Erinnerungen mit eigener Zeitzone, damit PC und Handy auch in verschiedenen Zonen zuverlässig zusammenarbeiten.
Änderungen werden auf jedem Gerät mit der Bearbeitungszeit (UTC, korrigierte Gerätezeit) gestempelt; die neueste
gewinnt. ntfy wird NICHT verwendet.
Antworte dem Benutzer auf Deutsch; Code, Bezeichner und Commits auf Englisch.

Lies zuerst vollständig, in dieser Reihenfolge:
CLAUDE.md, docs/HANDOFF.md, docs/PLAN.md, docs/DECISIONS.md, docs/PLAN_V3_SYNC.md, docs/AGENT_PROMPT_V3.md.

Deine Rolle: Orchestrator.
- Phase 0 und Phase F erledigst du selbst.
- Die Phasen A, B, C1, C2, D, E, N1, N2 (und optional G) gibst du an Subagenten, jeweils mit eigenem git-Worktree
  und den exklusiven Ordnern aus PLAN_V3_SYNC §12.
- Gib jedem Subagenten den Block „Gemeinsame Regeln“ (§2) und seinen Phasenauftrag (§3) wörtlich mit.
- Reihenfolge: 0 → (A ∥ B ∥ C1 ∥ C2) → (D ∥ E ∥ N1) → N2 → F → optional G (nur nach Rückfrage).

Vor Phase 0:
1. Bau-Umgebung wie in HANDOFF §4 einrichten, npm install, alle bestehenden Checks einmal grün sehen.
   Rote Checks zuerst melden.
2. Die Prüfpunkte aus PLAN_V3_SYNC §14 klären und als D-Einträge festhalten: Versionen von sqlx, web-push,
   vite-plugin-pwa (Vite 8), idb und Tauri-Plugins; keyring-Stores; reqwest-TLS unter MinGW; Android-SDK in
   der Cloud bzw. Bauen über GitHub Actions.
3. Dem Benutzer vor Phase N1/N2 diese Fragen stellen (als Multiple-Choice):
   - Hat er einen Mac oder sollen iOS-Builds über GitHub Actions macOS laufen?
   - Will er das Apple Developer Program (99 USD/Jahr) nutzen?
   - Soll Phase N2 (nativer Push mit Firebase/APNs) umgesetzt werden?

Produktfragen stellst du dem Benutzer als Multiple-Choice-Frage, technische Details entscheidest du selbst und
begründest sie in docs/DECISIONS.md. Die Entscheidungen in PLAN_V3_SYNC §1 sind gesetzt.

Nach jeder Phase:
- Ergebnis prüfen: Diff lesen, alle Checks selbst laufen lassen.
- Integrieren, Konflikte lösen, erneut grün, committen, pushen.

Am Ende: Abschlussbericht (§4), ehrlich getrennt nach „getestet“, „nur kompiliert/statisch geprüft“ und
„nicht prüfbar (nur Benutzer)“. Installer, APK und Anleitungen als ZIP liefern (HANDOFF §2).
```

---

## 2. Gemeinsame Regeln (jedem Subagenten mitgeben)

```text
GEMEINSAME REGELN – Display Buddy v3

Projekt & Vertrag
- Lies CLAUDE.md, docs/HANDOFF.md (§5 Lektionen!), docs/PLAN_V3_SYNC.md (verbindlich).
- Arbeite NUR in den Ordnern deines Auftrags. Änderungen außerhalb beschreibst du präzise im Bericht.
- Daten- und API-Vertrag: PLAN_V3_SYNC §5 und §6. Abweichungen begründen.
- Desktop-Regeln:
  - nur src/lib/api.ts ruft invoke()/listen();
  - außerhalb state.rs nie .state(), immer try_state;
  - 4-Stellen-Regel für Commands;
  - Settings-Felder in types.ts + model.rs + Tests.
- UI-Texte Deutsch; Animationen nur transform/opacity; prefers-reduced-motion; aria-label; Tastatur.

Zeit, Zeitstempel, Zeitzonen (PLAN_V3_SYNC §5.3–§5.5, gilt überall)
- updatedAt = korrigierte Gerätezeit (UTC, YYYY-MM-DDTHH:MM:SS.sssZ) zum Zeitpunkt der Bearbeitung, auch
  offline. Der Server stempelt nie um (nur Klemme > 2 min Zukunft). Zeitpunkte als Zeitpunkte vergleichen.
- LWW, Uhr-Korrektur und Erinnerungsmathe NUR über die gemeinsamen Funktionen:
  - Rust: buddy-core;
  - TypeScript: src/lib/sync, src/lib/clock.ts, src/lib/zoned.ts, src/lib/schedule.ts;
  - nie eigene Vergleiche oder Datumsrechnungen schreiben.
- Erinnerungen rechnen in reminder.timeZone (IANA), nie in der Gerätezone. „Jetzt“ ist immer UTC.
  - Anzeige in der Gerätezone, bei abweichender Zone mit Originalzeit, z. B. „03:00 (09:00 Berlin)“.
  - Nur das handelnde Gerät berechnet ein neues `at`; alle anderen übernehmen es.
- Kein `new Date()` / `Local::now()` direkt in Geschäftslogik: Uhr injizieren (Tests mit simulierter Zeit).

Quellen (verbindliche Reihenfolge)
1. Offizielle Dokumentation und Beispiele, insbesondere:
   - Server: axum/tower-http, sqlx, OWASP Cheat Sheets, RustCrypto, chrono/chrono-tz, Caddy, Docker;
   - Desktop & Hülle: Tauri (tauri-docs, plugins-workspace inkl. Quellcode der Plugins), keyring-rs;
   - Editor: TipTap;
   - Web & Push: MDN (mdn/content) + Browser-Kompatibilität (mdn/browser-compat-data), vite-plugin-pwa
     (vite-pwa/docs) bzw. Workbox, idb, Apple „Sending web push notifications in web apps and browsers“
     (developer.apple.com, JSON unter /tutorials/data/documentation/…), web-push-Crate (pimeys/rust-web-push),
     WebKit-Blog/-Bugzilla;
   - nativer Push: Firebase/FCM-Doku, Apple APNs-Doku.
   Halte dich an die dort beschriebenen Vorgehensweisen.
2. Bei Problemen: GitHub Issues/Discussions/Changelogs des betroffenen Projekts.
3. Danach Stack Overflow.
- Browser-Funktionen nur als Pflicht nutzen, wenn browser-compat-data sie für Chrome Android UND Safari iOS
  ausweist. Sonst nur als optionale Ergänzung mit Fallback (Beispiele: Notification-actions,
  notificationclick, tag, Background Sync).
- Sind Doku-Webseiten per Proxy gesperrt, lies die Doku-Quelltexte aus dem offiziellen GitHub-Repo
  (git clone --depth 1 --filter=blob:none --sparse …) oder nutze WebSearch. Proxy nie umgehen, TLS-Prüfung nie
  abschalten.
- Fundstelle im Commit-Text oder Bericht vermerken. Keinen Code ungeprüft kopieren; Lizenzen beachten.
- Versionen prüfen (cargo info, npm view), exakt pinnen, im Bericht nennen.

Qualität
- Reine Logik zuerst testen. Kein echtes Netz in Unit-Tests: Mock-Server, Fake-Push-Dienst, simulierte Uhr.
- Checks deines Bereichs vor jedem Commit: alle grün, clippy -D warnings, cargo fmt. Windows-Code zusätzlich mit
  --target x86_64-pc-windows-gnu.
- Kleine, thematische Commits (Englisch). Keine TODO-Stubs als fertig. Keine Tests abschwächen.
- Keine Geheimnisse ins Repo (Passwörter, Tokens, VAPID-/APNs-Schlüssel, google-services.json, Keystores).
  Beispielwerte nur in .env.example. CI-Geheimnisse nur als GitHub-Secrets mit Namen dokumentieren.
- Logs enthalten nie Notizinhalt, Passwörter, Tokens, Push-Endpunkte oder Schlüssel.

Bericht am Ende (Pflicht, Deutsch)
- Was umgesetzt ist (Dateien); was getestet ist (Befehle + Ergebnis); was nur kompiliert; was offen ist.
- Gewählte Versionen und Entscheidungen mit Quelle (Vorschlag für DECISIONS.md).
- Nötige Änderungen außerhalb deiner Ordner.
```

---

## 3. Phasenaufträge

### Phase 0 – Fundament (Orchestrator selbst)

```text
1. crates/buddy-core (Rust 2024, ohne Tauri/axum).
   - Verschieben: src-tauri/src/reminders/schedule.rs und text.rs, Note, NoteColor (inkl. lenient), Reminder,
     ReminderRepeat, ReminderState, RemindersFile, is_valid_note_id.
   - model.rs re-exportiert (pub use); path-Dependency, kein Workspace.
   - Reiner Refactor: alle Tests, clippy (Linux + windows-gnu) und NSIS-Cross-Build grün.
2. Reminder bekommt updatedAt (Option<String>) und timeZone (Option<String>, IANA), beide serde default.
   - schedule::set/ack/snooze/remove setzen updatedAt (mit übergebenem „jetzt“) und rechnen in der Zone der
     Erinnerung: chrono-tz; Fallback: übergebene Standardzone.
   - fire() setzt updatedAt NICHT. sanitize füllt eine fehlende Zone mit der übergebenen Standardzone.
3. buddy-core:
   - Sync-Datensätze (NoteRecord, ReminderRecord, OrderRecord, SyncChanges, PushRequest inkl. deviceState,
     PushResult);
   - LWW (note/reminder/order_wins, Tiebreak, due vor scheduled, clamp_future);
   - clock (Offset aus serverTime/RTT, Median 5, corrected_now);
   - Wandzeit↔Zeitpunkt in einer IANA-Zone (Lücke → nächste gültige Zeit, Doppelung → frühere).
4. Gemeinsame Testvektoren crates/buddy-core/tests/fixtures/:
   - lww_vectors.json: Gleichstand, Tombstone gegen Bearbeitung, due gegen scheduled, späte Offline-Änderung,
     Zukunfts-Klemme.
   - schedule_vectors.json:
     - Zonen Europe/Berlin, America/New_York, Asia/Tokyo, Australia/Lord_Howe, Asia/Kolkata;
     - Fälle täglich, werktags, wöchentlich, monatlich inkl. Monatsende;
     - Sommerzeit-Lücken und -Doppelungen; die Wochen mit unterschiedlicher Umstellung EU/USA;
     - Verschieben; Wandzeit→Zeitpunkt.
5. TypeScript-Spiegel:
   - src/lib/sync/ (Typen + lww.ts), src/lib/clock.ts;
   - src/lib/zoned.ts (Intl.DateTimeFormat mit timeZone/formatToParts; KEIN Temporal, da Safari es nicht hat);
   - src/lib/schedule.ts.
   Vitest liest DIESELBEN JSON-Dateien. Testläufe zusätzlich mit TZ=America/New_York und TZ=Asia/Tokyo
   (npm-Skripte test:tz). Beide Sprachen grün.
6. Desktop-Vertrag in types.ts + model.rs:
   - Settings-Felder; SyncStatus (pending, clockOffsetMs); NotesChangedPayload;
   - set_reminder bekommt das Argument timeZone. PLAN-Liste in contract.rs, api.ts, api.test.ts anpassen; die
     Umsetzung des Commands macht Phase B.
7. DECISIONS.md final (Versionen, Prüfergebnisse).
Checks: npm test (+ test:tz), npm run build, cargo test (src-tauri, crates/buddy-core), clippy (Linux +
windows-gnu), cargo fmt --check, NSIS-Cross-Build.
```

### Phase A – Server-Kern (Subagent)

```text
Auftrag: buddy-server ohne Push-Versand, gemäß PLAN_V3_SYNC §5, §6, §7.1, §7.2 und §7.5.
Ordner (exklusiv): server/ (außer server/Dockerfile, server/src/reminders/, server/src/push/).
- Projekt: axum 0.8.x, tokio, tower-http, sqlx (SQLite, migrate; query/query_as), argon2, chrono, chrono-tz,
  tracing, buddy-core. Konfiguration aus Umgebungsvariablen (§7.1).
- CLI: serve, user add/passwd, device list/revoke, revisions, restore, vapid generate (P-256-Schlüssel als PEM
  mit Rechten 0600; öffentlicher Schlüssel base64url ableitbar).
- Migrationen §7.2 inkl. devices.kind/synced_seq/scheduled_seq/local_notifications/native_push_*,
  push_subscriptions, push_log pro Gerät.
- Auth:
  - POST /devices (kind desktop|mobile, Bearer-Token, nur SHA-256 gespeichert), DELETE /devices/current;
  - POST/DELETE /session (PWA = Gerät kind=web, deviceId wiederverwenden) mit __Host-Cookie;
  - CSRF-Prüfung, Login-Bremse, Argon2id (OWASP).
- Endpunkte: /health, /me, /sync/changes, /sync/push (einziger Schreibweg, idempotent, Gerätezeitstempel
  unverändert außer Klemme, Revisionen replaced/rejected, deviceState speichern, synced_seq setzen),
  GET /push/vapid-public-key. Keine CRUD-Endpunkte mit Serverzeit, keine Aktions-Token-URLs.
- Datensätze ohne timeZone: users.time_zone verwenden (PUT /me).
- Statische Auslieferung der PWA (SPA-Fallback, axum-Beispiel static-file-server). Cache-Header, Manifest-MIME und
  CSP laut §7.5. Graceful Shutdown.
Tests (tower::ServiceExt::oneshot, SQLite im Temp-Verzeichnis):
- Auth: Login/Bremse, Cookie-Attribute, CSRF, Geräte-Arten.
- Sync: LWW mit lww_vectors.json, späte Offline-Änderung, Klemme, Tombstones, Paginierung, 410, Revisionen,
  Idempotenz, deviceState/synced_seq.
- Sonstiges: Cache-/CSP-Header, VAPID-CLI.
Checks: cd server && cargo test && cargo clippy --all-targets -- -D warnings && cargo fmt --check.
```

### Phase B – Desktop (Subagent)

```text
Auftrag: Desktop-Sync und Erinnerungen mit Zeitzone gemäß PLAN_V3_SYNC §5 und §8.
Ordner (exklusiv):
- src-tauri/src/sync/, src-tauri/src/commands/sync.rs, src-tauri/src/commands/reminders.rs;
- src/windows/settings/, src/windows/notes/useNotesStore*, src/windows/notes/Reminder*, src/lib/api*;
- nötige Einträge in lib.rs, build.rs, capabilities/settings.json und notes.json, tests/contract.rs,
  Cargo.toml, commands/mod.rs;
- minimale Hooks in commands/notes.rs und reminders.rs.
- Sync-Client:
  - tauri_plugin_http::reqwest nur Rust-seitig; TLS-Backend muss mit x86_64-pc-windows-gnu bauen (selbst per
    NSIS-Cross-Build prüfen);
  - Token im Windows-Anmeldeinformationsspeicher (keyring-core + Windows-Store, hinter Trait, Mock für Linux);
  - Outbox, state.json, Merge nur mit buddy-core-LWW, Ablauf und Start-Pull vor dem Nachfeuern, Fehlerzustände;
  - Uhr-Offset + sync::corrected_now(); Hinweis bei „stale“; Lock-Reihenfolge dokumentieren.
- Commands sync_status/connect/disconnect/now, Events sync-status und notes-changed; 4-Stellen-Regel,
  Least-Privilege-Test.
- Erinnerungen:
  - set_reminder mit timeZone;
  - reminders.rs rechnet ack/snooze/Wiederholung über buddy-core in reminder.timeZone (Fallback: IANA-Zone des PCs
    per iana-time-zone) statt chrono::Local;
  - sanitize füllt fehlende Zonen.
- Reminder-Popover:
  - Eingabe in der Zone der Erinnerung, Zonen-Auswahl (Intl.supportedValuesOf('timeZone'));
  - „Bei dir: …“, wenn die Zone abweicht; Banner und Badge mit Originalzeit;
  - dafür src/lib/zoned.ts nutzen.
- useNotesStore: updatedAt über src/lib/clock.ts; notes-changed einarbeiten (setContent mit emitUpdate:false);
  Regressionstests in useNotesStore.races.test.ts.
- Einstellungsabschnitt „Synchronisation“.
Tests:
- Merge/Outbox; Client gegen HTTP-Mock;
- Erinnerungen mit fremder Zone (PC unter TZ=Europe/Berlin, Erinnerung in America/New_York und umgekehrt);
- Popover-Anzeige in mehreren Zonen; Store-Rennen.
Checks: npm test (+ test:tz), npm run build, cargo test, clippy (Linux + windows-gnu), fmt, NSIS-Cross-Build.
```

### Phase C1 – Web-Datenschicht und Sync-Engine (Subagent)

```text
Auftrag: Datenhaltung und Synchronisation für PWA UND native Hülle gemäß PLAN_V3_SYNC §5, §9.2, §9.3.
Ordner (exklusiv): src/web/data/, src/web/sync/ (+ dependency idb, devDependency fake-indexeddb in package.json).
Quellen: idb-README; MDN IndexedDB, Storage quotas, StorageManager.persist, navigator.onLine, Web Locks,
Broadcast Channel, Background Sync; browser-compat-data.
- Datenschicht exakt nach der Schnittstelle §9.2:
  - setReminder mit Wandzeit + timeZone → at über src/lib/zoned.ts;
  - jede Änderung mit korrigierter Gerätezeit und Outbox in EINER Transaktion; Outbox zusammenfassen;
  - persist() nach dem Login; signOut mit Rückfrage-Möglichkeit.
  Die Datenschicht ist ohne DOM nutzbar (auch im Service Worker und in der nativen Hülle).
- Sync-Engine:
  - Auslöser, Backoff, Push → Ergebnisse (stale + Hinweis-Ereignis) → Pull → Merge über src/lib/sync/lww.ts;
  - Uhr-Offset; 401/410 mit erhaltener Outbox; Web Locks; BroadcastChannel; SyncManager nur optional;
  - Statusobjekt (state, pending, lastSyncAt, clockOffsetMs, message).
- Plattform-Adapter http.ts mit zwei Implementierungen:
  - PWA: fetch same-origin, Cookie, X-Buddy-Request;
  - nativ: fetch aus @tauri-apps/plugin-http mit Bearer-Token aus einem injizierten Token-Provider.
  Optional deviceState-Callback für die native Planung (scheduledSeq, localNotifications).
Tests (fake-indexeddb, gemocktes fetch, simulierte Uhr):
- Offline-Bearbeitung, Neustart, Wiederverbindung;
- Szenarien 16a/16b/16c; stale; 401/410; Backoff; Outbox-Zusammenfassung; Lock; BroadcastChannel;
- setReminder in fremder Zone mit TZ-Variationen.
Checks: npm test (+ test:tz), npm run build.
```

### Phase C2 – Web-Oberfläche, PWA und Web Push im Client (Subagent)

```text
Auftrag: Oberfläche, installierbare PWA und Web-Push-Empfang gemäß PLAN_V3_SYNC §9.1, §9.4, §9.5.
Ordner (exklusiv): src/web/ui/, src/web/notify/ (ohne native*), src/web/sw.ts, src/web/main.tsx, web.html,
vite.web.config.ts, public-web/, package.json (Skripte, vite-plugin-pwa, workbox-precaching).
Bis C1 fertig ist, gegen einen In-Memory-Fake der Schnittstelle §9.2 und des Sync-Status arbeiten.
Quellen:
- MDN: Making PWAs installable, Installing, Trigger install prompt, Push API, Notifications API,
  ServiceWorkerRegistration.showNotification;
- browser-compat-data (actions, notificationclick, tag, navigate, pushsubscriptionchange auf Safari iOS!);
- Apple „Sending web push notifications in web apps and browsers“;
- vite-plugin-pwa (injectManifest, Prompt for update, React, Deployment/Cache-Control).
- PWA:
  - vite-plugin-pwa mit strategies 'injectManifest', srcDir/filename für src/web/sw.ts, registerType 'prompt',
    injectRegister null. Vite-8-Kompatibilität prüfen.
  - Manifest + Icons (eigenes Buddy-Motiv), web.html-Pflichtangaben.
  - Install-Knopf (beforeinstallprompt) und iOS/Firefox-Anleitung; Update-Banner erst nach abgeschlossenem
    Speichern.
- Service Worker src/web/sw.ts:
  - precacheAndRoute(self.__WB_MANIFEST), cleanupOutdatedCaches, Navigations-Fallback außer /api/.
  - push: IMMER showNotification. Text mit Gerätezeit + Originalzone; tag/data/actions/navigate nur, wo
    unterstützt (Notification.maxActions bzw. Feature-Check). Zustand „due“ in IndexedDB über die Datenschicht.
  - notificationclick (Chromium/Firefox): Aktionen ack/snooze10 über die Datenschicht, danach Sync-Versuch; sonst
    clients.openWindow('/notes/<id>').
- src/web/notify/:
  - „Benachrichtigungen aktivieren“: requestPermission + pushManager.subscribe({userVisibleOnly:true,
    applicationServerKey}) direkt im Klick-Handler (Nutzergeste);
  - PUT /push/subscription; Abgleich getSubscription() bei jedem Start (iOS kennt kein
    pushsubscriptionchange); Testbenachrichtigung;
  - im Safari-Tab: Hinweis „zuerst zum Home-Bildschirm hinzufügen“;
  - App-Badge (setAppBadge) für fällige Erinnerungen, wo vorhanden; erledigte Benachrichtigungen per
    getNotifications() schließen, wo vorhanden.
- Seiten /login, /, /notes/<id>, /new, /setup, /settings:
  - dieselben TipTap-Extensions, NoteEditor/Toolbar wiederverwenden;
  - Liste/Banner fälliger Erinnerungen mit Erledigt/10 Min.;
  - Erinnerungsdialog mit Zone und „Bei dir: …“; Statusleiste;
  - mobilgerecht, barrierefrei, deutsch.
- Die UI-Komponenten müssen auch in der nativen Hülle laufen: kein direkter Zugriff auf
  navigator.serviceWorker o. Ä. außerhalb von src/web/notify/ bzw. main.tsx.
Tests (Vitest + Testing Library gegen den Fake):
- Login, Liste/Suche, Bearbeiten/Autosave, Erinnerungen in fremder Zone;
- Install-Knopf/-Hinweis (beforeinstallprompt, iOS-UA), Update-Banner;
- Push-Abo-Ablauf (gemockte PushManager/Notification); SW-Handler als Einheit (push → showNotification
  immer; notificationclick → Datenschicht).
- Build-Test: dist-web mit gültigem Manifest, sw.js, Icons 192/512.
Checks: npm test (+ test:tz), npm run build, npm run build:web.
```

### Phase D – Server-Scheduler und Push-Versand (Subagent)

```text
Auftrag: Erinnerungen auf dem Server und Push pro Gerät gemäß PLAN_V3_SYNC §5.5, §7.3, §7.4.
Ordner (exklusiv): server/src/reminders/, server/src/push/ (+ Registrierung in main.rs/lib.rs, nötige
Migrationen in Absprache).
Quellen: Apple „Sending web push notifications in web apps and browsers“ (Header TTL/Urgency/Topic, 4 KB,
Fehlercodes, VAPID-JWT-Regeln); web-push-Crate (pimeys/rust-web-push, request_builder); MDN Push API.
- Scheduler: Notify-Wecken, ≤ 30 s Schlaf, injizierte Clock, due ohne updatedAt-Änderung, Nachfeuern beim Start,
  Vorkommen > 24 h nicht mehr senden.
- Versandregeln pro Gerät (§7.4) mit push_log (device_id, note_id, at):
  - web → Web Push;
  - mobile → nativer Kanal nur bei scheduled_seq < seq oder local_notifications = denied;
  - desktop → nichts.
- Web Push:
  - web-push 0.11 ohne Standard-Client; Anfrage über request_builder bauen, mit reqwest (rustls) senden;
  - Header TTL 86400, Urgency high, Topic r+base64url(sha256(noteId))[:31] (falls der Builder das nicht
    setzt, selbst ergänzen); aes128gcm;
  - VAPID-JWT ≤ 24 h, zwischenspeichern, höchstens stündlich neu;
  - Payload nach §7.4, ≤ 4 KB;
  - 404/410 → Abo löschen; 413 → kürzen; 429/5xx → 5 s/30 s/2 min.
- Endpunkte PUT/DELETE /push/subscription, POST /push/test.
- Nativer Kanal als Trait NativePushChannel (no-op bis Phase N2).
Tests:
- Fake-Push-Dienst, lokal, der verschlüsselte Anfragen mit dem Gegenschlüssel entschlüsselt und prüft;
- Zustandsübergänge mit simulierter Uhr; genau ein Push pro Gerät und Vorkommen; Topic beim Verschieben;
- Dedupe-Regel für mobile; 410-Aufräumen; Retry;
- Wiederholung in reminder.timeZone über DST-Grenzen (schedule_vectors.json); Test-Endpunkt.
Checks: cd server && cargo test && cargo clippy --all-targets -- -D warnings && cargo fmt --check.
```

### Phase E – Deployment (Subagent)

```text
Auftrag: Betrieb auf einem VPS gemäß PLAN_V3_SYNC §11. KEIN ntfy.
Ordner (exklusiv): deploy/, server/Dockerfile, .dockerignore.
Quellen: Caddy-Doku (reverse proxy, automatic HTTPS), Docker-Doku (Compose, Multi-Stage), vite-plugin-pwa
Deployment (Cache-Control).
- Dockerfile:
  - Multi-Stage: npm ci && npm run build:web → cargo build --release (server) → schlankes Laufzeit-Image;
  - non-root, /data-Volume, HEALTHCHECK, gepinnte Image-Tags.
- deploy/compose.yaml (caddy + buddy), Caddyfile (eine Domain, HSTS; Cache-Header des Servers nicht
  überschreiben), .env.example nur mit Platzhaltern.
- deploy/README.md (Deutsch, für Laien, jeder Befehl kopierbar):
  - VPS, DNS, Firewall, .env, vapid generate, Start, Benutzer anlegen;
  - Handy:
    - PWA öffnen → anmelden → installieren (Android: „App installieren“, iOS: Safari → Teilen →
      „Zum Home-Bildschirm“);
    - „Benachrichtigungen aktivieren“, Testbenachrichtigung;
    - Hinweis „PWA ODER native App pro Handy“;
  - PC verbinden;
  - Backups inklusive vapid.pem; Updates (die PWA zeigt danach „Neue Version verfügbar“); Fehlersuche.
- Ausgehendes Netz des VPS zu den Push-Diensten dokumentieren.
Prüfen: Wenn Docker verfügbar ist, Image bauen und `docker compose config`; sonst statisch prüfen und ehrlich
berichten. Server-Start ohne Docker mit Beispiel-Variablen testen.
```

### Phase N1 – Native Hülle mit lokaler Planung (Subagent)

```text
Auftrag: Tauri-2-Mobile-App für Android und iOS gemäß PLAN_V3_SYNC §10.1–§10.4 und §10.6.
Ordner (exklusiv): mobile/, vite.mobile.config.ts, src/web/notify/native*, .github/workflows/mobile-*.yml,
package.json (nur Skript build:mobile + Tauri-Plugin-Pakete).
Quellen:
- tauri-docs: prerequisites, Mobile-Setup, plugin/notification, plugin/http-client, distribute/app-store,
  google-play, sign;
- Quellcode tauri-apps/plugins-workspace/plugins/notification (Android/iOS);
- keyring-rs (iOS/Android-Stores); Android-Doku zu exakten Alarmen und POST_NOTIFICATIONS.
- mobile/: eigenes Tauri-2-Projekt (Android + iOS) mit einem Fenster.
  - Frontend = src/web-Oberfläche, gebaut über vite.mobile.config.ts (ohne Service Worker/PWA-Plugin) mit
    Plattform-Adapter „nativ“ (Bearer über @tauri-apps/plugin-http, Scope auf BUDDY_PUBLIC_URL aus der
    Build-Konfiguration).
  - Anmeldung über POST /devices (kind mobile). Token sicher speichern (keyring-core-Stores; falls nicht
    tragfähig, offizielles Tauri-Plugin für sicheren Speicher, begründen).
  - IndexedDB-Persistenz in WKWebView und Android-WebView prüfen; sonst tauri-plugin-sql hinter der Schnittstelle
    §9.2 (Absprache mit dem Orchestrator).
- src/web/notify/native*: lokale Planung nach §10.3.
  - Erlaubnisse (POST_NOTIFICATIONS, exakte Alarme, iOS requestPermission); Channel „Erinnerungen“.
  - Plan erneuern nach Sync, lokaler Änderung, Start und Fortsetzen: Schedule.at(new Date(at), false, true),
    stabile IDs aus noteId+at, cancel/removeActive, höchstens 60 Einträge (iOS-Grenze 64).
  - Aktionen „Erledigt“/„10 Min. später“ über registerActionTypes/onAction → Datenschicht (offline) → neu planen.
  - deviceState (scheduledSeq, localNotifications) an die Sync-Engine melden.
- Prüfung §10.4 (iOS-Datumsparser des Plugins): Test-Bildschirm/Debug-Funktion „in 2 min erinnern“ und Vergleich
  mit pending(). Bei Abweichung GitHub-Issues durchsuchen bzw. anlegen und eine dokumentierte Umgehung (Test!)
  einbauen.
- CI:
  - mobile-android.yml (ubuntu-latest: SDK/NDK, signierte Release-APK aus GitHub-Secrets, Artefakt);
  - mobile-ios.yml (macos-latest: Build; Signierung nur, wenn Secrets vorhanden);
  - Android-Emulator-Test für Szenario 28/29, falls im Runner möglich.
- mobile/README.md (Deutsch):
  - Android: APK installieren, Erlaubnisse inkl. „Exakte Alarme“, Energiesparmodus-Ausnahme;
  - iOS: Mac/Xcode oder CI, Apple Developer Program/TestFlight bzw. kostenloses Konto mit 7-Tage-Signatur;
  - Hinweis „PWA ODER native App“.
Tests:
- Vitest für die Planungslogik mit gemocktem Plugin: welche IDs bei welchen Änderungen; 60er-Grenze; Zonenwechsel;
  Aktionen offline.
- Builds in CI; Emulator-Test nach Möglichkeit.
Checks: npm test (+ test:tz), npm run build:mobile; Android-Build (CI), iOS-Build (CI); ehrlich berichten, was
nur in CI oder gar nicht ausgeführt werden konnte.
```

### Phase N2 – Nativer Push (Subagent, nur nach Zustimmung des Benutzers)

```text
Auftrag: native App aufwecken, wenn sie eine Erinnerung noch nicht kennt (PLAN_V3_SYNC §10.5, §7.4).
Ordner (exklusiv): mobile/ (Push-Teil), server/src/push/native*.
Quellen: Firebase-Doku (FCM HTTP v1, Android-Einrichtung), Apple-Doku (APNs, Token-Authentifizierung),
README/Quellcode/Issues der Kandidaten-Plugins, Tauri „Mobile Plugin Development“.
- Plugin bewerten (tauri-plugin-notifications, tauri-plugin-remote-push, tauri-plugin-mobile-push): Pflege, Lizenz,
  Tauri-Version, iOS-Token-Art (APNs oder FCM). Ergebnis als D-Eintrag. Ist keines tragfähig, ein minimales
  eigenes Mobile-Plugin nach offizieller Anleitung bauen.
- App: Token holen, PUT /devices/current/push; Tipp → App öffnen → Sync → neu planen.
- Server:
  - NativePushChannel für FCM HTTP v1 (OAuth2 per Service-Account) und APNs (JWT aus .p8, HTTP/2), oder
    FCM für beide;
  - Fehlerbehandlung (ungültiger Token → löschen); Dedupe-Regel aus §7.4.
- Anleitung: Firebase-Projekt, google-services.json, APNs-Schlüssel; nur Platzhalter im Repo.
Tests:
- Server-Kanal gegen Fake-FCM/APNs; Dedupe (kein Push, wenn scheduled_seq aktuell);
- App-Logik mit gemocktem Plugin.
Checks: server (cargo test/clippy/fmt), npm test, CI-Builds.
```

### Phase F – Integration (Orchestrator selbst)

```text
1. Alle Zweige integrieren; Wünsche aus den Berichten umsetzen.
2. Lokaler End-to-End-Aufbau:
   - buddy-server mit Temp-DB;
   - Fake-Push-Dienst (Web Push annehmen, entschlüsseln, protokollieren, zurückhalten, 410 simulieren);
   - Desktop unter Xvfb mit TZ=Europe/Berlin (HANDOFF §4);
   - PWA über http://localhost mit Playwright/Chromium (vorinstalliert, nicht neu installieren):
     - Kontext mit timezoneId 'America/New_York';
     - Offline über context.setOffline;
     - Uhr über page.clock;
     - Benachrichtigungs-Erlaubnis über context.grantPermissions(['notifications']);
     - Push über den Fake-Dienst bzw. das DevTools-Protokoll auslösen.
   - Native Hülle im Android-Emulator in CI (Szenarien 28/29), falls möglich.
3. Alle Abnahmeszenarien aus PLAN_V3_SYNC §13 (1–30) durchspielen und dokumentieren (Befehle, Screenshots).
   Was nicht automatisierbar ist (iOS-Gerät, echte Push-Dienste), steht als Handtest in MANUAL_TESTS.md.
4. docs/MANUAL_TESTS.md um v3 erweitern; README, HANDOFF aktualisieren.
5. Version 0.3.0 (package.json, Cargo.toml, tauri.conf.json, mobile/), NSIS-Installer cross-bauen; APK aus CI
   holen. Alles als ZIP liefern.
6. Abschlussbericht (§4).
```

### Phase G – optional (nur nach Rückfrage beim Benutzer)

```text
- SSE /api/v1/events für Live-Updates (axum-Beispiel sse).
- GitHub Actions: Windows-Installer mit MSVC (HANDOFF §8), Server-Image nach GHCR.
- Declarative Web Push (WebKit, iOS/iPadOS ≥ 18.4) prüfen und ggf. als zusätzliches Payload-Format nutzen.
```

---

## 4. Vorlage Abschlussbericht (an den Benutzer, Deutsch)

```text
## v3 – Ergebnis
**Was neu ist** (5–8 Punkte, verständlich)
**Getestet** (Befehl → Ergebnis; Abnahmeszenarien 1–30 mit Status)
**Nur kompiliert / statisch geprüft** (z. B. iOS-Build ohne Gerät, Docker ohne Docker)
**Nicht prüfbar – bitte selbst testen** (Verweis auf MANUAL_TESTS v3, die wichtigsten Schritte für Android, iOS,
VPS)
**Entscheidungen** (neue D-Einträge, je ein Satz)
**Bekannte Einschränkungen / nächste Schritte**
**Lieferung** (Installer-ZIP, APK, Anleitungen deploy/README.md und mobile/README.md)
```
