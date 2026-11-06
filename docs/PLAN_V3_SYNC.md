# v3 – Notiz-Synchronisation, installierbare Offline-Web-App und Push-Erinnerungen (Plan)

Stand: 2026-11-06 (Nachtrag am selben Tag: installierbare Web-App, Offline-Speicher, Gerätezeitstempel) ·
Grundlage: Version 0.2.0 · Status: **geplant, noch nicht umgesetzt**

Dieser Plan ist für v3 so verbindlich wie `docs/PLAN.md` für v1/v2. Abweichungen nur mit Begründung in
`docs/DECISIONS.md`. Ausführende Agenten starten mit `docs/AGENT_PROMPT_V3.md`.

---

## 1. Ziel und Entscheidungen des Benutzers

Ziel: Erinnerungen, die an Notizen hängen, kommen als Push-Nachricht auf Android- und iOS-Handys, **auch wenn der
PC aus ist**. Notizen werden über einen eigenen Server synchronisiert. Am Handy gibt es eine **installierbare
Web-App (PWA)**, die Notizen **auch ohne Internet** lesen und bearbeiten kann und automatisch synchronisiert, sobald
die Verbindung zurück ist.

| Frage | Entscheidung (2026-11-06) |
|---|---|
| Architektur | Variante B: eigener Relay-/Sync-Server plant Erinnerungen und sendet Push, plus Notiz-Sync |
| Hosting | **VPS mit eigener Domain** (Docker Compose, HTTPS) |
| Handy | **Lesen und Bearbeiten** von Notizen und Erinnerungen |
| Handy-App (Nachtrag) | **Installierbar** auf Android und iOS (PWA, Home-Bildschirm) |
| Offline (Nachtrag) | Offline werden Notizen **lokal auf dem Gerät gespeichert**; ist das Internet wieder da, wird **automatisch synchronisiert** |
| Zeitstempel (Nachtrag) | **PC und Handy** stempeln jede Änderung mit dem Zeitpunkt der Bearbeitung auf dem Gerät; diese Zeitstempel entscheiden beim Synchronisieren |
| Verschlüsselung | **Keine Ende-zu-Ende-Verschlüsselung**; Schutz durch TLS, Login und Server-Härtung |
| Konflikte | **Neueste Änderung gewinnt** (Last-Writer-Wins pro Dokument, nach Zeitstempel der Bearbeitung) |

Annahmen (bei Bedarf beim Benutzer bestätigen):
- ein Benutzerkonto, mehrere Geräte (1–3 PCs, 1–2 Handys, auch Tablets),
- Zeitzone des Kontos = Zeitzone der Geräte,
- die Desktop-App bleibt **local-first** und funktioniert ohne Server genau wie 0.2.0.

Push-Nachrichten kommen weiterhin über die **ntfy-App**. Die Web-App ersetzt sie nicht, siehe Phase G.

## 2. Architektur

```
 Windows-PC (Display Buddy)                 VPS (Docker Compose)                           Handy / Tablet
┌───────────────────────────┐  HTTPS  ┌──────────── Caddy :443 (Auto-HTTPS) ───────────┐  ┌───────────────────────┐
│ storage/ (lokal, wie v2)  │◄──────► │ buddy.<domain> → buddy-server :8080             │◄►│ installierte Web-App  │
│ reminders/ (Toast lokal)  │         │ ntfy.<domain>  → ntfy :80                       │  │ (PWA): Service Worker │
│ sync/ (neu): Outbox,      │         └────────────────────────────────────────────────┘  │ = App-Hülle offline,  │
│   Push/Pull, LWW-Merge    │           buddy-server: axum + SQLite, eigener Erinnerungs-   │ IndexedDB = Notizen + │
└───────────────────────────┘           Scheduler, sendet intern an http://ntfy:80         │ Outbox, Sync-Engine   │
                                        ntfy: deny-all, upstream-base-url=https://ntfy.sh   ├───────────────────────┤
                                                                                            │ ntfy-App (Push,       │
                                                                                            │ Knöpfe „Erledigt“ …)  │
                                                                                            └───────────────────────┘
```

Grundsätze:
- **Alle Clients sind offline-first.** PC und Web-App speichern jede Änderung zuerst lokal (PC: Dateien wie bisher,
  Handy: IndexedDB), mit Zeitstempel und Eintrag in einer Outbox. Synchronisiert wird im Hintergrund, sobald der
  Server erreichbar ist. Der Server ist nie im kritischen Pfad einer Bearbeitung.
- **Ein Sync-Protokoll für alle.** PC und Web-App schreiben ausschließlich über `/sync/push` und lesen über
  `/sync/changes` (§6). Die LWW-Regel gibt es einmal in Rust (`buddy-core`) und einmal in TypeScript
  (`src/lib/sync/`). Gemeinsame Testvektoren stellen sicher, dass beide gleich entscheiden.
- **Gerätezeitstempel entscheiden.** `updatedAt` ist der Zeitpunkt der Bearbeitung auf dem Gerät (korrigiert um die
  gemessene Abweichung zur Serveruhr, §5.3). Der Server übernimmt ihn und stempelt nie um. Eine Offline-Änderung
  von 10:00, die erst um 14:00 ankommt, zählt daher als 10:00.
- **Server = Quelle für den Push.** Nur der Server sendet an ntfy. PC und Web-App sprechen nie mit ntfy, deshalb
  entstehen keine doppelten Nachrichten.
- **Der Server plant Erinnerungen selbst.** Wiederholungen, „Erledigt“ und „Verschieben“ leben dort; ntfy stellt nur
  sofort zu.
- **Kein Inhalt verlässt den Server in Richtung ntfy.sh.** Für iOS sendet der eigene ntfy nur Poll-Anfragen
  (Nachrichten-ID und SHA-256 der Topic-URL) an ntfy.sh.

## 3. Offizielle Quellen (gelesen am 2026-11-06)

Die Doku-Webseiten sind in der Cloud-Umgebung teils per Proxy gesperrt. Gelesen wurden deshalb die
**Doku-Quelltexte in den offiziellen GitHub-Repositories** (Sparse-Clone). Bei der Umsetzung erneut prüfen, weil die
Versionen weiterlaufen.

