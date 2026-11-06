# v3 – Notiz-Synchronisation und Push-Erinnerungen aufs Handy (Plan)

Stand: 2026-11-06 · Grundlage: Version 0.2.0 · Status: **geplant, noch nicht umgesetzt**

Dieser Plan ist für v3 so verbindlich wie `docs/PLAN.md` für v1/v2. Abweichungen nur mit Begründung in
`docs/DECISIONS.md`. Ausführende Agenten starten mit `docs/AGENT_PROMPT_V3.md`.

---

## 1. Ziel und Entscheidungen des Benutzers

Ziel: Erinnerungen, die an Notizen hängen, kommen als Push-Nachricht auf Android- und iOS-Handys, **auch wenn
der PC aus ist**. Dazu werden Notizen über einen eigenen Server synchronisiert und sind am Handy **lesbar und
bearbeitbar**.

| Frage | Entscheidung (2026-11-06) |
|---|---|
| Architektur | Variante B: eigener Relay-/Sync-Server plant Erinnerungen und sendet Push, plus Notiz-Sync |
| Hosting | **VPS mit eigener Domain** (Docker Compose, HTTPS) |
| Handy | **Lesen und Bearbeiten** von Notizen und Erinnerungen im Browser (Web-App), Push über die ntfy-App |
| Verschlüsselung | **Keine Ende-zu-Ende-Verschlüsselung**; Schutz durch TLS, Login und Server-Härtung |
| Konflikte | **Neueste Änderung gewinnt** (Last-Writer-Wins pro Dokument) |

Annahmen (bei Bedarf beim Benutzer bestätigen): ein Benutzerkonto, mehrere Geräte (1–3 PCs, 1–2 Handys);
Zeitzone des Kontos = Zeitzone des Haupt-PCs; die Desktop-App bleibt **local-first** und funktioniert ohne
Server genau wie 0.2.0.

## 2. Architektur

```
 Windows-PC (Display Buddy)                 VPS (Docker Compose)                         Handy
┌───────────────────────────┐  HTTPS  ┌──────────── Caddy :443 (Auto-HTTPS) ───────────┐
│ storage/ (lokal, wie v2)  │◄──────► │ buddy.<domain> → buddy-server :8080             │◄── Browser: Web-App
│ reminders/ (Toast lokal)  │         │ ntfy.<domain>  → ntfy :80                       │    (lesen + bearbeiten)
│ sync/ (neu): Outbox,      │         └────────────────────────────────────────────────┘◄── ntfy-App (Push,
│   Push/Pull, LWW-Merge    │           buddy-server: axum + SQLite, eigener Erinnerungs-     Knöpfe „Erledigt“,
└───────────────────────────┘           Scheduler, sendet intern an http://ntfy:80           „10 Min. später“)
                                        ntfy: deny-all, upstream-base-url=https://ntfy.sh (iOS)
```

Grundsätze:
- **Server = Quelle für den Push.** Nur der Server sendet an ntfy; die Desktop-App spricht nie mit ntfy, damit keine
  doppelten Nachrichten entstehen.
- **Der Server plant Erinnerungen selbst.** Wiederholungen, „Erledigt“ und „Verschieben“ leben dort. ntfys eigene
  zeitversetzte Zustellung wird nicht benutzt, ntfy stellt nur sofort zu. ntfy könnte geplante Nachrichten zwar per
  Sequenz-ID ändern oder abbrechen (Doku „Updating/Canceling scheduled notifications“), hätte aber trotzdem nicht den
  Erinnerungsstatus.
- **Der Desktop bleibt eigenständig.** Der lokale Scheduler zeigt weiter Toast, Badge und Ton, auch offline.
  Sync ist optional und standardmäßig aus.
- **Kein Inhalt verlässt den Server in Richtung ntfy.sh.** Der eigene ntfy sendet für iOS nur eine Poll-Anfrage
  (Nachrichten-ID und SHA-256 der Topic-URL) an ntfy.sh. Das iOS-Gerät holt den Inhalt dann vom eigenen Server.

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
| TipTap | `ueberdosis/tiptap-docs` → `core-concepts/persistence.mdx`, `api/commands/content/set-content.mdx`, `guides/mobile-apps.mdx` | Inhalt als **JSON** speichern; `setContent(…, { emitUpdate: false })` (v3: Standard `true`); auf anderen Plattformen **dieselben Extensions** verwenden (Schema-Parität) |
| Caddy | `caddyserver/website` → `quick-starts/reverse-proxy.md`, `automatic-https.md` | Domain im Caddyfile → automatisches HTTPS (Let’s Encrypt/ZeroSSL), HTTP→HTTPS-Weiterleitung; braucht A/AAAA-Record, offene Ports 80/443 und ein persistentes Datenverzeichnis |
| OWASP | `OWASP/CheatSheetSeries` → Password Storage, Session Management, CSRF Prevention | **Argon2id** min. 19 MiB, t=2, p=1; Cookie `__Host-…; Secure; HttpOnly; SameSite=Strict; Path=/`; CSRF: `Sec-Fetch-Site` mit Origin-Prüfung als Pflicht-Fallback, Custom Request Header für API |
| sqlx | `launchbadge/sqlx` → `README.md` | SQLite-Treiber, `migrate!` bettet Migrationen ein; `foreign_keys=ON` Standard; WAL nur auf Wunsch. Hauptzweig zeigt **0.9.0**, ob es veröffentlicht ist, beim Umsetzen prüfen |
| keyring | `open-source-cooperative/keyring-rs` → `README.md` (**4.2.0**) | Für Anwendungen: `keyring-core` plus das passende Store-Crate (Windows Credential Manager) statt `keyring` mit `cli` |