| Thema | Offizielle Quelle (Repo → Datei) | Kernaussagen für diesen Plan |
|---|---|---|
| ntfy Publish | `binwiederhier/ntfy` → `docs/publish.md` (docs.ntfy.sh/publish) | JSON-Publish an die **Root-URL** mit `topic, title, message, priority, tags, click, actions, sequence_id`; höchstens **3 Aktionen**; `http`-Aktion standardmäßig POST, mit `clear=true`; Auth per `Authorization: Bearer tk_…`; Nachricht max. 4096 Bytes, Titel max. 1 KB; Clear: `PUT /<topic>/<sequence_id>/clear` (nur Android/Web, **nicht iOS**) |
| ntfy Server | `docs/config.md` | Privat: `auth-default-access: deny-all`, Benutzer/ACL/Token per `ntfy user/access/token`; hinter Proxy **`behind-proxy: true`**; `base-url` setzen; iOS: **`upstream-base-url: "https://ntfy.sh"`**, sonst Verzögerung bis zu Stunden |
| ntfy Docker | `docs/install.md` | Image `binwiederhier/ntfy` (amd64, arm64 …), `serve`, Volumes `/var/cache/ntfy`, `/etc/ntfy`; Healthcheck `GET /v1/health`; `init: true` |
| ntfy Android | `docs/subscribe/phone.md` | Für eigene Server kein Firebase; „Instant delivery“ per Vordergrunddienst; F-Droid-Variante immer instant |
| axum | `tokio-rs/axum` → `examples/` (Version **0.8.9**) | Statische Dateien + SPA-Fallback (`static-file-server`), SSE (`sse`), Tests per `oneshot` (`testing`), `with_graceful_shutdown` |
| Tauri HTTP | `tauri-apps/tauri-docs` → `plugin/http-client.mdx`; `plugins-workspace/plugins/http` (**2.8.3**) | Rust-seitig: `tauri_plugin_http::reqwest` (Re-Export, reqwest 0.12, Standard-Feature `rustls-tls`) |
| TipTap | `ueberdosis/tiptap-docs` → `core-concepts/persistence.mdx`, `api/commands/content/set-content.mdx`, `guides/mobile-apps.mdx` | Inhalt als **JSON** speichern (auch in IndexedDB möglich); `setContent(…, { emitUpdate: false })` (v3: Standard `true`); auf anderen Plattformen **dieselben Extensions** verwenden (Schema-Parität) |
| PWA installierbar | `mdn/content` → `progressive_web_apps/guides/making_pwas_installable`, `…/installing`, `…/how_to/trigger_install_prompt`, `…/how_to/create_a_standalone_app` | Manifest per `<link rel="manifest">` auf jeder Seite; Chromium verlangt `name`/`short_name`, Icons **192 px und 512 px**, `start_url`, `display` (z. B. `standalone`), `prefer_related_applications` nicht `true`; **HTTPS** Pflicht; iOS/iPadOS: Installieren über „Zum Home-Bildschirm“ (ab 16.4 aus jedem unterstützenden Browser); `beforeinstallprompt` ist **nicht standardisiert, nur Chromium**; pro Browser installierte PWAs teilen keine Daten; `display-mode`-Media-Query erkennt die installierte App |
| PWA offline | `mdn/content` → `…/guides/offline_and_background_operation`, `…/guides/caching` | Service Worker + Cache API für die App-Hülle (Precaching im `install`-Event); Background Sync feuert `sync` im Service Worker, sobald wieder Netz da ist |
| Browser-Support | `mdn/browser-compat-data` → `api/SyncManager.json`, `LockManager.json`, `BroadcastChannel.json`, `StorageManager.json` | **Background Sync nur Chromium** (nicht Safari, nicht Firefox) → nicht darauf verlassen; Web Locks: Chrome 69 / Safari 15.4 / Firefox 96; BroadcastChannel: Safari 15.4; `storage.persist()`: Safari 15.2; `storage.estimate()`: Safari 17 (mobil jeweils gleich) |
| Speicher & Löschung | `mdn/content` → `api/storage_api/storage_quotas_and_eviction_criteria`, `api/storagemanager/persist`, `api/navigator/online` | Standard „best-effort“, mit `navigator.storage.persist()` dauerhaft (Safari/Chromium entscheiden ohne Rückfrage, Firefox fragt); **Safari löscht per Skript angelegte Daten nach 7 Tagen ohne Interaktion**; `navigator.onLine` ist **unzuverlässig**, nur als Hinweis verwenden |
| iOS Home-Bildschirm | WebKit (Bugzilla 211775/237350, WebKit-Blog zur Speicherrichtlinie, über Suche) | Web-Apps auf dem Home-Bildschirm haben einen eigenen Nutzungszähler bzw. sind von der 7-Tage-Löschung für HTML-Speicher ausgenommen → **unter iOS installieren**, nicht nur im Safari-Tab nutzen |
| vite-plugin-pwa | `vite-pwa/docs` → `guide/*`, `workbox/generate-sw.md`, `frameworks/react.md`, `deployment/index.md` | Workbox `generateSW` mit Precache; `registerType: 'prompt'` (Standard) + `virtual:pwa-register/react` (`useRegisterSW`, `needRefresh`, `updateServiceWorker`); `injectRegister: null`/`'script'` (kein Inline-Skript → passt zur strengen CSP); `navigateFallbackDenylist` für ausgenommene Pfade; Server: `manifest.webmanifest` als `application/manifest+json`, HTTP→HTTPS, **kein Caching/`immutable` auf `/`, `/index.html`, `/sw.js`, `/manifest.webmanifest`**; Minimum: viewport, title, description, favicon, `apple-touch-icon`, `theme-color` |
| IndexedDB | `jakearchibald/idb` → `README.md` (**8.0.4**); MDN `api/indexeddb_api/using_indexeddb` | Promise-API `openDB(name, version, { upgrade(db, oldVersion, …) })` für Schema-Versionen |
| Caddy | `caddyserver/website` → `quick-starts/reverse-proxy.md`, `automatic-https.md` | Domain im Caddyfile → automatisches HTTPS, HTTP→HTTPS-Weiterleitung; braucht A/AAAA-Record, offene Ports 80/443 und ein persistentes Datenverzeichnis |
| OWASP | `OWASP/CheatSheetSeries` → Password Storage, Session Management, CSRF Prevention | **Argon2id** min. 19 MiB, t=2, p=1; Cookie `__Host-…; Secure; HttpOnly; SameSite=Strict; Path=/`; CSRF: `Sec-Fetch-Site` mit Origin-Prüfung als Pflicht-Fallback, Custom Request Header für API; localStorage nicht für Sitzungs-IDs |
| sqlx | `launchbadge/sqlx` → `README.md` | SQLite-Treiber, `migrate!` bettet Migrationen ein; `foreign_keys=ON` Standard. Hauptzweig zeigt **0.9.0**, ob es veröffentlicht ist, beim Umsetzen prüfen |
| keyring | `open-source-cooperative/keyring-rs` → `README.md` (**4.2.0**) | Für Anwendungen: `keyring-core` plus das passende Store-Crate (Windows Credential Manager) |

Bei Problemen: zuerst die offizielle Doku und Changelogs, dann **GitHub Issues/Discussions** des jeweiligen
Projekts, dann **Stack Overflow**. Die Fundstelle wird im Commit oder in `DECISIONS.md` vermerkt.

## 4. Repository-Struktur (neu)

```
crates/buddy-core/            reine, geteilte Logik (kein Tauri, kein axum): Note/Reminder-Modelle, schedule.rs,
                              text.rs (aus src-tauri verschoben), Sync-Datensätze, LWW-Vergleich, Uhr-Korrektur
crates/buddy-core/tests/fixtures/
  lww_vectors.json            gemeinsame Testvektoren LWW (von cargo test UND Vitest gelesen)
  schedule_vectors.json       gemeinsame Testvektoren Wiederholung/Verschieben (Europe/Berlin, inkl. Sommerzeit)
server/                       buddy-server (Rust 2024): axum, tokio, sqlx-sqlite, argon2, chrono-tz, reqwest
  migrations/                 SQL-Migrationen (sqlx::migrate!)
  Dockerfile                  Multi-Stage: Web-App bauen → Server bauen → schlankes Laufzeit-Image (non-root)
deploy/                       compose.yaml, Caddyfile, ntfy/server.yml, .env.example, README.md (Deutsch)
src/lib/clock.ts              korrigierte Gerätezeit (PC-Frontend + Web-App)
src/lib/sync/                 TypeScript-LWW + Sync-Datensatz-Typen (Spiegel von buddy-core)
src/lib/schedule.ts           TypeScript-Port der Wiederholungs-/Verschiebe-Logik (für Offline-Aktionen am Handy)
src/web/data/                 IndexedDB-Schicht (idb): Notizen, Erinnerungen, Reihenfolge, Outbox, Meta
src/web/sync/                 Sync-Engine der Web-App (Auslöser, Push/Pull, Merge, Web Locks, BroadcastChannel)
src/web/ui/                   Oberfläche (Seiten, Komponenten, Install-Hinweise, Update-Banner)
src/web/main.tsx              Einstieg; web.html; vite.web.config.ts (vite-plugin-pwa) → dist-web/
public-web/                   Icons (192, 512, maskable, apple-touch-icon 180), favicon
src-tauri/src/sync/           Desktop-Sync-Client
```