Bei Problemen: zuerst die offizielle Doku und Changelogs, dann **GitHub Issues/Discussions** des jeweiligen
Projekts, dann **Stack Overflow**. Die Fundstelle wird im Commit oder in `DECISIONS.md` vermerkt.

## 4. Repository-Struktur (neu)

```
crates/buddy-core/        reine, geteilte Logik (kein Tauri, kein axum): Note/Reminder-Modelle, schedule.rs,
                          text.rs (aus src-tauri verschoben), Sync-Datensätze, LWW-Vergleich
server/                   buddy-server (Rust 2024): axum, tokio, sqlx-sqlite, argon2, chrono-tz, reqwest
  migrations/             SQL-Migrationen (sqlx::migrate!)
  Dockerfile              Multi-Stage: Web-App bauen → Server bauen → schlankes Laufzeit-Image (non-root)
deploy/                   compose.yaml, Caddyfile, ntfy/server.yml, .env.example, README.md (Deutsch)
src/web/                  Web-App fürs Handy (React + TipTap), eigene fetch-API-Schicht
web.html                  Vite-Einstieg der Web-App
vite.web.config.ts        eigener Build → dist-web/
src-tauri/src/sync/       Desktop-Sync-Client
```

- **Kein Cargo-Workspace im Repo-Root.** `src-tauri` und `server` binden `buddy-core` per
  `path = "../crates/buddy-core"` ein. Tauri-Build, `target/`-Pfad und MinGW-Cross-Build bleiben unverändert.
- `src-tauri/src/model.rs` exportiert die verschobenen Typen weiter (`pub use buddy_core::…`). Vertragstests und
  bestehende Importe funktionieren deshalb unverändert.

## 5. Datenmodell und Konfliktregel

### 5.1 Änderungen an bestehenden Typen

- `Reminder` bekommt **`updatedAt: string | null`** (RFC 3339 UTC, `null` bei Altdaten). Neu in `types.ts` und
  `model.rs`, mit `#[serde(default)]`; Laden bleibt tolerant.
- `Note` bleibt unverändert. Sein `updatedAt` setzt der Editor (`new Date().toISOString()`). Wird eine Notiz aus dem
  Sync übernommen, behält sie den `updatedAt`-Wert der Gegenseite.
- Neue Einstellungen (Lektion 8 aus HANDOFF beachten: `types.ts` + `DEFAULT_SETTINGS` + `model.rs` + Test-JSON +
  Schlüsselzahl im Vertragstest):
  `syncEnabled: boolean` (false), `syncServerUrl: string` (""), `syncDeviceName: string` ("").
  **Das Geräte-Token steht nie in `settings.json`.**

### 5.2 Sync-Datensätze (in `buddy-core`, serde camelCase)

```jsonc
// NoteRecord
{ "id": "<uuid>", "updatedAt": "2026-11-06T10:00:00.000Z", "updatedBy": "<deviceId|web>",
  "deleted": false, "note": { /* Note aus types.ts */ } }           // deleted=true → note = null
// ReminderRecord
{ "noteId": "<uuid>", "updatedAt": "…", "updatedBy": "…", "deleted": false, "reminder": { /* Reminder */ } }
// OrderRecord (Reihenfolge des Karussells, ganze Liste)
{ "updatedAt": "…", "updatedBy": "…", "ids": ["<uuid>", "…"] }
```

### 5.3 Last-Writer-Wins (Entscheidung des Benutzers)

- Pro Dokument (Notiz, Erinnerung, Reihenfolge) gewinnt der höhere `updatedAt`. Bei Gleichstand gewinnt der
  lexikografisch größere `updatedBy`. Diese Regel ist eine einzige, getestete Funktion in `buddy-core`.
- **Löschen ist ein Datensatz** (Tombstone mit `deleted: true`, `updatedAt` = Löschzeit) und nimmt normal an der
  LWW-Regel teil. Eine Bearbeitung nach dem Löschen bringt die Notiz zurück.