- **Kein Cargo-Workspace im Repo-Root.** `src-tauri` und `server` binden `buddy-core` per
  `path = "../crates/buddy-core"` ein. Tauri-Build, `target/`-Pfad und MinGW-Cross-Build bleiben unverändert.
- `src-tauri/src/model.rs` exportiert die verschobenen Typen weiter (`pub use buddy_core::…`). Vertragstests und
  Importe funktionieren deshalb unverändert.

## 5. Datenmodell, Zeitstempel und Konfliktregel

### 5.1 Änderungen an bestehenden Typen

- `Reminder` bekommt **`updatedAt: string | null`** (RFC 3339 UTC mit Millisekunden, `null` bei Altdaten). Neu in
  `types.ts` und `model.rs`, mit `#[serde(default)]`.
- `Note.updatedAt` bleibt der **Zeitstempel der letzten Bearbeitung auf dem Gerät**. Er wird ab v3 mit der
  korrigierten Gerätezeit gesetzt (§5.3): am PC in `useNotesStore`, am Handy in der Web-App. Wird eine Notiz aus dem
  Sync übernommen, behält sie den `updatedAt`-Wert der Gegenseite.
- Neue Einstellungen (HANDOFF Lektion 8): `syncEnabled: boolean` (false), `syncServerUrl: string` (""),
  `syncDeviceName: string` (""). **Das Geräte-Token steht nie in `settings.json`.**

### 5.2 Sync-Datensätze (in `buddy-core` und `src/lib/sync/`, serde camelCase)

```jsonc
// NoteRecord
{ "id": "<uuid>", "updatedAt": "2026-11-06T10:00:00.000Z", "updatedBy": "<deviceId>",
  "deleted": false, "note": { /* Note aus types.ts */ } }           // deleted=true → note = null
// ReminderRecord
{ "noteId": "<uuid>", "updatedAt": "…", "updatedBy": "…", "deleted": false, "reminder": { /* Reminder */ } }
// OrderRecord (Reihenfolge der Notizen, ganze Liste)
{ "updatedAt": "…", "updatedBy": "…", "ids": ["<uuid>", "…"] }
```

### 5.3 Zeitstempel auf PC und Handy (Nachtrag, verbindlich)

1. **Gestempelt wird dort, wo bearbeitet wird, und zwar sofort.** Jede Benutzeränderung bekommt beim lokalen
   Speichern `updatedAt` = korrigierte Gerätezeit, auch offline. Das gilt für Notiz, Löschen, Reihenfolge,
   Erinnerung setzen/entfernen/erledigen/verschieben.
   - PC: Notizen, Reihenfolge und Löschen im Frontend; Erinnerungen in Rust (`schedule::set/ack/snooze/remove`).
   - Web-App: in `src/web/data`, bevor in IndexedDB geschrieben wird.
2. **Der Zeitstempel bleibt beim Synchronisieren unverändert.** Der Server übernimmt ihn, wie er ist. Ausnahme:
   Liegt er mehr als **2 Minuten nach der Serverzeit**, wird er auf die Serverzeit geklemmt (Schutz gegen falsch
   gehende Uhren). Ein alter Zeitstempel einer späten Offline-Änderung ist gültig und wird nicht verändert.
3. **Korrigierte Gerätezeit.** Jede Server-Antwort enthält `serverTime`. Der Client misst
   `offset = serverTime − (Sendezeit + Antwortzeit/2)` und nimmt die Messung nur bei Antwortzeit < 5 s an. Gespeichert
   wird der Median der letzten 5 Messungen: am PC in `sync/state.json`, in der Web-App in IndexedDB `meta`.
   Zeitstempel = Gerätezeit + offset. Offline gilt der zuletzt gespeicherte Wert, ohne jede Messung 0.
   - Gemeinsame Funktion `src/lib/clock.ts` (PC-Frontend + Web-App) und `buddy_core::clock` (Rust).
   - Das PC-Frontend bekommt den Offset über das Event `sync-status` (`clockOffsetMs`).
   - Rust-Erinnerungen holen ihn über `sync::corrected_now()`, mit Fallback auf die Systemzeit.
4. **Abweichung anzeigen.** Ist |offset| > 2 min, zeigen PC und Web-App „Die Uhr dieses Geräts geht um … falsch –
   bitte automatische Uhrzeit aktivieren“.
5. **Format** überall `YYYY-MM-DDTHH:MM:SS.sssZ` (UTC, Millisekunden). Verglichen wird als Zeitpunkt, nicht als
   Zeichenkette.

### 5.4 Last-Writer-Wins

- Pro Dokument (Notiz, Erinnerung, Reihenfolge) gewinnt der höhere `updatedAt`. Bei Gleichstand gewinnt der
  lexikografisch größere `updatedBy`. Die Regel gibt es einmal in Rust (`buddy-core`) und einmal in TypeScript
  (`src/lib/sync/lww.ts`). **Beide müssen `lww_vectors.json` bestehen.**
- **Löschen ist ein Datensatz** (Tombstone mit `deleted: true`, `updatedAt` = Löschzeit) und nimmt normal an LWW
  teil. Eine Bearbeitung nach dem Löschen bringt die Notiz zurück.
- **Sicherheitsnetz:** Jede Fassung, die verliert, legt der Server in `note_revisions` ab, egal ob sie überschrieben
  oder beim Hochladen abgelehnt wurde (30 Tage, max. 20 pro Notiz). Wiederherstellen ist in v3 per CLI möglich.
- **Hinweis an den Benutzer.** Verliert eine lokale Änderung (Antwort `stale`), übernimmt der Client die neuere
  Fassung. Dazu kommt ein nicht blockierender Hinweis: „Deine Änderung an „<Titel>“ war älter als die von
  <Gerät> und wurde ersetzt (auf dem Server 30 Tage wiederherstellbar).“
  - PC: Statusmeldung im Einstellungsfenster und einmalig ein Toast.
  - Web-App: Hinweisleiste.

### 5.5 Erinnerungen und LWW (gegen „Wiederauferstehen“)

- **Benutzeraktionen** (setzen, entfernen, erledigen, verschieben) setzen `updatedAt`, auf jedem Gerät, auch
  offline. In der Web-App rechnet `src/lib/schedule.ts` das nächste Vorkommen und „jetzt + Minuten“ wie
  `buddy-core`; beide bestehen `schedule_vectors.json`.
- **Fällig werden ist abgeleitet und setzt `updatedAt` nicht.** Es ändert nur `state` und `firedAt`, auf dem Server
  zählt zusätzlich `seq` hoch.
- Gleichstand bei `updatedAt`: der weiter fortgeschrittene Zustand gewinnt (`due` vor `scheduled`), erst danach
  `updatedBy`.
- **Push-Pflicht auf dem Server:** Für jedes Vorkommen `(noteId, at)` mit `state ∈ {scheduled, due}` und
  `at ≤ jetzt` sendet der Server **genau einmal** an ntfy (`push_log`). Vorkommen, die älter als 24 h sind, werden
  nicht mehr gesendet.
- **Desktop:** Feuert der lokale Scheduler, gibt es Toast und Ton wie bisher. Meldet der Sync ein `scheduled → due`, das
  lokal noch nicht gefeuert hat, und liegt `firedAt` höchstens 10 Minuten zurück, alarmiert der Desktop ebenfalls.
  Sonst zeigt er nur Badge und Animation.
- **Web-App:** Fällige Erinnerungen erscheinen beim Öffnen als Liste bzw. Banner (lokal berechnet, auch offline).
  Benachrichtigungen ohne Netz kann eine Web-App nicht zuverlässig planen, dafür gibt es keinen Web-Standard. Push
  kommt deshalb nur online über ntfy.
- Wiederholungen werden auf dem Server in der **IANA-Zeitzone des Kontos** berechnet (`chrono-tz`), auf dem PC in
  `Local`, in der Web-App in der Gerätezone. Der PC meldet seine Zone beim Verbinden (`PUT /me`).

## 6. API-Vertrag v1 (Server)

Basis `https://buddy.<domain>/api/v1`, JSON, Fehler als `{ "error": "<code>", "message": "<Deutsch>" }`.
Auth: PC mit `Authorization: Bearer <Geräte-Token>`, Web-App mit Session-Cookie. **Jede Antwort enthält
`serverTime`** (im Body bzw. als Header `X-Server-Time`) und `Cache-Control: no-store`.

| Methode & Pfad | Auth | Body → Antwort | Hinweise |
|---|---|---|---|
| `GET /health` | – | → `{ok:true}` | für den Docker-Healthcheck |
| `POST /devices` | Benutzer+Passwort im Body | `{username,password,deviceName}` → `{deviceId,token}` | PC-Anmeldung; Token: 32 Byte Zufall (base64url), gespeichert wird nur SHA-256 |
| `DELETE /devices/current` | Bearer | → 204 | PC abmelden (Token widerrufen) |
| `POST /session` | – | `{username,password,deviceName,deviceId?}` → `{deviceId}` + `Set-Cookie` | Web-Login. Jede installierte Web-App ist ein **Gerät** (Art `web`); eine schon bekannte `deviceId` wird wiederverwendet. Session-ID rotieren |
| `DELETE /session` | Cookie | → 204 | Abmelden |
| `GET /me` | beide | → `{username,timeZone,deviceId,ntfy:{url,topic},serverTime}` | auch für die Uhrzeit-Messung |
| `PUT /me` | beide | `{timeZone}` → `/me` | IANA-Name prüfen |
| `GET /sync/changes?since=<n>&limit=<≤500>` | beide | → `{cursor,hasMore,notes:[NoteRecord],reminders:[ReminderRecord],order:OrderRecord\|null,serverTime}` | nach `seq` sortiert; `410 full_resync_required`, wenn `since` < ältester aufbewahrter Stand |
| `POST /sync/push` | beide | `{notes:[…],reminders:[…],order?}` → `{results:[{kind,id,status:"applied"\|"stale",current?}],cursor,serverTime}` | **einziger Schreibweg** für PC und Web-App; LWW pro Datensatz mit den Zeitstempeln der Geräte; `stale` liefert die gewinnende Fassung; max. 500 Datensätze / 8 MiB; idempotent (gleicher Datensatz zweimal = `applied`, keine Doppelung) |
| `POST /actions/{token}` | **signiertes Einmal-Token** | → 204 | für die ntfy-Knöpfe (§7.4); `updatedBy = "server"`, `updatedAt` = Serverzeit |
| `GET /events` (optional, Phase G) | beide | SSE `changed {cursor}` | Live-Aktualisierung |

Es gibt bewusst **keine** separaten CRUD-Endpunkte mit Serverzeit (z. B. `PUT /notes/{id}`). Alle Schreibvorgänge
laufen über `/sync/push` mit Gerätezeitstempeln (§5.3).
Grenzen: Notiz-JSON ≤ 1 MiB, Titel ≤ 500 Zeichen, IDs = kanonische UUIDs (`is_valid_note_id`), Inhalt muss ein
TipTap-Dokument (`{"type":"doc",…}`) sein, ≤ 10 000 Notizen pro Konto.

## 7. Server (`server/`)

### 7.1 Technik

Rust 2024, **axum 0.8.x**, tokio, `tower-http` (`trace`, `fs`, `limit`, `set-header`), **sqlx** (SQLite,
`runtime-tokio`, `migrate`; `query`/`query_as` ohne Offline-Metadaten), `argon2` (Argon2id, mindestens
OWASP-Parameter), `chrono` + `chrono-tz`, `reqwest` (rustls) für ntfy, `tracing`, `buddy-core`.
Konfiguration nur über Umgebungsvariablen:
`BUDDY_LISTEN` (`0.0.0.0:8080`), `BUDDY_PUBLIC_URL`, `BUDDY_DB` (`/data/buddy.db`), `BUDDY_SECRET`
(32 Byte, base64, HMAC für Aktions-Tokens), `BUDDY_NTFY_URL` (intern `http://ntfy:80`), `BUDDY_NTFY_PUBLIC_URL`,
`BUDDY_NTFY_TOPIC`, `BUDDY_NTFY_TOKEN`, `BUDDY_WEB_DIR` (`/app/web`).
CLI: `buddy-server serve | user add <name> | user passwd <name> | device list | device revoke <id> |
revisions <noteId> | restore <noteId> <revisionId>` (Passwort über stdin, nie als Argument).

### 7.2 Datenbank (SQLite, WAL, `foreign_keys=ON`)

```sql
users(id INTEGER PK, username TEXT UNIQUE, password_hash TEXT, time_zone TEXT, seq INTEGER DEFAULT 0,
      min_cursor INTEGER DEFAULT 0, created_at TEXT)
devices(id TEXT PK, user_id → users, kind TEXT /*desktop|web*/, name TEXT, token_hash BLOB UNIQUE NULL,
        created_at, last_seen_at, revoked_at)
sessions(id_hash BLOB PK, user_id → users, device_id → devices, created_at, expires_at)
notes(user_id, id TEXT, payload TEXT /*Note-JSON*/, updated_at TEXT, updated_by TEXT, deleted INTEGER,
      seq INTEGER, received_at TEXT, PK(user_id,id));            INDEX(user_id, seq)
note_revisions(id INTEGER PK, user_id, note_id, payload TEXT, updated_at, updated_by, reason TEXT
               /*replaced|rejected*/, stored_at)
reminders(user_id, note_id, payload TEXT /*Reminder-JSON*/, updated_at, updated_by, deleted, seq, received_at,
          PK(user_id,note_id));                                  INDEX(user_id, seq)
note_order(user_id PK, ids TEXT /*JSON*/, updated_at, updated_by, seq)
push_log(user_id, note_id, at TEXT, sent_at, ntfy_id TEXT, attempts INTEGER, PK(user_id,note_id,at))
```

- Jede Schreiboperation läuft in **einer Transaktion**: `users.seq += 1`, die Zeile bekommt den neuen `seq`.
  `received_at` = Serverzeit, nur für die Diagnose, **nicht** für LWW.
- Tombstones werden nach 180 Tagen entfernt; dabei wird `min_cursor` erhöht. Ältere Cursor bekommen `410` und
  führen eine Voll-Synchronisation aus. Das betrifft auch ein Handy, das sehr lange offline war: Seine Outbox wird
  dabei nicht verworfen.
- Backup: Ein Hintergrund-Task schreibt nachts `VACUUM INTO '/data/backups/buddy-YYYYMMDD.db'` und behält 14 Stände.

### 7.3 Erinnerungs-Scheduler

Gleiches Muster wie `src-tauri/src/reminders.rs`: ein Task schläft bis zum frühesten `at` (höchstens 30 s) und wird
bei Änderungen per `tokio::sync::Notify` geweckt. Dann:
1. `scheduled` mit `at ≤ jetzt` → `due`, `firedAt` = jetzt, `seq += 1`. `updatedAt` bleibt.
2. Für jedes Vorkommen ohne `push_log`-Eintrag (nicht älter als 24 h) eine ntfy-Nachricht senden (§7.4).
   Bei Fehlern bis zu 3 Wiederholungen (5 s, 30 s, 2 min).