- **Uhrzeit-Schutz:** Liegt ein `updatedAt` mehr als 2 Minuten nach der Serverzeit, ersetzt der Server ihn durch die
  Serverzeit. Bearbeitungen aus der Web-App bekommen immer die Serverzeit. Jede Server-Antwort enthält `serverTime`.
  Weicht die Uhr des Desktops um mehr als 2 Minuten ab, zeigt die Desktop-App einen Hinweis.
- **Sicherheitsnetz:** Der Server hebt die Fassung auf, die beim Überschreiben verloren hat, in `note_revisions`
  (30 Tage, max. 20 pro Notiz). Wiederherstellen ist in v3 nur per API bzw. CLI möglich, nicht in der Oberfläche.

### 5.4 Erinnerungen und LWW (wichtig gegen „Wiederauferstehen“)

- **Benutzeraktionen** (setzen, entfernen, erledigen, verschieben) setzen `updatedAt` = jetzt.
- **Fällig werden ist abgeleitet und setzt `updatedAt` nicht.** Es ändert nur `state` und `firedAt`, auf dem Server
  zählt zusätzlich `seq` hoch. Erledigt jemand die Erinnerung am Handy, kann ein PC, der später offline nachfeuert,
  sie deshalb nicht wieder auf „fällig“ setzen.
- Gleichstand bei `updatedAt`: der weiter fortgeschrittene Zustand gewinnt (`due` vor `scheduled`), erst danach
  `updatedBy`.
- **Push-Pflicht auf dem Server:** Für jedes Vorkommen `(noteId, at)` mit `state ∈ {scheduled, due}` und
  `at ≤ jetzt` sendet der Server **genau einmal** an ntfy. Das gilt auch, wenn ein PC den Zustand schon auf `due` gesetzt
  hat. Die Tabelle `push_log` verhindert doppelte Nachrichten. Vorkommen, die älter als 24 h sind, werden nicht mehr
  gesendet (z. B. nach längerem Serverausfall).
- **Desktop:** Feuert der lokale Scheduler, gibt es Toast und Ton wie bisher. Meldet der Sync ein `scheduled → due`, das
  lokal noch nicht gefeuert hat, und liegt `firedAt` höchstens 10 Minuten zurück, alarmiert der Desktop ebenfalls.
  Sonst zeigt er nur Badge und Animation.
- Wiederholungen werden auf dem Server in der **IANA-Zeitzone des Kontos** berechnet (`chrono-tz`). Die
  `schedule.rs`-Funktionen sind bereits generisch über `TimeZone`. Der Desktop meldet seine Zone beim Verbinden;
  `chrono` hängt ohnehin schon transitiv an `iana-time-zone`.

## 6. API-Vertrag v1 (Server)

Basis `https://buddy.<domain>/api/v1`, JSON, Fehler als `{ "error": "<code>", "message": "<Deutsch>" }`.
Auth: Desktop mit `Authorization: Bearer <Geräte-Token>`, Web-App mit Session-Cookie. Jede Antwort hat
`Cache-Control: no-store`.

| Methode & Pfad | Auth | Body → Antwort | Hinweise |
|---|---|---|---|
| `GET /health` | – | → `{ok:true}` | für den Docker-Healthcheck |
| `POST /devices` | Benutzer+Passwort im Body | `{username,password,deviceName}` → `{deviceId,token}` | Token: 32 Byte Zufall (base64url); gespeichert wird nur SHA-256 |
| `DELETE /devices/current` | Bearer | → 204 | Gerät abmelden (Token widerrufen) |
| `POST /session` | – | `{username,password}` → 204 + `Set-Cookie` | Web-Login, Session-ID rotieren |
| `DELETE /session` | Cookie | → 204 | Abmelden |
| `GET /me` | beide | → `{username,timeZone,ntfy:{url,topic},serverTime}` | |
| `PUT /me` | beide | `{timeZone}` → `/me` | IANA-Name prüfen |
| `GET /sync/changes?since=<n>&limit=<≤500>` | beide | → `{cursor,hasMore,notes:[NoteRecord],reminders:[ReminderRecord],order:OrderRecord\|null,serverTime}` | nach `seq` sortiert; `410 full_resync_required`, wenn `since` < ältester aufbewahrter Stand |
| `POST /sync/push` | beide | `{notes:[…],reminders:[…],order?}` → `{results:[{kind,id,status:"applied"\|"stale",current?}],cursor,serverTime}` | LWW pro Datensatz; `stale` liefert die gewinnende Fassung mit; max. 500 Datensätze / 8 MiB |
| `GET /notes` | beide | → `[{id,title,color,updatedAt,snippet,reminder?}]` | Liste für die Web-App (Snippet über `text.rs`) |
| `GET /notes/{id}` · `PUT /notes/{id}` · `DELETE /notes/{id}` | beide | Note ↔ Note | PUT legt an oder ändert; `updatedAt` = Serverzeit |
| `PUT /order` | beide | `{ids}` → OrderRecord | |
| `PUT /reminders/{noteId}` · `DELETE …` | beide | `{at,repeat}` → Reminder | Semantik wie `set_reminder` (PLAN §11) |
| `POST /reminders/{noteId}/ack` · `POST …/snooze` | beide | `{}` / `{minutes:1..=1440}` → Reminder | wie `ack_reminder`/`snooze_reminder` |
| `POST /actions/{token}` | **signiertes Einmal-Token** | → 204 | für die ntfy-Knöpfe; siehe §7.4 |
| `GET /events` (optional, Phase G) | beide | SSE `changed {cursor}` | Live-Aktualisierung |