3. Verpasste Erinnerungen (Server war aus) feuern beim Start einmal.

Die Zeit wird als `Clock`-Trait injiziert, damit Tests ohne echtes Warten laufen.

### 7.4 ntfy-Nachricht

JSON-`POST` an `BUDDY_NTFY_URL/` mit `Authorization: Bearer <BUDDY_NTFY_TOKEN>`:

```json
{
  "topic": "<BUDDY_NTFY_TOPIC>",
  "title": "Erinnerung: <Titel oder „Notiz“>",
  "message": "<erste 100 Zeichen des Notiztexts>",
  "priority": 4,
  "tags": ["bell"],
  "click": "<BUDDY_PUBLIC_URL>/notes/<noteId>",
  "sequence_id": "r-<noteId>",
  "actions": [
    { "action": "http", "label": "Erledigt",       "url": "<PUBLIC_URL>/api/v1/actions/<t1>", "method": "POST", "clear": true },
    { "action": "http", "label": "10 Min. später", "url": "<PUBLIC_URL>/api/v1/actions/<t2>", "method": "POST", "clear": true },
    { "action": "view", "label": "Öffnen",         "url": "<PUBLIC_URL>/notes/<noteId>" }
  ]
}
```

- `click` und „Öffnen“ führen zur Web-App. Ist sie installiert, öffnet sich je nach Betriebssystem die App,
  sonst der Browser.
- **Aktions-Tokens** sind HMAC-SHA256 über `{userId, noteId, at, action, exp}` mit `BUDDY_SECRET`, gültig 24 h.
  Sie wirken nur, solange das Vorkommen `(noteId, at)` noch aktuell ist, sonst 204 ohne Änderung.
- Wird die Erinnerung anderswo erledigt, schickt der Server `PUT /<topic>/r-<noteId>/clear`. Das wirkt unter
  Android und im Browser, unter iOS laut Doku nicht.

### 7.5 Sicherheit und Auslieferung der Web-App

- Passwörter mit **Argon2id** (mindestens m = 19 MiB, t = 2, p = 1), Vergleich in konstanter Zeit, Mindestlänge 12.
- Login-Bremse pro IP und Benutzername: ab 5 Fehlversuchen exponentielle Wartezeit, maximal 15 min. Der Client-IP
  aus `X-Forwarded-For` wird nur geglaubt, wenn die Anfrage aus dem Docker-Netz von Caddy kommt.
- Session-Cookie `__Host-buddy_session; Secure; HttpOnly; SameSite=Strict; Path=/`. Serverseitige Sessions
  (nur Hash gespeichert), 30 Tage gleitend; jeder Sync verlängert sie. Neue ID beim Login. Die Session-ID liegt
  **nie** in IndexedDB oder localStorage (OWASP).
- CSRF bei Cookie-Auth und unsicheren Methoden: `Sec-Fetch-Site: cross-site` ablehnen. Fehlt der Header, muss
  `Origin` gleich `BUDDY_PUBLIC_URL` sein. Zusätzlich ist der Header `X-Buddy-Request: 1` Pflicht. Bearer-Anfragen
  sind davon ausgenommen.
- **Cache-Header (vite-plugin-pwa-Doku):**
  - `/`, `/index.html`, `/sw.js`, `/manifest.webmanifest` und alle SPA-Pfade: `Cache-Control: no-cache`.
  - Gehashte Assets unter `/assets/`: `public, max-age=31536000, immutable`.
  - API: `no-store`.
  - `manifest.webmanifest` mit `Content-Type: application/manifest+json`.
- CSP für die Web-App: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:;
  connect-src 'self'; worker-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'none';
  form-action 'self'`. Kein Inline-Skript; den Service Worker registriert der gebündelte Code.
  Außerdem `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`. HSTS setzt Caddy.
- Logs enthalten nie Notizinhalt, Passwörter oder Tokens.

## 8. Desktop (`src-tauri/src/sync/` + Einstellungsfenster + Notizfenster)

### 8.1 Modul

- `sync/mod.rs`: `init` wie bei `reminders` (`app.manage(SyncState)` und eigener Thread). Kein `.state()` außerhalb
  von `state.rs`, nur `try_state` (HANDOFF §5.1).
- `sync/client.rs`: HTTP über **`tauri_plugin_http::reqwest`**, nur Rust-seitig (offizieller Tauri-Weg; Muster D-07).
  Timeout 15 s. Server-URL nur `https://`, Ausnahme `http://localhost` bzw. `127.0.0.1`.
  **Muss mit `x86_64-pc-windows-gnu` cross-kompilieren.** Misst bei jeder Antwort den Uhr-Offset (§5.3).
- `sync/outbox.rs`: `sync/outbox.json` mit geänderten Notiz-IDs, Tombstones (`id`, `deletedAt`), Erinnerungen und
  einem Reihenfolge-Flag. Geschrieben wird mit `write_json_atomic`.
- `sync/state.json`: `deviceId`, `cursor`, `lastSyncAt`, `lastError`, `clockOffsets` (letzte 5).
- `sync/merge.rs`: reine, getestete Funktionen (LWW aus `buddy-core`). Übernahmen aus dem Sync landen nicht in der
  Outbox.
- `sync/secret.rs`: Geräte-Token im Windows-Anmeldeinformationsspeicher (`keyring-core` + Windows-Store-Crate)
  hinter einem Trait.
- `sync::corrected_now()`: korrigierte Zeit für `reminders` (§5.3).

### 8.2 Ablauf

- **Auslöser:** Änderungen markieren die Outbox und wecken den Sync, entprellt um 2 s. Zusätzlich alle 60 s,
  beim Öffnen des Notizfensters, beim Start und über „Jetzt synchronisieren“.
- **Ein Durchlauf:** Push (in Paketen zu ≤ 200 Datensätzen), danach Pull (`since=cursor`, solange `hasMore`) und
  Merge. Eigene Echos werden übersprungen.
- **Start mit aktivem Sync:** Erst einen Pull versuchen (Timeout 5 s), **dann** feuert der lokale Scheduler
  verpasste Erinnerungen.
- **Erstes Verbinden:** Vereinigung über die ID, gleiche IDs per LWW, danach eine Zusammenfassung im Status.
- **Ohne Netz:** volle Funktion; die Outbox überlebt Neustarts, der Status zeigt „Offline – n Änderungen warten“.
- **401:** „Abgemeldet – bitte neu verbinden“; Outbox und lokale Daten bleiben.
- **Lock-Reihenfolge** dokumentieren; Netzwerkaufrufe laufen nie unter einem Lock.

### 8.3 Vertrag (die 4-Stellen-Regel aus HANDOFF §5.7 gilt)

| Command | Args | Rückgabe | Fenster |
|---|---|---|---|
| `sync_status` | – | `SyncStatus` | settings, notes |
| `sync_connect` | `serverUrl, username, password, deviceName` | `SyncStatus` | settings |
| `sync_disconnect` | – | `SyncStatus` | settings |
| `sync_now` | – | `SyncStatus` | settings |

`SyncStatus = { enabled, serverUrl, deviceName, state: "off"|"idle"|"syncing"|"offline"|"error"|"unauthorized",
lastSyncAt: string|null, pending: number, message: string|null, clockOffsetMs: number|null }`

Das Notizfenster braucht `sync_status`, um beim Start den Uhr-Offset für `src/lib/clock.ts` zu holen.

Events:
- `sync-status` (SyncStatus)
- `notes-changed` (`{ notes: Note[], deletedIds: string[], order: string[] | null }`)
- `reminders-changed` (besteht schon)

### 8.4 Notizfenster (`useNotesStore.ts`)