Grenzen: Notiz-JSON ≤ 1 MiB, Titel ≤ 500 Zeichen, IDs = kanonische UUIDs (`is_valid_note_id`), Inhalt muss ein
TipTap-Dokument (`{"type":"doc",…}`) sein, ≤ 10 000 Notizen pro Konto.

## 7. Server (`server/`)

### 7.1 Technik

Rust 2024, **axum 0.8.x**, tokio, `tower-http` (`trace`, `fs`, `limit`, `set-header`), **sqlx** (SQLite,
`runtime-tokio`, `migrate`; Abfragen mit `query`/`query_as` ohne Offline-Metadaten), `argon2` (Argon2id,
mindestens OWASP-Parameter), `chrono` + `chrono-tz`, `reqwest` (rustls) für ntfy, `tracing`, `buddy-core`.
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
devices(id TEXT PK, user_id → users, name TEXT, token_hash BLOB UNIQUE, created_at, last_seen_at, revoked_at)
sessions(id_hash BLOB PK, user_id → users, created_at, expires_at)
notes(user_id, id TEXT, payload TEXT /*Note-JSON*/, updated_at TEXT, updated_by TEXT, deleted INTEGER,
      seq INTEGER, PK(user_id,id));            INDEX(user_id, seq)
note_revisions(id INTEGER PK, user_id, note_id, payload TEXT, updated_at, replaced_at)
reminders(user_id, note_id, payload TEXT /*Reminder-JSON*/, updated_at, updated_by, deleted, seq,
      PK(user_id,note_id));                    INDEX(user_id, seq)
note_order(user_id PK, ids TEXT /*JSON*/, updated_at, updated_by, seq)
push_log(user_id, note_id, at TEXT, sent_at, ntfy_id TEXT, attempts INTEGER, PK(user_id,note_id,at))
```

- Jede Schreiboperation läuft in **einer Transaktion**: `users.seq += 1`, die Zeile bekommt den neuen `seq`.
- Tombstones werden nach 180 Tagen entfernt; dabei wird `min_cursor` erhöht. Ältere Cursor bekommen `410` und
  führen eine Voll-Synchronisation aus.
- Backup: Ein Hintergrund-Task schreibt nachts `VACUUM INTO '/data/backups/buddy-YYYYMMDD.db'` und behält 14 Stände.
  `deploy/README.md` beschreibt die Kopie außer Haus.

### 7.3 Erinnerungs-Scheduler

Gleiches Muster wie `src-tauri/src/reminders.rs`: ein Task schläft bis zum frühesten `at` (höchstens 30 s) und wird
bei Änderungen per `tokio::sync::Notify` geweckt. Dann:
1. `scheduled` mit `at ≤ jetzt` → `due`, `firedAt` = jetzt, `seq += 1`. `updatedAt` bleibt (siehe §5.4).
2. Für jedes Vorkommen ohne `push_log`-Eintrag (und nicht älter als 24 h) eine ntfy-Nachricht senden (§7.4).
   Bei Fehlern bis zu 3 Wiederholungen (5 s, 30 s, 2 min), danach Log-Eintrag. Der Zustand bleibt unabhängig davon
   `due`.
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

- **Aktions-Tokens** sind HMAC-SHA256 über `{userId, noteId, at, action, exp}` mit `BUDDY_SECRET`, gültig 24 h.
  Sie wirken nur, solange das Vorkommen `(noteId, at)` noch aktuell ist; danach antworten sie mit 204, ändern aber
  nichts. In der Nachricht steht **kein** langlebiges Token, denn ntfy speichert Nachrichten samt Aktionen im Cache.
- Wird die Erinnerung anderswo erledigt, schickt der Server `PUT /<topic>/r-<noteId>/clear`. Das räumt die
  Benachrichtigung unter Android und im Browser ab, unter iOS laut Doku nicht.
- Inhalt bleibt auf dem eigenen Server (keine E2E-Verschlüsselung, Entscheidung des Benutzers). An ntfy.sh gehen nur
  die Poll-Anfragen ohne Inhalt.

### 7.5 Sicherheit

- Passwörter mit **Argon2id** (mindestens m = 19 MiB, t = 2, p = 1), Vergleich in konstanter Zeit, Mindestlänge 12.
- Login-Bremse pro IP und Benutzername: ab 5 Fehlversuchen exponentielle Wartezeit, maximal 15 min. Der echten
  Client-IP aus `X-Forwarded-For` wird nur geglaubt, wenn die Anfrage aus dem Docker-Netz von Caddy kommt.
- Session-Cookie `__Host-buddy_session; Secure; HttpOnly; SameSite=Strict; Path=/`. Serverseitige Sessions
  (nur Hash gespeichert), 30 Tage gleitend, neue ID beim Login.
- CSRF bei Cookie-Auth und unsicheren Methoden: `Sec-Fetch-Site: cross-site` ablehnen. Fehlt der Header, muss
  `Origin` gleich `BUDDY_PUBLIC_URL` sein. Zusätzlich ist der Header `X-Buddy-Request: 1` Pflicht. Bearer-Anfragen
  sind davon ausgenommen.
- Header für die Web-App: CSP `default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:;
  connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'` (`unsafe-inline` nur für Styles,
  wegen TipTap, wie am Desktop), `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`. HSTS setzt Caddy.