- **Zeitstempel:** `updatedAt` = `clock.correctedNow()` statt `new Date()`. Der Offset kommt aus `sync_status` bzw.
  `sync-status`; ohne Sync ist er 0, das Verhalten bleibt dann wie 0.2.0.
- Bei `notes-changed` die Notizen ersetzen, einfügen bzw. entfernen und die Reihenfolge übernehmen.
- **Aktive Notiz mit ausstehendem Autosave:** entfernte Fassung ignorieren, die lokale ist neuer.
- **Aktive Notiz ohne ausstehende Änderung:** Editor per `setContent(json, { emitUpdate: false })` aktualisieren
  (TipTap-Doku), Cursor möglichst erhalten.
- Wird die aktive Notiz entfernt gelöscht, Nachbarnotiz wählen und „Notiz wurde auf einem anderen Gerät gelöscht“
  anzeigen.
- Regressionstests in `useNotesStore.races.test.ts`.

### 8.5 Einstellungsfenster

Neuer Abschnitt **„Synchronisation“** zwischen „Erinnerungen“ und „System“:
- Felder: Server-Adresse, Benutzername, Passwort, Gerätename.
- Knöpfe: „Verbinden“ bzw. „Trennen“, „Jetzt synchronisieren“.
- Statuszeile, z. B. „Zuletzt synchronisiert um …“, „Offline – 3 Änderungen warten“, „Uhr geht … falsch“.
- Hinweis „Handy: <Server-Adresse> öffnen und App installieren“.
- Alles mit `aria-label`, per Tastatur bedienbar und mit deutschen Texten.

## 9. Installierbare Offline-Web-App für Handy und Tablet

### 9.1 Installierbarkeit (PWA)

- **Build:** eigener Vite-Einstieg (`web.html`, `vite.web.config.ts`, Ausgabe `dist-web/`) mit **vite-plugin-pwa**
  (Workbox `generateSW`).
  - `registerType: 'prompt'` und `injectRegister: null`. Registriert wird über `virtual:pwa-register/react`
    (`useRegisterSW`), es gibt also kein Inline-Skript und die CSP bleibt streng.
  - `workbox.navigateFallback: '/index.html'`, `navigateFallbackDenylist: [/^\/api\//]`, `cleanupOutdatedCaches`.
- **Manifest** (`manifest.webmanifest`):
  - Name und Darstellung: `name` „Display Buddy – Notizen“, `short_name` „Buddy“, `description`, `lang` „de“,
    `display` `standalone`.
  - Pfade: `start_url` `/`, `scope` `/`.
  - Farben: `theme_color`, `background_color`.
  - Icons: 192 px und 512 px als PNG, zusätzlich als `purpose: "maskable"`.
  - Kein `prefer_related_applications`.
  - In `web.html`: viewport, title, description, favicon, `apple-touch-icon` (180 px), `theme-color`.
- **Installieren in der Oberfläche:**
  - Chromium (Android Chrome, Samsung Internet, Edge): `beforeinstallprompt` abfangen (MDN-Anleitung) und einen
    eigenen Knopf „App installieren“ zeigen.
  - iOS/iPadOS und Firefox: Es gibt kein Install-Event. Stattdessen eine Hinweiskarte mit Anleitung (Safari:
    Teilen → „Zum Home-Bildschirm“).
  - Unter iOS weist die Karte ausdrücklich darauf hin, dass Offline-Daten nur in der installierten App dauerhaft
    bleiben (§9.3).
  - Ob die App installiert ist, erkennt sie über `matchMedia('(display-mode: standalone)')`; dann verschwinden die
    Hinweise.
- **Updates:** Bei `needRefresh` erscheint „Neue Version verfügbar – Aktualisieren“. `updateServiceWorker(true)`
  läuft erst, nachdem alle offenen Änderungen in IndexedDB stehen.
- Der Service Worker cached **nur die App-Hülle** (gebaute Dateien, Icons). API-Antworten cached er nie; die Daten
  liegen in IndexedDB.

### 9.2 Lokale Daten (`src/web/data/`, IndexedDB über `idb`)

- Datenbank `display-buddy`, Version 1, Schema-Upgrades über `openDB(…, { upgrade })`. Stores:
  - `notes` (Schlüssel `id`: `NoteRecord`)
  - `reminders` (Schlüssel `noteId`: `ReminderRecord`)
  - `meta`: `deviceId`, Konto (Benutzername, Zeitzone, ntfy-Infos), `cursor`, `order` (OrderRecord), `clockOffsets`,
    `lastSyncAt`
  - `outbox`: Schlüssel `kind:id`, nur die **letzte** lokale Fassung je Dokument, also zusammengefasst
- **Jede Bearbeitung:**
  1. sofort lokal speichern (Autosave entprellt 500 ms wie am PC),
  2. dabei `updatedAt` = korrigierte Gerätezeit,
  3. Outbox-Eintrag in **derselben Transaktion**.
  Die Oberfläche liest immer aus IndexedDB, nie direkt vom Server.
- Schnittstelle der Datenschicht, damit Oberfläche und Datenschicht parallel gebaut werden können:
  `listNotes()`, `getNote(id)`, `saveNote(note)`, `deleteNote(id)`, `saveOrder(ids)`, `setReminder(noteId, at, repeat)`,
  `removeReminder(noteId)`, `ackReminder(noteId)`, `snoozeReminder(noteId, minutes)`, `pendingCount()`,
  `subscribe(listener)` (Änderungen aus Sync oder anderen Tabs), `signOut({ discardPending })`.
- `navigator.storage.persist()` nach dem Login anfragen (MDN) und das Ergebnis im Status zeigen.
- **Abmelden** löscht die lokale Datenbank. Warten noch Änderungen, kommt vorher eine Rückfrage:
  „3 Änderungen sind noch nicht synchronisiert – trotzdem abmelden?“.

### 9.3 Sync-Engine (`src/web/sync/`)

- **Gleiches Protokoll wie am PC** (§6): Push der Outbox in Paketen ≤ 200 → Ergebnisse anwenden (bei `stale` die
  Serverfassung übernehmen und den Hinweis aus §5.4 zeigen) → Pull ab `cursor` → LWW-Merge mit
  `src/lib/sync/lww.ts`.
- **Auslöser:** App-Start, Event `online`, `visibilitychange` → sichtbar, alle 60 s solange sichtbar, 2 s nach einer
  lokalen Änderung, Knopf „Jetzt synchronisieren“.
  `navigator.onLine` dient nur als Hinweis (MDN: unzuverlässig). Es wird trotzdem versucht, ein Netzwerkfehler
  gilt als „offline“, mit Backoff 5 s → 30 s → 2 min → 5 min.
- **Background Sync** (`SyncManager`) gibt es nur in Chromium. Die Engine nutzt ihn optional als Zusatz, verlässt sich
  aber nicht darauf. Unter iOS wird synchronisiert, sobald die App offen bzw. im Vordergrund ist.
- **Mehrere Tabs/Fenster:**
  - `navigator.locks.request('buddy-sync', …)` sorgt dafür, dass nur ein Sync gleichzeitig läuft (Safari ≥ 15.4).
  - Änderungen werden über `BroadcastChannel('buddy-data')` an andere Tabs gemeldet.
  - Pro Browser installierte Apps sind getrennte Geräte (MDN).
- **401 / abgelaufene Session:** Login-Seite mit dem Hinweis „n Änderungen werden nach dem Anmelden übertragen“.
  Die Outbox bleibt erhalten.
- **410 full_resync_required:** Alles neu laden, dann per LWW mischen. Die Outbox bleibt und wird danach erneut
  gesendet.