- Logs enthalten nie Notizinhalt, Passwörter oder Tokens.

## 8. Desktop (`src-tauri/src/sync/` + Einstellungsfenster + Notizfenster)

### 8.1 Modul

- `sync/mod.rs`: `init` wie bei `reminders` (`app.manage(SyncState)` und eigener Thread). Kein `.state()` außerhalb
  von `state.rs`, nur `try_state` (HANDOFF §5.1).
- `sync/client.rs`: HTTP über **`tauri_plugin_http::reqwest`**, nur Rust-seitig (offizieller Tauri-Weg; Muster
  D-07, keine JS-Permission). Timeout 15 s, User-Agent `DisplayBuddy/<version>`. Server-URL nur `https://`
  (Ausnahme `http://localhost` bzw. `127.0.0.1` für Entwicklung).
  **Muss mit `x86_64-pc-windows-gnu` cross-kompilieren**, also TLS-Backend prüfen (rustls mit `ring` oder native-tls
  mit SChannel; kein Backend, das CMake/NASM verlangt).
- `sync/outbox.rs`: `sync/outbox.json` mit geänderten Notiz-IDs, Tombstones (`id`, `deletedAt`), geänderten
  Erinnerungen und einem Reihenfolge-Flag. Geschrieben wird mit `write_json_atomic`.
- `sync/state.json`: `deviceId`, `cursor`, `lastSyncAt`, `lastError`.
- `sync/merge.rs`: **reine, getestete Funktionen**. Sie wenden entfernte Datensätze mit LWW an und berechnen, was
  hochgeladen wird. Übernahmen aus dem Sync landen **nicht** in der Outbox (sonst Ping-Pong).
- `sync/secret.rs`: Geräte-Token im **Windows-Anmeldeinformationsspeicher** über `keyring-core` und das
  Windows-Store-Crate (laut keyring-rs-README; Crate-Namen auf crates.io prüfen). Hinter einem Trait, damit Tests
  unter Linux einen Speicher-Mock nutzen können.

### 8.2 Ablauf

- **Auslöser:** Änderungen (`save_note`, `delete_note`, `save_order`, `reminders::modify`) markieren die Outbox und
  wecken den Sync-Thread, entprellt um 2 s. Zusätzlich alle 60 s, beim Öffnen des Notizfensters, beim Start und über
  „Jetzt synchronisieren“.
- **Ein Durchlauf:** Push (in Paketen zu ≤ 200 Datensätzen), danach Pull (`since=cursor`, solange `hasMore`) und
  Merge. Eigene Echos (`updatedBy == deviceId` und gleicher Stand) werden übersprungen.
- **Beim Start mit aktivem Sync:** Erst einen Pull versuchen (Timeout 5 s), **dann** feuert der lokale Scheduler
  verpasste Erinnerungen.
- **Erstes Verbinden:** Vereinigung über die ID, gleiche IDs per LWW. Danach meldet der Desktop im Status eine
  Zusammenfassung, z. B. „12 Notizen hochgeladen, 5 heruntergeladen“.
- **Ohne Netz:** Die App funktioniert unverändert, die Outbox überlebt Neustarts, und der Status zeigt „Offline“.
- **401 vom Server:** Status „Abgemeldet – bitte neu verbinden“. Lokale Daten bleiben unangetastet.
- **Lock-Reihenfolge** wie in `reminders.rs` dokumentieren: Niemals den Reminders-Lock halten, während der
  AppState-Lock genommen wird. Netzwerkaufrufe laufen nie unter einem Lock.