- **Uhr-Offset** bei jeder Antwort messen (§5.3), Warnung bei > 2 min.
- **iOS-Speicher:** Im Safari-Tab kann iOS Skriptdaten nach 7 Tagen ohne Nutzung löschen; Web-Apps auf dem
  Home-Bildschirm sind davon ausgenommen (WebKit). Deshalb zeigt die App unter iOS den Installationshinweis.
  Gefährdet sind nur **nicht synchronisierte** Änderungen, alles andere liegt auf dem Server.

### 9.4 Oberfläche (`src/web/ui/`)

- **TipTap-Schema-Parität:** dieselben Extensions aus `src/components/editor/extensions.ts`. `NoteEditor` und
  `Toolbar` wiederverwenden, sofern sie nichts aus `src/lib/api.ts` importieren (Stand: tun sie nicht).
- **Seiten**, Routing über Pfade ohne Zusatzbibliothek; offline liefert der Service Worker `index.html`:
  - `/login`
  - `/` Notizliste mit Suche (`src/lib/search.ts`), Farbe, Titel, Glocke, fälligen Erinnerungen
  - `/notes/<id>` Bearbeiten: Titel, Editor, Farbe, Erinnerung setzen/entfernen/erledigen/verschieben, Löschen
    mit Bestätigung
  - `/new`
  - `/setup` mit App-Installation und ntfy-Anleitung (Android/iOS: Server-URL, Topic, Login)
  - `/settings` mit Sync-Status, „Jetzt synchronisieren“, Speicherstatus, Abmelden
- **Statusleiste:** „Synchronisiert vor 2 Min.“, „Offline – 3 Änderungen warten“, „Wird synchronisiert …“,
  Konflikt-Hinweise.
- **Mobilgerecht:** Ziele ≥ 44 px, umbrechende Toolbar, Safe-Area-Abstände im Standalone-Modus,
  `prefers-reduced-motion`, deutsche Texte, `aria-label` an allen Bedienelementen.

## 10. Deployment (VPS)

`deploy/compose.yaml`:
- `caddy`: offizielles Image `caddy:2`, Ports 80, 443 und 443/udp, Volumes `caddy_data`, `caddy_config`.
- `buddy`: Build aus `server/Dockerfile`, Volume `buddy_data:/data`, Healthcheck `/api/v1/health`, non-root.
- `ntfy`: `binwiederhier/ntfy` mit `serve`, Volumes für Cache, Konfiguration und Auth-DB, Healthcheck laut Doku,
  `init: true`.
- Ein internes Netz verbindet die Dienste; nur Caddy veröffentlicht Ports. Image-Tags beim Umsetzen festpinnen.

`deploy/Caddyfile` (die Cache-Header setzt buddy-server, Caddy reicht sie durch):
```
{$BUDDY_DOMAIN} {
	reverse_proxy buddy:8080
	header Strict-Transport-Security "max-age=31536000"
}
{$NTFY_DOMAIN} {
	reverse_proxy ntfy:80
}
```

`deploy/ntfy/server.yml` (laut ntfy-Doku):
```yaml
base-url: "https://ntfy.<domain>"
listen-http: ":80"
behind-proxy: true
cache-file: "/var/cache/ntfy/cache.db"
auth-file: "/var/lib/ntfy/user.db"
auth-default-access: "deny-all"
upstream-base-url: "https://ntfy.sh"
```

`deploy/README.md` (Deutsch, Schritt für Schritt):
1. VPS bestellen (1 vCPU / 1 GB RAM reicht für einen Benutzer), Docker installieren, Firewall nur 22/80/443.
2. DNS: A/AAAA-Records für `buddy.<domain>` und `ntfy.<domain>` anlegen.
3. `.env` aus `.env.example` füllen.
4. `docker compose up -d --build`.
5. ntfy-Benutzer, ACL und Token anlegen; `buddy-server user add <name>`.
6. Handy einrichten:
   - Web-App öffnen, anmelden, **installieren** (Android: „App installieren“; iOS: Safari → Teilen →
     „Zum Home-Bildschirm“).
   - ntfy-App installieren und das Topic abonnieren.
7. PC verbinden.
8. Backups, Updates und Fehlersuche.

## 11. Phasen und Arbeitspakete

Arbeitsweise wie gewünscht (HANDOFF §2): Phasen, Subagenten mit je eigenem git-Worktree und **klar abgegrenzten
Ordnern**. Ein Orchestrator integriert. Kleine thematische Commits auf englisch.

| Phase | Inhalt | Ordner (exklusiv) | Abhängig von |
|---|---|---|---|
| **0 Fundament** (Orchestrator, seriell) | Versionen prüfen; `crates/buddy-core` anlegen und `schedule.rs`, `text.rs`, Note/Reminder-Typen verschieben (reiner Refactor, alle Tests grün, Windows-Cross-Build grün); `Reminder.updatedAt`; Sync-Datensätze, LWW, `clock` in Rust; **Testvektoren** `lww_vectors.json` und `schedule_vectors.json`; **TypeScript-Spiegel** `src/lib/sync/` (Typen + LWW), `src/lib/clock.ts`, `src/lib/schedule.ts`, beide Sprachen bestehen dieselben Vektoren; Vertragstypen in `types.ts`/`model.rs`; D-Einträge final | `crates/`, `src/lib/sync/`, `src/lib/clock.ts`, `src/lib/schedule.ts`, `src/types.ts`, `src-tauri/src/model.rs`, `src-tauri/src/reminders*`, `docs/` | – |
| **A Server-Kern** | Konfiguration, Migrationen, CLI, Auth (Passwort, Geräte-Token, Web-Geräte mit Sessions, CSRF, Login-Bremse), `/me`, `/sync/*` mit Gerätezeitstempeln + Klemme + Revisionen (`replaced`/`rejected`), Tombstone-Bereinigung, Backups, Auslieferung der Web-App mit Cache-Headern/CSP/Manifest-MIME; Tests per `oneshot` | `server/` (ohne `server/Dockerfile`, `server/src/reminders/`, `server/src/ntfy/`) | 0 |
| **B Desktop-Sync** | `src-tauri/src/sync/` inkl. Uhr-Offset und `corrected_now`, `commands/sync.rs`, 4-Stellen-Regel, Einstellungs-Abschnitt, `useNotesStore` (korrigierte Zeitstempel, `notes-changed`); Tests gegen HTTP-Mock | `src-tauri/src/sync/`, `src-tauri/src/commands/sync.rs`, `src/windows/settings/`, `src/windows/notes/useNotesStore*`, `src/lib/api*` | 0 |
| **C1 Web-Datenschicht + Sync-Engine** | `src/web/data/` (IndexedDB/idb, Outbox, Schnittstelle §9.2), `src/web/sync/` (§9.3: Auslöser, Backoff, Web Locks, BroadcastChannel, 401/410, Offset); Tests mit `fake-indexeddb` und gemocktem `fetch` | `src/web/data/`, `src/web/sync/` | 0 |
| **C2 Web-Oberfläche + PWA** | `src/web/ui/`, `src/web/main.tsx`, `web.html`, `vite.web.config.ts` (vite-plugin-pwa), Manifest, Icons, Install-Hinweise, Update-Banner, npm-Skripte; arbeitet gegen die Schnittstelle §9.2 (bis C1 fertig ist, mit einem In-Memory-Fake) | `src/web/ui/`, `src/web/main.tsx`, `web.html`, `vite.web.config.ts`, `public-web/`, `package.json` (nur Skripte/devDeps) | 0 |
| **D Erinnerungen + ntfy** | Server-Scheduler, `push_log`, ntfy-Client hinter Trait, Aktions-Tokens + `/actions`, Clear beim Erledigen | `server/src/reminders/`, `server/src/ntfy/` | A |
| **E Deployment** | `server/Dockerfile`, `deploy/*`, deutsche Anleitung inkl. App-Installation | `deploy/`, `server/Dockerfile` | A |
| **F Integration** (Orchestrator) | End-to-End lokal: Server + Fake-ntfy + Desktop (Linux-Smoke unter Xvfb) + Web-App (Playwright mit Chromium und WebKit, falls vorhanden; Offline über `context.setOffline`); Abnahmeszenarien §12; `MANUAL_TESTS.md` v3; README; HANDOFF; Version 0.3.0; Windows-Installer | alle | A–E |
| **G optional** | SSE-Live-Updates; GitHub Actions (Windows-Installer mit MSVC, Server-Image nach GHCR); **Web Push direkt in der installierten Web-App** als mögliche Alternative zur ntfy-App (Benutzer fragen) | – | F |