### 8.3 Vertrag (die 4-Stellen-Regel aus HANDOFF §5.7 gilt)

| Command | Args | Rückgabe | Fenster |
|---|---|---|---|
| `sync_status` | – | `SyncStatus` | settings |
| `sync_connect` | `serverUrl, username, password, deviceName` | `SyncStatus` | settings |
| `sync_disconnect` | – | `SyncStatus` | settings |
| `sync_now` | – | `SyncStatus` | settings |

`SyncStatus = { enabled, serverUrl, deviceName, state: "off"|"idle"|"syncing"|"offline"|"error"|"unauthorized",
lastSyncAt: string|null, message: string|null, clockSkewSeconds: number|null }`

Events:
- `sync-status` (SyncStatus)
- `notes-changed` (`{ notes: Note[], deletedIds: string[], order: string[] | null }`), geht ans Notizfenster
- `reminders-changed` (besteht schon)

### 8.4 Notizfenster (`useNotesStore.ts`)

- Bei `notes-changed` die Notizen ersetzen bzw. einfügen und entfernen sowie die Reihenfolge übernehmen.
- **Aktive Notiz mit ausstehendem Autosave:** entfernte Fassung ignorieren. Die lokale Speicherung ist neuer und
  gewinnt beim nächsten Push.
- **Aktive Notiz ohne ausstehende Änderung:** Editor per `setContent(json, { emitUpdate: false })` aktualisieren
  (TipTap-Doku), die Cursorposition möglichst erhalten.
- Wird die aktive Notiz entfernt gelöscht, wechselt das Fenster zur Nachbarnotiz und zeigt den Hinweis
  „Notiz wurde auf einem anderen Gerät gelöscht“.
- Regressionstests ergänzen `useNotesStore.races.test.ts`.

### 8.5 Einstellungsfenster

Neuer Abschnitt **„Synchronisation“** zwischen „Erinnerungen“ und „System“:
- Felder: Server-Adresse, Benutzername, Passwort, Gerätename (Standard: Computername).
- Knöpfe: „Verbinden“ bzw. „Trennen“, „Jetzt synchronisieren“.
- Statuszeile: „Zuletzt synchronisiert um …“, „Offline“, „Fehler: …“, „Uhrzeit weicht um … ab“.
- Hinweis „Handy einrichten: <Server-Adresse>/setup öffnen“.
- Alles mit `aria-label`, per Tastatur bedienbar und mit deutschen Texten.

## 9. Web-App fürs Handy (`src/web/`)

- **Eigener Vite-Einstieg** (`web.html`, `vite.web.config.ts`, Ausgabe `dist-web/`). npm-Skripte `dev:web`,
  `build:web`, `test` deckt `src/web` mit ab. `npm run build` baut weiter nur die Desktop-Fenster.
- **TipTap-Schema-Parität:** dieselben Extensions aus `src/components/editor/extensions.ts`. `NoteEditor` und
  `Toolbar` wiederverwenden, sofern sie nichts aus `src/lib/api.ts` importieren (Stand: tun sie nicht).
- **API-Schicht** `src/web/webApi.ts`, die einzige Stelle mit `fetch`: `credentials: "same-origin"`, Header
  `X-Buddy-Request: 1`. Geteilte Komponenten importieren weder `api.ts` noch `webApi.ts`.
- **Seiten**, Routing über Pfade ohne zusätzliche Bibliothek, der Server liefert `index.html` als SPA-Fallback:
  - `/login`
  - `/` Notizliste mit Suche (`src/lib/search.ts`), Farbe, Titel und Glocke
  - `/notes/<id>` Bearbeiten: Titel, Editor, Farbe, Erinnerung setzen/entfernen/erledigen/verschieben,
    Löschen mit Bestätigung. Das ist das Ziel des ntfy-Klicks.
  - `/new`
  - `/setup` mit der ntfy-Anleitung für Android und iOS: Server-URL, Topic, Login für ntfy
- **Autosave** entprellt 1 s per `PUT`. Anzeige „Gespeichert“ bzw. „Nicht gespeichert – offline“. Beim
  Zurückkehren in den Tab (`visibilitychange`) neu laden, falls keine Änderung aussteht.
- **Online-only** in v3 (kein Service Worker / Offline-Speicher). Ein Web-App-Manifest mit Icons ist dabei, damit
  „Zum Home-Bildschirm“ funktioniert.
- **Mobilgerechte Bedienung:** Ziele ≥ 44 px, Toolbar umbrechend, `prefers-reduced-motion`, deutsche Texte,
  `aria-label` an allen Bedienelementen.

## 10. Deployment (VPS)