Parallel laufen können **A, B, C1 und C2** (nach 0) sowie **D und E** (nach A).

## 12. Tests und Abnahme

**Pflicht-Checks (alle grün):** `npm test` (inkl. `src/web` und der gemeinsamen Vektoren), `npm run build`,
`npm run build:web`, `cd src-tauri && cargo test`, `cargo clippy --all-targets -- -D warnings` (Linux **und**
`--target x86_64-pc-windows-gnu`), `cargo fmt --check`, `cd server && cargo test && cargo clippy --all-targets --
-D warnings`, `cd crates/buddy-core && cargo test`, NSIS-Cross-Build.

**Abnahmeszenarien (Phase F, lokal mit Fake-ntfy):**
1. Notiz am PC anlegen → nach „Jetzt synchronisieren“ in der Web-App sichtbar.
2. Notiz in der Web-App ändern → PC-Notizfenster zeigt den neuen Inhalt; ungespeichertes Tippen am PC bleibt.
3. Offline auf zwei Geräten ändern → überall gewinnt die neueste Fassung, die andere steht in `note_revisions`.
4. Am PC löschen → verschwindet in der Web-App; eine spätere Bearbeitung bringt die Notiz zurück (LWW).
5. Erinnerung am PC setzen, PC beenden → genau eine ntfy-Nachricht zur Zeit (Titel, Klick-URL, 3 Aktionen).
6. Aktions-URL „Erledigt“ → `done` bzw. nächstes Vorkommen; nach dem PC-Start kein Badge, kein Nachfeuern.
7. „10 Min. später“ → neues `at`, nach 10 min (simulierte Uhr) erneut genau eine Nachricht.
8. Erinnerung in der Web-App setzen → PC (an) zeigt den Toast, und das Handy bekommt den Push.
9. Falsches Passwort / widerrufenes Gerät → „Abgemeldet – bitte neu verbinden“, keine Datenverluste.
10. Server nicht erreichbar → PC voll benutzbar, die Outbox überlebt den Neustart, danach wird nachsynchronisiert.
11. Sync aus → Verhalten exakt wie 0.2.0.
12. Sicherheit: Cross-Site-POST mit Cookie wird abgelehnt; abgelaufenes Aktions-Token ändert nichts; keine
    Inhalte/Tokens im Log; Cookie-Attribute stimmen; Login-Bremse greift.
13. **Installierbar:** Manifest gültig (alle Pflichtfelder laut MDN), Service Worker aktiv, `beforeinstallprompt`
    in Chromium ausgelöst bzw. der Knopf erscheint; Cache-Header von `/sw.js`, `/index.html` und
    `/manifest.webmanifest` stimmen.
14. **Offline-Start:** Web-App einmal online laden, dann offline (`setOffline(true)`) neu laden → App startet,
    Notizen sind da.
15. **Offline bearbeiten:** offline anlegen, ändern, löschen, Erinnerung setzen/erledigen → App schließen und offline
    neu öffnen → alles da, Status „n Änderungen warten“ → online → automatisch synchronisiert, PC zeigt die
    Änderungen.
16. **Zeitstempel entscheiden (Kernfall Nachtrag):**
    a) Handy offline um T1 ändern, PC um T2 > T1 ändern, Handy erst danach online → die PC-Fassung gewinnt überall;
       das Handy zeigt den Hinweis; die Handy-Fassung steht in `note_revisions` (`rejected`).
    b) PC um T1 ändern und sofort synchronisieren, Handy offline um T2 > T1 ändern und erst Stunden später online →
       die **Handy-Fassung gewinnt**, obwohl sie später ankommt.
    c) Uhr des Handys 10 min vor (simuliert) → korrigierte Gerätezeit hält die Reihenfolge richtig; Warnung
       erscheint; ohne Messung greift die Klemme auf dem Server.
17. **Session abgelaufen, während offline** → nach dem Login wird die Outbox gesendet.
18. **Update der Web-App:** neue Version bereitstellen → Banner → Aktualisieren ohne Datenverlust.
19. **Zwei Tabs:** gleichzeitig offen → nie zwei Syncs parallel (Web Locks), beide zeigen die Änderungen.
20. **Gleiche Entscheidungen in Rust und TypeScript:** beide bestehen `lww_vectors.json` und
    `schedule_vectors.json`.

**Handtests, die nur der Benutzer machen kann** (in `MANUAL_TESTS.md` v3):
- echter VPS mit Domain und Zertifikat,
- Web-App installieren unter **Android (Chrome)** und **iOS (Safari → Home-Bildschirm)**,
- im Flugmodus bearbeiten und die App neu starten, danach wieder online,
- Daten nach mehr als 7 Tagen in der installierten iOS-App noch da,
- ntfy-App unter Android (Instant delivery) und iOS mit den Knöpfen,
- Windows-Anmeldeinformationsspeicher, Sync zwischen zwei Windows-PCs.

## 13. Risiken und noch zu prüfende Punkte

- **Uhren:** Gerätezeitstempel entscheiden. Dagegen helfen die korrigierte Gerätezeit, die Klemme auf dem Server und
  die Warnung. Ein Gerät, das noch nie online war und eine falsche Uhr hat, kann bis zu 2 min „zu neu“ stempeln.
- **iOS-Speicher:** Nur die installierte App behält Offline-Daten zuverlässig; im Safari-Tab droht die
  7-Tage-Löschung. Die App zeigt deshalb den Installationshinweis. Privates Surfen kann IndexedDB einschränken.
- **Kein Sync im Hintergrund auf iOS:** Synchronisiert wird nur bei offener App (Background Sync nur Chromium).
  Erinnerungen ohne Netz kommen am Handy nicht als Push.
- **iOS-Push:** Schnelle Zustellung nur über den Upstream ntfy.sh. „Clear“ wirkt unter iOS nicht.
- **Android ohne „Instant delivery“:** Nachrichten können sich verzögern (ntfy-Doku).
- **Zu verifizieren beim Umsetzen:**
  - ob sqlx 0.9 veröffentlicht ist,
  - die Crate-Namen des keyring-Windows-Stores,
  - ob das TLS-Backend von reqwest unter MinGW baut,
  - das ntfy-Image-Tag,
  - die aktuellen Versionen von vite-plugin-pwa (Vite-8-Kompatibilität) und idb,
  - ob Playwright-WebKit in der Umgebung verfügbar ist.
- **Docker** fehlt in der Cloud-Umgebung womöglich, dann sind Compose und Caddy nur statisch geprüft. Ehrlich
  berichten.

## 14. Nicht-Ziele in v3

- Ende-zu-Ende-Verschlüsselung
- Echtzeit-Zusammenarbeit/CRDT
- native Handy-App aus dem App-Store
- lokale Benachrichtigungen am Handy ohne Netz (kein Web-Standard)
- mehrere Benutzerkonten mit Teilen
- Sync von Einstellungen, Shortcuts und Skins (bleiben gerätespezifisch)
- Anhänge