`deploy/compose.yaml`:
- `caddy`: offizielles Image `caddy:2`, Ports 80, 443 und 443/udp, Volumes `caddy_data`, `caddy_config`.
- `buddy`: Build aus `server/Dockerfile` (oder später als Image aus GHCR), Volume `buddy_data:/data`,
  Healthcheck `/api/v1/health`, läuft als non-root.
- `ntfy`: `binwiederhier/ntfy` mit `serve`, Volumes für Cache, Konfiguration und Auth-DB, Healthcheck laut Doku,
  `init: true`.
- Ein internes Netz verbindet die Dienste; nur Caddy veröffentlicht Ports. Image-Tags beim Umsetzen festpinnen.

`deploy/Caddyfile`:
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
3. `.env` aus `.env.example` füllen, z. B. `BUDDY_SECRET` per `openssl rand -base64 32`.
4. `docker compose up -d --build`.
5. ntfy-Benutzer anlegen:
   - `ntfy user add buddy-server`, `ntfy access buddy-server <topic> wo`, `ntfy token add buddy-server` → in `.env`
   - `ntfy user add handy`, `ntfy access handy <topic> ro`
6. `buddy-server user add <name>`.
7. Handy einrichten: ntfy-App installieren, eigenen Server und Login eintragen, Topic abonnieren; unter Android
   „Instant delivery“ aktivieren.
8. PC verbinden (Einstellungen → Synchronisation).
9. Backups, Updates (`git pull && docker compose up -d --build`) und Fehlersuche (`docker compose logs`).

## 11. Phasen und Arbeitspakete

Arbeitsweise wie gewünscht (HANDOFF §2): Phasen, Subagenten mit je eigenem git-Worktree und **klar
abgegrenzten Ordnern**. Ein Orchestrator integriert. Kleine thematische Commits auf englisch.

| Phase | Inhalt | Ordner (exklusiv) | Abhängig von |
|---|---|---|---|
| **0 Fundament** (Orchestrator, seriell) | Versionen prüfen; `crates/buddy-core` anlegen und `schedule.rs`, `text.rs`, Note/Reminder-Typen verschieben (reiner Refactor, alle Tests grün, Windows-Cross-Build grün); `Reminder.updatedAt`; Sync-Datensätze + LWW-Funktionen + Tests; Vertragstypen in `types.ts`/`model.rs` (Settings, `SyncStatus`, Event-Payloads); D-Einträge final | `crates/`, `src/types.ts`, `src-tauri/src/model.rs`, `src-tauri/src/reminders*`, `docs/` | – |
| **A Server-Kern** | Konfiguration, Migrationen, CLI, Auth (Passwort, Geräte-Token, Sessions, CSRF, Login-Bremse), `/sync/*`, `/notes`, `/order`, `/reminders` (ohne Push), Revisionen, Tombstone-Bereinigung, Backups; Tests per `oneshot` | `server/` (ohne `server/Dockerfile`) | 0 |
| **B Desktop-Sync** | `src-tauri/src/sync/`, `commands/sync.rs`, Einträge in `lib.rs`/`build.rs`/`capabilities/settings.json`, `api.ts` + `api.test.ts`, `contract.rs`, Einstellungs-Abschnitt, `notes-changed` in `useNotesStore`; Tests gegen einen HTTP-Mock | `src-tauri/src/sync/`, `src-tauri/src/commands/sync.rs`, `src/windows/settings/`, `src/windows/notes/useNotesStore*`, `src/lib/api*` | 0 (nur Vertrag §6, nicht Phase A) |
| **C Web-App** | `src/web/`, `web.html`, `vite.web.config.ts`, npm-Skripte; Tests mit gemocktem `fetch` gemäß §6 | `src/web/`, `web.html`, `vite.web.config.ts`, `package.json` (nur Skripte) | 0 |
| **D Erinnerungen + ntfy** | Server-Scheduler, `push_log`, ntfy-Client hinter Trait, Aktions-Tokens + `/actions`, Clear beim Erledigen | `server/src/reminders/`, `server/src/ntfy/` | A |
| **E Deployment** | `server/Dockerfile`, `deploy/*`, deutsche Anleitung | `deploy/`, `server/Dockerfile` | A |
| **F Integration** (Orchestrator) | End-to-End lokal: Server + Fake-ntfy + Desktop (Linux-Smoke unter Xvfb, HANDOFF §4) + Web-App (Playwright, Chromium ist vorinstalliert); Abnahmeszenarien §12; `MANUAL_TESTS.md` v3; README; HANDOFF; Version 0.3.0; Windows-Installer bauen | alle | A–E |
| **G optional** | SSE-Live-Updates (`/events`, axum-Beispiel `sse`); GitHub Actions (Windows-Installer mit MSVC, Server-Image nach GHCR) | – | F |

Parallel laufen können **A, B und C** (nach 0) sowie **D und E** (nach A).

## 12. Tests und Abnahme

**Pflicht-Checks (alle grün):** `npm test`, `npm run build`, `npm run build:web`, `cd src-tauri && cargo test`,
`cargo clippy --all-targets -- -D warnings` (Linux **und** `--target x86_64-pc-windows-gnu`), `cargo fmt --check`,
`cd server && cargo test && cargo clippy --all-targets -- -D warnings`, `cd crates/buddy-core && cargo test`,
NSIS-Cross-Build.

**Abnahmeszenarien (Phase F, lokal mit Fake-ntfy, das Veröffentlichungen mitschreibt):**
1. Notiz am PC anlegen → nach „Jetzt synchronisieren“ in der Web-App sichtbar.
2. Notiz in der Web-App ändern → das PC-Notizfenster zeigt den neuen Inhalt; ungespeichertes Tippen am PC wird
   nicht überschrieben.
3. Offline auf zwei Geräten ändern → überall gewinnt die neueste Fassung, die andere steht in `note_revisions`.
4. Am PC löschen → verschwindet in der Web-App; eine spätere Bearbeitung bringt die Notiz zurück (LWW).
5. Erinnerung am PC setzen, PC beenden → der Server veröffentlicht zur Zeit genau eine ntfy-Nachricht mit Titel,
   Klick-URL und 3 Aktionen.
6. Aktions-URL „Erledigt“ aufrufen → Erinnerung `done` bzw. nächstes Vorkommen; nach dem PC-Start ist kein Badge
   mehr da und es wird **nicht** nachgefeuert.
7. „10 Min. später“ → neues `at`, nach 10 min (simulierte Uhr) erneut genau eine Nachricht.
8. Erinnerung in der Web-App setzen → PC (an) zeigt den Toast, und das Handy bekommt den Push.
9. Falsches Passwort / widerrufenes Gerät → Status „Abgemeldet – bitte neu verbinden“, keine Datenverluste.
10. Server nicht erreichbar → App voll benutzbar, die Outbox überlebt den Neustart, danach wird nachsynchronisiert.
11. Sync aus → Verhalten exakt wie 0.2.0 (alle bisherigen Tests unverändert grün).
12. Sicherheit: Cross-Site-POST mit Cookie wird abgelehnt; abgelaufenes Aktions-Token ändert nichts; im Log stehen
    weder Inhalte noch Tokens; Cookie-Attribute stimmen; Login-Bremse greift.

**Handtests, die nur der Benutzer machen kann** (in `MANUAL_TESTS.md` v3): echter VPS mit Domain und Zertifikat;
ntfy-App unter Android (Instant delivery) und iOS (Push über den Upstream ntfy.sh); Knöpfe in der Benachrichtigung;
Web-App auf dem Handy (Bearbeiten, Home-Bildschirm); Windows-Anmeldeinformationsspeicher; Sync zwischen zwei
Windows-PCs.

## 13. Risiken und noch zu prüfende Punkte

- **Uhren:** LWW hängt an Zeitstempeln; dagegen helfen Klemme, Hinweis bei Abweichung und Serverzeit für
  Web-Bearbeitungen.
- **iOS:** Schnelle Zustellung nur über den Upstream ntfy.sh (Poll-Anfrage ohne Inhalt). Gelingt der Abruf nicht,
  zeigt iOS „New message“ statt des Inhalts. „Clear“ nach dem Erledigen wirkt unter iOS nicht. Die Poll-Anfragen
  unterliegen den Limits von ntfy.sh; für einen Benutzer unkritisch. Nur bei Überschreitung `upstream-access-token`
  setzen (ntfy-Doku).
- **Android ohne „Instant delivery“:** Nachrichten können sich verzögern (ntfy-Doku).
- **Zu verifizieren beim Umsetzen:** ob sqlx 0.9 veröffentlicht ist (sonst 0.8); die Crate-Namen des
  keyring-Windows-Stores; ob das TLS-Backend von reqwest unter MinGW baut; das ntfy-Image-Tag.
- **Docker** fehlt in der Cloud-Umgebung womöglich, dann sind Compose und Caddy nur statisch geprüft und werden
  vom Benutzer auf dem VPS getestet. Ehrlich berichten.
- Die Web-App ist online-only. Gleichzeitiges Bearbeiten derselben Notiz auf zwei Geräten führt zu LWW, nicht zu
  einem Zusammenführen (gewollt).

## 14. Nicht-Ziele in v3

Ende-zu-Ende-Verschlüsselung, Echtzeit-Zusammenarbeit/CRDT, native Handy-App, Offline-Bearbeitung am Handy,
mehrere Benutzerkonten mit Teilen, Sync von Einstellungen, Shortcuts und Skins (bleiben gerätespezifisch), Anhänge.
