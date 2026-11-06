# v3 – Notiz-Sync, installierbare Offline-Web-App, eigene Push-Benachrichtigungen, native Handy-Hülle (Plan)

Stand: 2026-11-06, dritte Fassung. Nachträge vom selben Tag:
1. installierbare Web-App, Offline-Speicher, Gerätezeitstempel;
2. Web-App zeigt Push selbst (ntfy entfällt), native Hülle für Benachrichtigungen ohne Internet,
   Erinnerungen mit eigener Zeitzone.

Grundlage: Version 0.2.0 · Status: **in Umsetzung** (Phase 0 fertig, siehe D-51…D-64)

Dieser Plan ist für v3 so verbindlich wie `docs/PLAN.md` für v1/v2. Abweichungen nur mit Begründung in
`docs/DECISIONS.md`. Ausführende Agenten starten mit `docs/AGENT_PROMPT_V3.md`.

---

## 1. Ziel und Entscheidungen des Benutzers

**Ziel:**
- Notizen und Erinnerungen werden über einen eigenen Server zwischen PC und Handy/Tablet synchronisiert.
- Am Handy gibt es eine **installierbare Web-App (PWA)**. Sie funktioniert auch ohne Internet und zeigt
  Erinnerungen **selbst als Push-Benachrichtigung** an, auch wenn sie geschlossen ist.
- Zusätzlich gibt es dieselbe Oberfläche als **native Android/iOS-App**. Sie plant alle synchronisierten
  Erinnerungen lokal und löst sie deshalb **auch ohne Internet** zur richtigen Zeit aus.
- Synchronisation und Erinnerungen funktionieren zuverlässig, **auch wenn PC und Handy in unterschiedlichen
  Zeitzonen sind**.

| Frage | Entscheidung (2026-11-06) |
|---|---|
| Architektur | Eigener Sync-Server, der Erinnerungen plant und Push sendet |
| Hosting | **VPS mit eigener Domain** (Docker Compose, HTTPS) |
| Handy | Notizen und Erinnerungen **lesen und bearbeiten** |
| Handy-App | **Installierbar** (PWA, Home-Bildschirm) **plus native Hülle** (Tauri 2 Mobile) für Android und iOS |
| Offline | Notizen werden lokal gespeichert, bei Verbindung wird automatisch synchronisiert |
| Push | **Die App zeigt Push selbst an** (Web Push in der PWA, native Benachrichtigungen in der Hülle); **ntfy entfällt** |
| Erinnerung ohne Internet | **Native Hülle** plant alle synchronisierten Erinnerungen lokal und löst sie offline aus. Die PWA kann das technisch nicht, ihr Push kommt nachgeholt, sobald das Gerät wieder online ist |
| Zeitstempel | PC und Handy stempeln jede Änderung mit dem Zeitpunkt der Bearbeitung auf dem Gerät (UTC); diese Zeitstempel entscheiden |
| Zeitzonen | **Jede Erinnerung hat ihre eigene Zeitzone** (Standard: Zone des Geräts beim Anlegen, änderbar) und klingelt auf allen Geräten im selben Moment; jedes Gerät zeigt zusätzlich die eigene Ortszeit |
| Verschlüsselung | Keine Ende-zu-Ende-Verschlüsselung; TLS, Login, Server-Härtung |
| Konflikte | Neueste Änderung gewinnt (LWW pro Dokument) |

Annahmen:
- ein Benutzerkonto mit mehreren Geräten (1–3 PCs, 1–2 Handys, Tablets);
- die Desktop-App bleibt local-first und funktioniert ohne Server genau wie 0.2.0;
- pro Handy wird **entweder** die native App **oder** die PWA genutzt. Beide auf demselben Gerät gehen, ergeben aber
  doppelte Benachrichtigungen.

## 2. Architektur

```
 Windows-PC (Display Buddy)              VPS (Docker Compose)                       Handy / Tablet
┌──────────────────────────┐ HTTPS ┌──────── Caddy :443 (Auto-HTTPS) ────────┐   ┌──────────────────────────────┐
│ storage/ (lokal)         │◄─────►│ buddy.<domain> → buddy-server :8080     │◄─►│ A) PWA (Browser, installiert)│
│ reminders/ (Toast lokal, │       └─────────────────────────────────────────┘   │    Service Worker: App-Hülle,│
│   Zeitzone je Erinnerung)│         buddy-server: axum + SQLite, Sync, Erinne-    │    push → showNotification   │
│ sync/: Outbox, LWW       │         rungs-Scheduler, Push-Versand:                │    IndexedDB + Outbox + Sync │
└──────────────────────────┘          ├─ Web Push (VAPID, RFC 8030/8291) ───────► │ B) Native Hülle (Tauri 2     │
                                      │   über die Push-Dienste der Browser       │    Mobile): gleiche Oberfläche│
                                      │   (FCM/Chrome, Apple, Mozilla)            │    + lokal geplante Benach-   │
                                      └─ native Push (FCM / APNs), nur wenn das ► │    richtigungen (offline!)    │
                                          Gerät die Erinnerung noch nicht kennt   └──────────────────────────────┘
```

Grundsätze:
- **Alle Clients sind offline-first** (PC: Dateien, PWA und native Hülle: IndexedDB) mit Outbox. Es gibt ein
  Sync-Protokoll für alle (`/sync/push`, `/sync/changes`).
- **Zeitstempel sind UTC-Zeitpunkte** (Bearbeitungszeit auf dem Gerät, korrigiert um den Uhr-Offset). Sie hängen nie
  von einer Zeitzone ab. Zeitzonen gibt es nur bei Erinnerungen (Wiederholung, Anzeige).
- **Benachrichtigungen pro Gerät:**
  - PC: lokaler Toast wie bisher.
  - PWA: **Web Push** vom Server; der Service Worker zeigt die Benachrichtigung selbst.
  - Native Hülle: **lokal geplante Benachrichtigung** für jede synchronisierte Erinnerung. Für noch unbekannte
    Erinnerungen weckt ein nativer Push (FCM/APNs) die App.
- **Der Server plant Erinnerungen** und sendet jedem Gerät pro Vorkommen höchstens eine Push-Nachricht
  (`push_log` pro Gerät).

## 3. Offizielle Quellen (gelesen am 2026-11-06)

Die Doku-Webseiten sind in der Cloud-Umgebung teils per Proxy gesperrt. Gelesen wurden deshalb die
Doku-Quelltexte bzw. Daten in den offiziellen GitHub-Repositories, Apples Doku über deren JSON-Schnittstelle.
Bei der Umsetzung erneut prüfen.

| Thema | Offizielle Quelle | Kernaussagen für diesen Plan |
|---|---|---|
| Web Push (Apple) | developer.apple.com → „Sending web push notifications in web apps and browsers“ | iOS/iPadOS **ab 16.4 nur für Home-Bildschirm-Web-Apps**; Erlaubnis nur nach Nutzergeste anfragen; **kein Apple-Entwicklerkonto nötig**; VAPID-Schlüsselpaar; RFC 8030; Header **`TTL`** (Push-Dienst speichert bis zu **30 Tage**, liefert beim nächsten Online-Sein), **`Urgency`** (`high` = sofort), **`Topic`** (fasst Nachrichten zusammen, max. 32 Zeichen base64url), `Content-Encoding`, `Authorization` (VAPID-JWT, max. 1 Tag gültig, nicht öfter als stündlich erneuern); Payload **≤ 4 KB**; **keine unsichtbaren Pushes**, sonst entzieht Safari die Erlaubnis; Fehler 410 = Abo abgelaufen; Ziel-Hosts `*.push.apple.com` |
| Browser-Support | `mdn/browser-compat-data` (`api/PushManager`, `ServiceWorkerRegistration.showNotification`, `Notification`, `ServiceWorkerGlobalScope`, `SyncManager`, `PeriodicSyncManager`, `LockManager`, `StorageManager`, `javascript/builtins/Temporal`) | `PushManager`: Chrome 42, Firefox 44/48, **Safari iOS 16.4 (nur Home-Bildschirm)**; Benachrichtigungs-`actions`: Chrome ja, Firefox 152, **Safari nein**; `notificationclick` im Service Worker: **Safari iOS nein**; `navigate`-Option: Safari 18.5; `tag`: Safari nein; `pushsubscriptionchange`: Safari iOS nein; **`TimestampTrigger` (Notification Triggers) nicht mehr in den Daten = eingestellt**; Periodic Background Sync und Background Sync **nur Chromium**; `Temporal.ZonedDateTime`: Chrome 144, Firefox 139, **Safari nur Preview** → Zeitzonenrechnung über `Intl` |
| Web Push (MDN) | `mdn/content` → `progressive_web_apps/guides/offline_and_background_operation` (Abschnitt Push), Push API, Notifications API | Abo über `PushManager.subscribe({ userVisibleOnly: true, applicationServerKey })`, Empfang im `push`-Event des Service Workers, Anzeige mit `registration.showNotification()` |
| Web Push Server | `pimeys/rust-web-push` (**0.11.0**, README) | Verschlüsselung `aes128gcm` und VAPID-Signatur; eigener HTTP-Client über das Modul `request_builder` möglich (Standard-Client isahc oder hyper 0.14) |
| PWA installierbar | `mdn/content` → `making_pwas_installable`, `installing`, `trigger_install_prompt`, `create_a_standalone_app` | Manifest auf jeder Seite; Chromium braucht `name`/`short_name`, Icons 192 + 512, `start_url`, `display`; HTTPS; iOS: „Zum Home-Bildschirm“; `beforeinstallprompt` nur Chromium; pro Browser installierte PWAs teilen keine Daten |
| Speicher | `mdn/content` → `storage_quotas_and_eviction_criteria`, `storagemanager/persist`, `navigator/online` | `navigator.storage.persist()`; Safari löscht Skriptdaten nach 7 Tagen ohne Interaktion (Home-Bildschirm-Apps laut WebKit ausgenommen); `navigator.onLine` unzuverlässig |
| vite-plugin-pwa | `vite-pwa/docs` → `guide/*`, `guide/inject-manifest.md`, `frameworks/react.md`, `deployment/index.md` | **`injectManifest`** für einen eigenen Service Worker (nötig für `push`/`notificationclick`) mit `workbox-precaching`; `registerType: 'prompt'`, `injectRegister: null`; kein Caching auf `/`, `/index.html`, `/sw.js`, `/manifest.webmanifest`; Manifest-MIME `application/manifest+json` |
| IndexedDB | `jakearchibald/idb` (**8.0.4**) | `openDB(name, version, { upgrade })` |
| Tauri Mobile + Benachrichtigungen | `tauri-apps/tauri-docs` → `plugin/notification.mdx`, `start/prerequisites.mdx`, `distribute/app-store.mdx`, `distribute/google-play.mdx`; `plugins-workspace/plugins/notification` (Quellcode) | `Schedule.at(date, repeating, allowWhileIdle)` plant lokal. **Android:** AlarmManager, Datum als UTC geparst, ab Android 12 Erlaubnis für exakte Alarme. **iOS:** `UNTimeIntervalNotificationTrigger` (absoluter Abstand, übersteht Zeitzonenwechsel). **Achtung:** Laut `ios/Sources/Notification.swift` (Z. 179–184) parst der `DateFormatter` das `…Z`-Datum **ohne gesetzte UTC-Zeitzone**, das ist auf echtem Gerät außerhalb von UTC zu prüfen (§10.4). Aktionen (Knöpfe) nur mobil; `pending()`, `cancel(ids)`, `active()`, `removeActive()`, `onAction()`, Channels (Android). **iOS-Build braucht macOS + Xcode**; App-Store-Vertrieb braucht das **Apple Developer Program** |
| Tauri HTTP | `tauri-docs` → `plugin/http-client.mdx`; `plugins-workspace/plugins/http` (**2.8.3**) | Rust: `tauri_plugin_http::reqwest`; JS: `fetch` des Plugins über Rust (kein CORS), Zugriff per Scope in den Capabilities |
| TipTap | `ueberdosis/tiptap-docs` | JSON speichern, `setContent(…, { emitUpdate: false })`, dieselben Extensions überall |
| axum | `tokio-rs/axum` (**0.8.9**) `examples/` | static-file-server/SPA-Fallback, sse, testing (`oneshot`), graceful-shutdown |
| Caddy | `caddyserver/website` | automatisches HTTPS, Reverse Proxy |
| OWASP | `OWASP/CheatSheetSeries` | Argon2id (19 MiB, t=2, p=1), `__Host-`-Cookie mit Secure/HttpOnly/SameSite=Strict, CSRF über Sec-Fetch-Site + Origin + Custom-Header |
| sqlx | `launchbadge/sqlx` | SQLite, `migrate!`; Version beim Umsetzen prüfen (Hauptzweig 0.9.0) |
| keyring | `open-source-cooperative/keyring-rs` (**4.2.0**) | `keyring-core` + Store-Crates (Windows; die Demo-App ist eine Tauri-App auch für iOS/Android) |

Bei Problemen: zuerst die offizielle Doku und Changelogs, dann **GitHub Issues/Discussions** des jeweiligen
Projekts, dann **Stack Overflow**. Die Fundstelle wird im Commit oder in `DECISIONS.md` vermerkt.

## 4. Repository-Struktur (neu)

```
crates/buddy-core/            reine Logik: Modelle, schedule.rs (zeitzonenfähig), text.rs, Sync-Datensätze, LWW, clock
crates/buddy-core/tests/fixtures/
  lww_vectors.json            gemeinsame Testvektoren LWW (Rust + TypeScript)
  schedule_vectors.json       Wiederholung/Verschieben in mehreren Zonen inkl. Sommerzeit (Rust + TypeScript)
server/                       buddy-server: axum, sqlx-sqlite, argon2, chrono-tz, reqwest, web-push
deploy/                       compose.yaml (caddy + buddy), Caddyfile, .env.example, README.md
src/lib/clock.ts              korrigierte Gerätezeit
src/lib/zoned.ts              Zeitzonen-Umrechnung über Intl (Wandzeit ↔ Zeitpunkt, DST-Lücken/-Doppelungen)
src/lib/schedule.ts           TypeScript-Port der Erinnerungsmathe (zeitzonenfähig)
src/lib/sync/                 Sync-Typen + LWW (TypeScript)
src/web/data/                 IndexedDB-Schicht (idb)
src/web/sync/                 Sync-Engine; Plattform-Adapter http.ts (PWA: Cookie) / native (Bearer über plugin-http)
src/web/notify/               Benachrichtigungen: PWA (Web-Push-Abo) und nativ (lokale Planung, Aktionen, Push-Token)
src/web/ui/                   Oberfläche
src/web/sw.ts                 eigener Service Worker (injectManifest): Precache, push, notificationclick
web.html, vite.web.config.ts  PWA-Build → dist-web/
mobile/                       native Hülle: Tauri-2-Projekt (eigene tauri.conf.json, src-tauri/ für Android/iOS)
vite.mobile.config.ts         Build der Oberfläche für die Hülle → dist-mobile/ (ohne Service Worker)
public-web/                   Icons, favicon
src-tauri/src/sync/           Desktop-Sync-Client
```

- Kein Cargo-Workspace im Repo-Root: `src-tauri`, `server` und `mobile/src-tauri` binden `buddy-core` per path ein.
- Die native Hülle ist ein **eigenes Tauri-Projekt**. So bleiben Windows-spezifischer Code und die drei
  Desktop-Fenster unberührt.

## 5. Datenmodell, Zeitstempel, Zeitzonen, Konfliktregel

### 5.1 Änderungen an bestehenden Typen

`Reminder` bekommt zwei Felder (in `types.ts` und `model.rs`, beide `#[serde(default)]`):

| Feld | Typ | Bedeutung |
|---|---|---|
| **`updatedAt`** | `string \| null` | UTC, Millisekunden |
| **`timeZone`** | `string \| null` | IANA-Name, z. B. `"Europe/Berlin"`. Zone, in der Uhrzeit und Wiederholung gelten |

- Das Feld `at` bleibt der absolute nächste Zeitpunkt (RFC 3339). Neue Schreibvorgänge verwenden UTC (`…Z`);
  verglichen wird immer als Zeitpunkt.
- **Altdaten ohne `timeZone`:**
  - Der PC trägt beim Laden seine eigene IANA-Zone ein (`iana-time-zone`, ermittelt die Zone auch unter
    Windows).
  - Der Server verwendet `users.time_zone` für Datensätze ohne Zone.
- `Note.updatedAt` ist die Bearbeitungszeit auf dem Gerät (korrigierte Gerätezeit).
- Neue Settings: `syncEnabled`, `syncServerUrl`, `syncDeviceName`; das Token liegt nie in `settings.json`.

### 5.2 Sync-Datensätze

```jsonc
{ "id": "<uuid>", "updatedAt": "2026-11-06T10:00:00.000Z", "updatedBy": "<deviceId>", "deleted": false, "note": { … } }
{ "noteId": "<uuid>", "updatedAt": "…", "updatedBy": "…", "deleted": false,
  "reminder": { "noteId": "…", "at": "2026-11-07T08:00:00.000Z", "timeZone": "Europe/Berlin",
                "repeat": "daily", "state": "scheduled", "firedAt": null, "updatedAt": "…" } }
{ "updatedAt": "…", "updatedBy": "…", "ids": ["…"] }
```

### 5.3 Zeitstempel (verbindlich)

1. **Wo bearbeitet wird, wird sofort gestempelt**, auch offline. Der Wert ist die korrigierte Gerätezeit als
   UTC-Zeitpunkt.
2. Der Server übernimmt Zeitstempel unverändert. Einzige Ausnahme: Liegen sie **mehr als 2 min in der Zukunft**,
   klemmt er sie auf seine Zeit.
3. **Uhr-Offset:** `offset = serverTime − (Sendezeit + RTT/2)`, nur bei RTT < 5 s. Gespeichert wird der Median der
   letzten 5 Messungen, offline gilt der letzte Wert. Bei |offset| > 2 min erscheint eine Warnung.
   - Implementiert in `src/lib/clock.ts` und `buddy_core::clock`.
   - Den Offset liefert `sync-status` (PC) bzw. das Meta-Store (Web/nativ).
4. Format `YYYY-MM-DDTHH:MM:SS.sssZ`. **Zeitzonen der Geräte spielen für Zeitstempel, LWW, Cursor und Uhr-Offset
   keine Rolle**, alles ist UTC.

### 5.4 Last-Writer-Wins

- Pro Dokument gewinnt der höhere `updatedAt`; bei Gleichstand der größere `updatedBy`.
- Die Regel gibt es einmal in Rust (`buddy-core`) und einmal in TypeScript (`src/lib/sync/lww.ts`). **Beide bestehen
  `lww_vectors.json`.**
- Löschen ist ein Tombstone und nimmt normal an LWW teil.
- Jede Verlierer-Fassung liegt 30 Tage in `note_revisions` (`replaced`/`rejected`), und der Client zeigt einen Hinweis.

### 5.5 Erinnerungen in Zeitzonen (Nachtrag, verbindlich)

- **Jede Erinnerung gehört zu einer Zone** (`timeZone`). Standard ist die Zone des Geräts beim Anlegen:
  - PC über `iana-time-zone`,
  - Web/nativ über `Intl.DateTimeFormat().resolvedOptions().timeZone`.
- Im Erinnungsdialog lässt sich die Zone ändern (Auswahl über `Intl.supportedValuesOf('timeZone')`).
- **Wandzeit → Zeitpunkt:** Eingegeben werden Datum und Uhrzeit **in der Zone der Erinnerung**, daraus entsteht `at`
  (UTC).
  - DST-Lücke: die nächste gültige Zeit.
  - DST-Doppelung: die frühere.
  - Das entspricht dem heutigen `resolve_local`.
- **Wiederholung** (täglich, werktags, wöchentlich, monatlich) rechnet **immer in der Zone der Erinnerung**, nie in
  der Zone des Geräts:
  - Rust (PC, Server): `chrono-tz` mit `reminder.timeZone`. Der PC ersetzt dafür `chrono::Local` in den
    Erinnerungs-Aufrufen.
  - TypeScript (Web/nativ): `src/lib/zoned.ts` über `Intl.DateTimeFormat(…, { timeZone })` /
    `formatToParts`, denn `Temporal` gibt es in Safari noch nicht.
  - **Beide bestehen `schedule_vectors.json`**, das mehrere Zonen enthält: `Europe/Berlin`, `America/New_York`,
    `Asia/Tokyo`, `Australia/Lord_Howe` (30-min-Sommerzeit), `Asia/Kolkata` (+05:30). Dazu kommen die Wochen, in
    denen EU und USA zu verschiedenen Terminen umstellen (März/Oktober–November).
  - Die Vitest-Läufe laufen zusätzlich mit `TZ=America/New_York` und `TZ=Asia/Tokyo`. Damit ist bewiesen, dass die
    Gerätezone das Ergebnis nicht beeinflusst.
- **Nur das Gerät, das eine Aktion ausführt, rechnet.** Erledigen, Verschieben und Setzen berechnen das neue `at`;
  alle anderen übernehmen den absoluten Zeitpunkt. Unterschiedliche tzdata-Stände (Windows, Browser-ICU,
  chrono-tz) können deshalb nicht zu abweichenden Ergebnissen führen.
- **Fällig werden** vergleicht nur `at` mit „jetzt“ (UTC) und hängt von keiner Zone ab. Es setzt `updatedAt`
  **nicht**. Gleichstand: `due` vor `scheduled`.
- **Anzeige:** Jedes Gerät zeigt die Zeit in **seiner** Ortszeit. Weicht die Zone der Erinnerung ab, steht die
  Originalzeit dabei, z. B. „Mi 03:00 (09:00 Berlin)“. „Heute/Morgen“ bezieht sich auf die Gerätezone.
- **Reisen:** Wechselt die Zone eines Geräts, ändert sich nur die Anzeige.
  - Lokal geplante native Benachrichtigungen beruhen auf absoluten Zeitpunkten.
  - Die Hülle plant beim Fortsetzen und nach jedem Sync neu (§10.3).
- **Push-Pflicht:** Für jedes Vorkommen `(noteId, at)` mit `state ∈ {scheduled, due}` und `at ≤ jetzt` stößt der
  Server den Versand an, pro Gerät höchstens einmal (§7.4). Nicht mehr gesendet wird, was älter als 24 h ist.
- Der Desktop-Toast bleibt wie bisher. Für einen über den Sync gemeldeten Übergang `due` alarmiert der PC nur, wenn
  `firedAt` ≤ 10 min zurückliegt.

## 6. API-Vertrag v1 (Server)

Basis `https://buddy.<domain>/api/v1`, JSON. Fehler kommen als `{error, message}`, jede Antwort trägt `serverTime`
und `Cache-Control: no-store`. Auth: Bearer-Token (PC, native Hülle) oder Session-Cookie (PWA).

| Methode & Pfad | Auth | Body → Antwort | Hinweise |
|---|---|---|---|
| `GET /health` | – | `{ok:true}` | Healthcheck |
| `POST /devices` | Benutzer+Passwort | `{username,password,deviceName,kind:"desktop"\|"mobile"}` → `{deviceId,token}` | PC und native Hülle; nur SHA-256 des Tokens gespeichert |
| `DELETE /devices/current` | Bearer | → 204 | abmelden |
| `POST /session` / `DELETE /session` | – / Cookie | `{username,password,deviceName,deviceId?}` → `{deviceId}` + Cookie | PWA = Gerät `kind=web` |
| `GET /me` · `PUT /me` | beide | `{username,timeZone,deviceId,serverTime}` / `{timeZone}` | `timeZone` = Standard für Altdaten |
| `GET /sync/changes?since&limit` | beide | `{cursor,hasMore,notes,reminders,order,serverTime}` | `410 full_resync_required` |
| `POST /sync/push` | beide | `{notes,reminders,order?,deviceState?}` → `{results,cursor,serverTime}` | einziger Schreibweg, idempotent. `deviceState` (nur native Hülle): `{scheduledSeq, localNotifications:"granted"\|"denied"}` |
| `GET /push/vapid-public-key` | beide | → `{key}` | öffentlicher VAPID-Schlüssel (base64url) |
| `PUT /push/subscription` · `DELETE …` | Cookie | `{endpoint,keys:{p256dh,auth}}` → 204 | Web-Push-Abo der aktuellen PWA |
| `PUT /devices/current/push` · `DELETE …` | Bearer | `{platform:"fcm"\|"apns",token}` → 204 | nativer Push-Token (Phase N2) |
| `POST /push/test` | beide | → 204 | Testbenachrichtigung an das aufrufende Gerät |
| `GET /events` (optional) | beide | SSE | Phase G |

**Ergänzung Phase 0:** Die genauen Nachrichten (Feldnamen, `PushResult`-Status `applied`/`stale`/`invalid`,
`clampedUpdatedAt`, Fehler-Codes) stehen verbindlich in `crates/buddy-core/src/sync.rs` und `src/lib/sync/types.ts`
mit Beispielen in `crates/buddy-core/tests/fixtures/api_examples.json` (D-63).

Keine CRUD-Endpunkte mit Serverzeit und keine Aktions-Token-URLs. Knöpfe in Benachrichtigungen werden auf dem Gerät
ausgeführt (Datenschicht + Outbox, §9.4/§10.3).

## 7. Server (`server/`)

### 7.1 Technik und Konfiguration

**Stack:** Rust 2024 mit
- axum 0.8.x, tokio, tower-http,
- sqlx (SQLite),
- argon2, chrono + chrono-tz,
- reqwest (rustls),
- **web-push** (0.11, ohne Standard-Client; Anfragen über `request_builder` und mit reqwest gesendet),
- tracing, buddy-core.

**Konfiguration** über Umgebungsvariablen:

| Variable | Bedeutung |
|---|---|
| `BUDDY_LISTEN`, `BUDDY_PUBLIC_URL`, `BUDDY_DB` | Adresse, öffentliche URL, Datenbankpfad |
| `BUDDY_WEB_DIR` | Verzeichnis der Web-App |
| **`BUDDY_VAPID_PRIVATE_KEY_FILE`** | PEM, P-256 |
| **`BUDDY_VAPID_SUBJECT`** | `mailto:…` oder die eigene URL |
| optional (Phase N2) `BUDDY_FCM_SERVICE_ACCOUNT_FILE` | Zugang für Android-Push |
| optional (Phase N2) `BUDDY_APNS_KEY_FILE`, `BUDDY_APNS_KEY_ID`, `BUDDY_APNS_TEAM_ID`, `BUDDY_APNS_TOPIC` | Zugang für iOS-Push |

**CLI:** `serve`, `user add/passwd`, `device list/revoke`, `revisions`, `restore`, **`vapid generate`**
(Schlüsselpaar erzeugen).

### 7.2 Datenbank (SQLite, WAL)

```sql
users(id PK, username UNIQUE, password_hash, time_zone, seq, min_cursor, created_at)
devices(id PK, user_id, kind /*desktop|web|mobile*/, name, token_hash NULL, created_at, last_seen_at, revoked_at,
        synced_seq INTEGER /*letzter vollständig abgeholter Stand*/, scheduled_seq INTEGER NULL,
        local_notifications TEXT NULL, native_push_platform TEXT NULL, native_push_token TEXT NULL)
sessions(id_hash PK, user_id, device_id, created_at, expires_at)
push_subscriptions(device_id PK, endpoint, p256dh, auth, created_at, last_success_at, failures)
notes(user_id, id, payload /*Note-JSON*/, updated_at, updated_by, deleted, seq, received_at, PK(user_id,id))
                                                                  INDEX(user_id, seq)
note_revisions(id PK, user_id, note_id, payload, updated_at, updated_by, reason /*replaced|rejected*/, stored_at)
reminders(user_id, note_id, payload /*Reminder-JSON*/, updated_at, updated_by, deleted, seq, received_at,
          PK(user_id,note_id))                                    INDEX(user_id, seq)
note_order(user_id PK, ids /*JSON*/, updated_at, updated_by, seq)
push_log(device_id, note_id, at, channel /*webpush|fcm|apns*/, sent_at, status, attempts, PK(device_id,note_id,at))
```

- **Transaktionen:** Jede Schreiboperation läuft in einer Transaktion. Dabei wird `users.seq += 1` gesetzt, und die
  Zeile bekommt den neuen `seq`. `received_at` dient nur der Diagnose, nicht LWW.
- **Gerätestand:**
  - `devices.synced_seq` wird gesetzt, wenn ein Gerät eine Pull-Folge mit `hasMore=false` abgeschlossen hat.
  - `scheduled_seq` und `local_notifications` stammen aus `deviceState`.
- **Tombstones** werden nach 180 Tagen entfernt, dabei wird `min_cursor` erhöht. Ältere Cursor bekommen `410` und
  laden alles neu; die Outbox des Geräts bleibt erhalten.
- **Backup:** nachts `VACUUM INTO '/data/backups/buddy-YYYYMMDD.db'`, 14 Stände.

### 7.3 Erinnerungs-Scheduler

Gleiches Muster wie `src-tauri/src/reminders.rs`: Ein Task schläft bis zum frühesten `at` (höchstens 30 s) und
wird bei Änderungen über `tokio::sync::Notify` geweckt. Dann:

1. `scheduled` mit `at ≤ jetzt` → `due`, `firedAt` = jetzt, `seq += 1`; **`updatedAt` bleibt**.
2. Für jedes Vorkommen, das nicht älter als 24 h ist, gehen die Push-Nachrichten pro Gerät nach §7.4 raus. Bei
   Fehlern gibt es bis zu 3 Wiederholungen (5 s, 30 s, 2 min).
3. Verpasste Vorkommen (Server war aus) feuern beim Start einmal.

Die Zeit ist als `Clock`-Trait injiziert. Rechnet der Server selbst eine Wiederholung (nur bei eigenen Aktionen,
z. B. der Testfunktion), nimmt er `reminder.timeZone`, ersatzweise `users.time_zone`.

### 7.4 Push-Versand pro Gerät

Für jedes fällige Vorkommen `(noteId, at)` und jedes aktive Gerät ohne `push_log`-Eintrag:

| Gerät | Kanal | Regel |
|---|---|---|
| `web` mit Abo | **Web Push** | immer |
| `mobile` | **FCM/APNs** (Phase N2) | nur wenn `scheduled_seq` < `seq` der Erinnerung (das Gerät hat diese Fassung noch nicht lokal geplant) **oder** `local_notifications = "denied"`; sonst klingelt die lokale Planung, und ein Push würde sie verdoppeln |
| `desktop` | – | lokaler Toast |

**Web-Push-Anfrage** (RFC 8030/8291/8292 laut Apple-Doku):
- Header:
  - `TTL: 86400` (24 h; der Push-Dienst liefert nach, sobald das Gerät online ist)
  - `Urgency: high`
  - `Topic: r<base64url(sha256(noteId))[:31]>`. Eine noch nicht zugestellte ältere Nachricht zur selben Erinnerung
    wird dadurch ersetzt, etwa nach dem Verschieben.
  - `Content-Encoding: aes128gcm`
  - `Authorization: vapid …` (JWT ≤ 24 h, wiederverwenden, höchstens stündlich neu)
- Payload (verschlüsselt, ≤ 4 KB; Notiztext auf 100 Zeichen gekürzt):
  ```json
  { "v": 1, "type": "reminder", "noteId": "…", "at": "…Z", "timeZone": "Europe/Berlin",
    "title": "Erinnerung: <Titel>", "body": "<erste 100 Zeichen>", "url": "/notes/<noteId>" }
  ```
- Antworten:
  - `201` → `push_log` ok
  - `404`/`410` → Abo löschen, das Gerät meldet beim nächsten Start ein neues an
  - `413` → Text kürzen
  - `429`/`5xx` → Wiederholungen nach 5 s, 30 s, 2 min
- Erreichbarkeit: Der VPS muss die Push-Dienste erreichen (u. a. `*.push.apple.com`, `fcm.googleapis.com`,
  Mozilla autopush). Bei eingeschränktem ausgehendem Netz diese Hosts freigeben.

**Nativer Push (Phase N2):** FCM HTTP v1 (Android) bzw. APNs mit Token-Authentifizierung (iOS). Alternativ FCM für
beide, falls das gewählte Tauri-Plugin unter iOS FCM-Tokens liefert. Die Nachricht ist sichtbar (Titel und Text wie
oben) und enthält `noteId`/`at`; die App synchronisiert beim Öffnen.

**Kein Entfernen aus der Ferne.** Web Push erlaubt keine unsichtbaren Nachrichten (Apple). Erledigte Erinnerungen
räumt jedes Gerät deshalb selbst ab:
- PWA: beim nächsten Öffnen bzw. Push über `registration.getNotifications()`, wo unterstützt;
- native Hülle: nach jedem Sync über `cancel`/`removeActive`.

### 7.5 Sicherheit und Auslieferung

- **Passwörter:** Argon2id mit mindestens m = 19 MiB, t = 2, p = 1; Vergleich in konstanter Zeit; mindestens
  12 Zeichen.
- **Login-Bremse:** pro IP und Benutzername, ab 5 Fehlversuchen exponentiell bis 15 min. `X-Forwarded-For` gilt nur,
  wenn die Anfrage aus dem Docker-Netz von Caddy kommt.
- **Session-Cookie:** `__Host-buddy_session; Secure; HttpOnly; SameSite=Strict; Path=/`.
  - Die Sitzung liegt auf dem Server, gespeichert wird nur ihr Hash.
  - Sie gilt 30 Tage und verlängert sich mit jedem Sync; beim Login gibt es eine neue ID.
  - Die ID liegt nie in IndexedDB oder localStorage.
- **CSRF** (nur Cookie-Anfragen mit unsicheren Methoden):
  - `Sec-Fetch-Site: cross-site` wird abgelehnt;
  - fehlt der Header, muss `Origin` gleich `BUDDY_PUBLIC_URL` sein;
  - der Header `X-Buddy-Request: 1` ist Pflicht;
  - Bearer-Anfragen sind ausgenommen.
- **Cache-Header** (vite-plugin-pwa-Doku):
  - `/`, `/index.html`, `/sw.js`, `/manifest.webmanifest` und alle SPA-Pfade: `no-cache`;
  - `/assets/*`: `public, max-age=31536000, immutable`;
  - API: `no-store`;
  - Manifest mit `Content-Type: application/manifest+json`.
- **CSP:** `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:;
  connect-src 'self'; worker-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'none';
  form-action 'self'`. Dazu `X-Content-Type-Options: nosniff` und `Referrer-Policy: no-referrer`; HSTS setzt Caddy.
- **Geheimnisse:**
  - Logs enthalten nie Notizinhalt, Passwörter, Tokens, Push-Endpunkte oder Schlüssel.
  - Der private VAPID-Schlüssel ist nur für den Server-Benutzer lesbar.

## 8. Desktop (`src-tauri/src/sync/`, Einstellungen, Notizfenster)

**Sync-Modul `src-tauri/src/sync/`:**
- `init` wie bei `reminders` (`app.manage` + Thread); außerhalb von `state.rs` nur `try_state`.
- `client.rs`: HTTP über `tauri_plugin_http::reqwest`, nur Rust-seitig (Muster D-07), Timeout 15 s, nur `https://`
  (Ausnahme localhost). Er misst den Uhr-Offset und **muss mit `x86_64-pc-windows-gnu` bauen**.
- `outbox.rs`: `sync/outbox.json` mit Notiz-IDs, Tombstones, Erinnerungen und Reihenfolge-Flag; geschrieben über
  `write_json_atomic`.
- `state.json`: `deviceId`, `cursor`, `lastSyncAt`, `lastError`, `clockOffsets`.
- `merge.rs`: reine LWW-Funktionen aus `buddy-core`; Übernahmen aus dem Sync kommen nicht in die Outbox.
- `secret.rs`: Token im Windows-Anmeldeinformationsspeicher (`keyring-core`), hinter einem Trait.
- `sync::corrected_now()` liefert die korrigierte Zeit für `reminders`.

**Ablauf:**
- Änderungen wecken den Sync nach 2 s; außerdem läuft er alle 60 s, beim Öffnen des Notizfensters, beim Start und
  bei „Jetzt synchronisieren“.
- Erst Push (in Paketen ≤ 200), dann Pull und Merge. Echos werden übersprungen.
- Beim Start zuerst ein Pull (Timeout 5 s), **danach** feuert der lokale Scheduler.
- Beim ersten Verbinden werden die Daten vereinigt: über die ID, bei gleicher ID per LWW.
- Offline funktioniert alles; der Status zeigt „Offline – n Änderungen warten“.
- 401 → „Abgemeldet – bitte neu verbinden“, die Outbox bleibt. Netzwerkaufrufe laufen nie unter einem Lock.

**Commands** (4-Stellen-Regel HANDOFF §5.7):

| Command | Argumente | Fenster |
|---|---|---|
| `sync_status` | – | settings, notes |
| `sync_connect` | `serverUrl, username, password, deviceName` | settings |
| `sync_disconnect` | – | settings |
| `sync_now` | – | settings |

- **`SyncStatus`** = `{enabled, serverUrl, deviceName, state: "off"|"idle"|"syncing"|"offline"|"error"|"unauthorized",
  lastSyncAt, pending, message, clockOffsetMs}`.
- **Events:** `sync-status`, `notes-changed` (`{notes, deletedIds, order}`), `reminders-changed`.

**Notizfenster (`useNotesStore`):**
- `updatedAt` = `clock.correctedNow()`; ohne Sync ist der Offset 0, das Verhalten entspricht 0.2.0.
- `notes-changed` einarbeiten:
  - Hat die aktive Notiz eine ausstehende Speicherung, wird die entfernte Fassung ignoriert.
  - Sonst `setContent(json, { emitUpdate: false })`.
  - Wurde die aktive Notiz entfernt gelöscht, wird eine Nachbarnotiz gewählt und ein Hinweis angezeigt.
- Regressionstests in `useNotesStore.races.test.ts`.

**Einstellungsfenster:** Abschnitt „Synchronisation“ mit Server-Adresse, Benutzer, Passwort, Gerätename,
Verbinden/Trennen, „Jetzt synchronisieren“, Status und Uhr-Warnung.

Dazu kommt neu:

- **Erinnerungen mit Zeitzone:**
  - `set_reminder` bekommt das Argument `timeZone` (Option, IANA). 4-Stellen-Regel, Vertragstest und PLAN-Liste
    anpassen.
  - Rust rechnet `ack`/`snooze`/Wiederholung mit `chrono-tz` in `reminder.timeZone` (Fallback: IANA-Zone des PCs)
    statt mit `Local`.
  - `sanitize` füllt fehlende Zonen mit der Zone des PCs.
- **Erinnerungs-Popover** (`src/windows/notes/Reminder.tsx`):
  - Datum und Uhrzeit werden in der Zone der Erinnerung eingegeben (Standard: Zone des PCs).
  - Eine Zonen-Auswahl ist eingeklappt hinter „Zeitzone: Europe/Berlin – ändern“.
  - Weicht die Zone ab, steht dort zusätzlich „Bei dir: …“.
  - Dazu `src/lib/zoned.ts` nutzen.
- Anzeigen wie Banner, Badge-Tooltip und Suchtreffer zeigen die PC-Ortszeit und bei abweichender Zone die
  Originalzeit dazu.

## 9. Installierbare Offline-Web-App (PWA)

### 9.1 Installierbarkeit

- **Build:** vite-plugin-pwa mit **`strategies: 'injectManifest'`** und eigenem Service Worker `src/web/sw.ts`
  (`workbox-precaching`: `precacheAndRoute(self.__WB_MANIFEST)`, `cleanupOutdatedCaches`, Navigations-Fallback auf
  `index.html` außer `/api/`). Dazu `registerType: 'prompt'` und `injectRegister: null`; registriert wird über
  `virtual:pwa-register/react`.
- **Manifest:** `name`, `short_name`, `description`, `lang` de, `start_url` `/`, `scope` `/`, `display` standalone,
  Farben, Icons 192/512 und maskable.
- **`web.html`:** viewport, title, description, favicon, `apple-touch-icon` 180, `theme-color`.
- **Installieren:** Chromium über `beforeinstallprompt` und einen eigenen Knopf. iOS und Firefox bekommen eine
  Anleitungskarte. Die installierte App erkennt sich über `display-mode: standalone`.
- **Update-Banner** über `useRegisterSW`, erst nachdem alle Speichervorgänge abgeschlossen sind.

### 9.2 Lokale Daten (`src/web/data/`)

- **Datenbank:** IndexedDB `display-buddy` über `idb`, Schema-Upgrades per `openDB(…, { upgrade })`.
- **Stores:**
  - `notes` (Schlüssel `id`)
  - `reminders` (Schlüssel `noteId`)
  - `meta`: `deviceId`, Konto, `cursor`, `order`, `clockOffsets`, `lastSyncAt`, Push-Status
  - `outbox`: Schlüssel `kind:id`, nur die letzte Fassung je Dokument
- **Jede Bearbeitung** wird sofort lokal gespeichert (Autosave 500 ms), mit `updatedAt` = korrigierte Gerätezeit.
  Datensatz und Outbox-Eintrag stehen in **einer** Transaktion. Die Oberfläche liest nur lokal.
- `navigator.storage.persist()` nach dem Login.
- Beim Abmelden wird die lokale Datenbank gelöscht; vorher kommt eine Rückfrage, wenn noch Änderungen warten.

Schnittstelle: `listNotes`, `getNote`, `saveNote`, `deleteNote`, `saveOrder`,
`setReminder(noteId, wallDate, wallTime, timeZone, repeat)`, `removeReminder`, `ackReminder`, `snoozeReminder`,
`pendingCount`, `subscribe`, `signOut`.

Die Datenschicht ist **auch im Service Worker und in der nativen Hülle** nutzbar (kein DOM-Zugriff).

### 9.3 Sync-Engine (`src/web/sync/`)

- **Protokoll wie am PC:**
  1. Push der Outbox in Paketen ≤ 200.
  2. Bei `stale` die Serverfassung übernehmen und einen Hinweis zeigen.
  3. Pull ab `cursor`.
  4. LWW-Merge mit `src/lib/sync/lww.ts`.
- **Auslöser:** Start, `online`, `visibilitychange` → sichtbar, alle 60 s solange sichtbar, 2 s nach einer
  Änderung, manuell.
- **Netzwerkfehler:** `navigator.onLine` dient nur als Hinweis. Ein Netzwerkfehler bedeutet „offline“; Backoff
  5 s → 30 s → 2 min → 5 min.
- **Background Sync** (nur Chromium) ist optional und kein Muss.
- **Mehrere Tabs:** `navigator.locks.request('buddy-sync')` verhindert parallele Läufe; `BroadcastChannel('buddy-data')`
  meldet Änderungen an andere Tabs.
- **401** → Login mit dem Hinweis „n Änderungen werden nach dem Anmelden übertragen“; die Outbox bleibt.
- **410** → alles neu laden und per LWW mischen; die Outbox bleibt.
- **Uhr-Offset** bei jeder Antwort messen, Warnung bei mehr als 2 min.
- **iOS-Speicher:** Im Safari-Tab droht die 7-Tage-Löschung, deshalb der Installationshinweis. Gefährdet sind nur
  nicht synchronisierte Änderungen.

**Plattform-Adapter** `http.ts`:
- **PWA:** `fetch`, gleiche Origin, Cookie, `X-Buddy-Request`.
- **Native Hülle:** `fetch` aus `@tauri-apps/plugin-http` mit `Authorization: Bearer`. Das Token liegt im sicheren
  Speicher (§10.2).

### 9.4 Web Push in der PWA (`src/web/notify/` + `src/web/sw.ts`)

- **Einschalten:**
  - Unter „Einstellungen → Benachrichtigungen“ gibt es den Knopf „Benachrichtigungen aktivieren“.
  - **Im Klick-Handler** (Nutzergeste, Apple-Vorgabe) laufen `Notification.requestPermission()` und
    `registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey })`. Danach folgt
    `PUT /push/subscription`.
  - Ein Knopf „Testbenachrichtigung“ ruft `/push/test` auf.
- **iOS:**
  - Push gibt es nur, wenn die App installiert ist (iOS ≥ 16.4). Im Safari-Tab zeigt der Knopf stattdessen
    „Zuerst zum Home-Bildschirm hinzufügen“.
  - `pushsubscriptionchange` fehlt unter iOS. Deshalb gleicht die App **bei jedem Start** `getSubscription()` mit
    dem Server ab und meldet sich bei Bedarf neu an.
- **`push`-Event im Service Worker:**
  - Es zeigt **immer** eine Benachrichtigung (`event.waitUntil(registration.showNotification(…))`). Ein
    unsichtbarer Push würde unter Safari die Erlaubnis kosten.
  - Optionen je nach Unterstützung:
    - `body` = Text plus „fällig 09:00 (Berlin)“ in Gerätezeit;
    - `tag: "r-<noteId>"`;
    - `data: {noteId, at}`;
    - `actions: [{action:"ack", title:"Erledigt"}, {action:"snooze10", title:"10 Min. später"}]` (Chromium,
      Firefox ≥ 152);
    - `navigate: url` (Safari ≥ 18.5).
  - Zusätzlich speichert der Service Worker den Zustand `due` in IndexedDB. Die App zeigt die Erinnerung dann sofort
    in der Liste fälliger Erinnerungen, auch offline.
- **`notificationclick`** (Android/Chromium, Firefox; **nicht iOS** laut browser-compat-data):
  - Der Knopf „Erledigt“ bzw. „10 Min. später“ führt die Aktion über die Datenschicht aus (korrigierte Zeit,
    Outbox) und versucht danach einen Sync. Das funktioniert auch ohne Netz, der Sync folgt später.
  - Ein Klick auf die Benachrichtigung öffnet bzw. fokussiert die App auf `/notes/<id>` (`clients.openWindow`).
  - Unter iOS öffnet der Tipp die App (bzw. `navigate`). Die App zeigt fällige Erinnerungen mit Knöpfen oben an.
- **Grenze ohne Internet:** Hat das Handy zur fälligen Zeit kein Netz, hält der Push-Dienst die Nachricht bis zu
  24 h (`TTL`) und liefert sie nach, sobald das Gerät online ist. Die Benachrichtigung zeigt dann „fällig seit …“.
  Klingeln ohne Netz gibt es nur in der nativen Hülle (§10).
- Das App-Badge zeigt die Anzahl fälliger Erinnerungen über `navigator.setAppBadge`, wo verfügbar
  (Apple-Doku: iOS ≥ 16.4).

### 9.5 Oberfläche (`src/web/ui/`)

Seiten:
- `/login`, `/`, `/notes/<id>`, `/new`, `/setup`
- `/settings`: Sync, Benachrichtigungen, Speicher, Abmelden

Gemeinsam für Web und nativ:
- dieselben TipTap-Extensions wie am PC;
- Statusleiste;
- Liste und Banner der fälligen Erinnerungen mit „Erledigt“ und „10 Min. später“;
- Erinnerungsdialog mit Zone (wie §8), Anzeige „Bei dir: … (09:00 Berlin)“;
- mobilgerecht (Ziele ≥ 44 px, Safe-Area), `aria-label`, Tastatur, `prefers-reduced-motion`, deutsche Texte.

## 10. Native Hülle (Tauri 2 Mobile, `mobile/`)

### 10.1 Zweck und Aufbau

Dieselbe Oberfläche, Datenschicht und Sync-Engine wie die PWA, gebaut mit `vite.mobile.config.ts` (ohne Service
Worker). Sie läuft in einem eigenen Tauri-2-Projekt für Android und iOS und hat **einen** Zusatz: Sie **plant
Erinnerungen lokal im Betriebssystem**. Dadurch klingeln synchronisierte Erinnerungen **auch ohne Internet und bei
geschlossener App**.

### 10.2 Technik

- **Plugins:**
  - `tauri-plugin-notification`: lokale Planung, Aktionen, Channels;
  - `tauri-plugin-http`: Sync über Bearer-Token; Scope auf `BUDDY_PUBLIC_URL`, das beim Build gesetzt wird;
  - sicherer Token-Speicher über `keyring-core` mit den iOS/Android-Stores (keyring-rs-Ökosystem). Ist das nicht
    tragfähig, ein offizielles Tauri-Plugin für sicheren Speicher nehmen und den Wechsel begründen.
- **Daten:** IndexedDB im WebView, wie in der PWA. Ob die Daten in WKWebView und Android-WebView dauerhaft bleiben,
  ist zu prüfen. Sonst `tauri-plugin-sql` (SQLite) hinter derselben Schnittstelle §9.2.
- **Android:**
  - Notification-Channel „Erinnerungen“ mit hoher Wichtigkeit;
  - Erlaubnis für exakte Alarme (ab Android 12, `canScheduleExactAlarms`);
  - `allowWhileIdle: true`, damit es auch im Doze-Modus klingelt;
  - ab Android 13 die Erlaubnis `POST_NOTIFICATIONS`.
- **iOS:** Erlaubnis über `requestPermission()`. **Höchstens 64 ausstehende lokale Benachrichtigungen** pro App
  (iOS-Grenze), deshalb werden immer die 60 nächsten geplant.

### 10.3 Lokale Planung

- **Wann:** nach jedem Sync, jeder lokalen Änderung, beim Start und beim Fortsetzen.
- **Was:**
  1. Für alle Erinnerungen mit `state = scheduled` und `at > jetzt` wird je eine Benachrichtigung zum
     **absoluten Zeitpunkt** `at` geplant: `Schedule.at(new Date(at), false, true)`.
  2. Die ID wird stabil aus `noteId` + `at` abgeleitet (32-Bit-Hash).
  3. Geänderte oder erledigte Erinnerungen werden mit `cancel` entfernt.
  4. Über `active`/`removeActive` verschwinden erledigte Benachrichtigungen.
- **Wiederholungen:** Es wird jeweils nur das nächste Vorkommen geplant. Das nächste entsteht erst durch
  „Erledigt“ (bestehende Semantik).
- **Knöpfe** „Erledigt“ / „10 Min. später“ über `registerActionTypes` und `onAction`. Die Aktion läuft über die
  Datenschicht (Outbox), funktioniert also auch offline, und plant danach neu.
- **Nach der Planung:** In `/sync/push` meldet die App `deviceState.scheduledSeq` = Cursor, bis zu dem alles geplant
  ist, sowie `localNotifications`. Daran entscheidet der Server, ob ein nativer Push nötig ist (§7.4).
- **Zeitzonenwechsel** auf Reisen: Pläne beruhen auf absoluten Zeitpunkten. Beim Fortsetzen wird trotzdem neu
  geplant, als Schutz gegen Plattform-Eigenheiten.

### 10.4 Zu prüfen (Quellcode-Befund)

Im offiziellen Plugin (iOS, `Notification.swift` Z. 179–184) wird das UTC-Datum `…Z` mit einem `DateFormatter`
ohne gesetzte Zeitzone gelesen. Das kann den Zeitpunkt auf Geräten außerhalb von UTC um den Zonenversatz
verschieben. Auf einem echten iPhone (oder im Simulator) mit z. B. Europe/Berlin und America/New_York prüfen:
- 2 min planen,
- mit `pending()` vergleichen,
- abwarten, ob es pünktlich klingelt.

Bei Abweichung zuerst GitHub-Issues im Repo `tauri-apps/plugins-workspace` suchen bzw. ein Issue anlegen. Dann eine
dokumentierte Umgehung wählen: entweder den Zeitpunkt so übergeben, dass er korrekt ankommt (mit Test), oder das
Plugin als Patch/Fork mit gesetzter UTC-Zeitzone verwenden. Android parst laut Quellcode in UTC.

### 10.5 Nativer Push (Phase N2)

Reicht die lokale Planung nicht aus, z. B. wenn eine Erinnerung am PC angelegt wird, während die native App
geschlossen ist, weckt ein **nativer Push** die App.
- **Plugin:** Ein Community-Plugin für FCM/APNs auswählen (Kandidaten: `tauri-plugin-notifications`,
  `tauri-plugin-remote-push`, `tauri-plugin-mobile-push`; Pflegezustand, Lizenz und Tauri-Version prüfen). Ist keines
  tragfähig, ein eigenes kleines Mobile-Plugin nach der offiziellen Tauri-Anleitung „Mobile Plugin Development“
  bauen.
- **Ablauf:**
  1. Den Token per `PUT /devices/current/push` melden.
  2. Ein Tipp auf die Benachrichtigung öffnet die App.
  3. Die App synchronisiert und plant neu.
- **Voraussetzungen**, in der Anleitung genau zu beschreiben:
  - Firebase-Projekt (Android, `google-services.json`);
  - Apple Developer Program (APNs-Schlüssel `.p8`).

### 10.6 Bauen und Verteilen

- **Android:** Build unter Linux möglich (Android SDK/NDK). In der Cloud-Umgebung sind Downloads ggf. gesperrt,
  deshalb über GitHub Actions (`ubuntu-latest`).
  - Signierte APK mit eigenem Keystore, Installation per Sideload; Google Play ist optional.
  - Wiederholbare Builds sind Pflicht.
- **iOS:** **macOS + Xcode** nötig (Tauri-Doku), also GitHub Actions `macos-latest` oder ein eigener Mac.
  - Für TestFlight bzw. App Store braucht es das **Apple Developer Program** (99 USD/Jahr).
  - Ohne Programm läuft die App nur über ein kostenloses Apple-Konto direkt aus Xcode und muss alle 7 Tage neu
    signiert werden.
- Der Benutzer bekommt eine Schritt-für-Schritt-Anleitung (`mobile/README.md`, Deutsch).

## 11. Deployment (VPS)

`deploy/compose.yaml`: **caddy** (`caddy:2`, Ports 80/443/443-udp) und **buddy** (Build aus `server/Dockerfile`,
Volume `/data`, Healthcheck). **Kein ntfy mehr**, nur eine Subdomain `buddy.<domain>`.

`deploy/README.md` (Deutsch):
1. VPS und Docker einrichten, Firewall auf 22/80/443.
2. DNS-Eintrag für `buddy.<domain>` anlegen.
3. `.env` ausfüllen.
4. **`docker compose run --rm buddy buddy-server vapid generate`** (legt den Schlüssel in `/data/vapid.pem` ab).
5. `docker compose up -d --build`.
6. `buddy-server user add <name>`.
7. Handy einrichten:
   - PWA öffnen, anmelden, installieren, „Benachrichtigungen aktivieren“, Testbenachrichtigung;
   - oder die native App installieren (siehe `mobile/README.md`).
8. PC verbinden.
9. Backups (inklusive VAPID-Schlüssel – geht er verloren, müssen sich alle PWAs neu anmelden), Updates, Fehlersuche.

## 12. Phasen und Arbeitspakete

| Phase | Inhalt | Ordner (exklusiv) | Abhängig von |
|---|---|---|---|
| **0 Fundament** (Orchestrator) | `buddy-core` (Refactor), `Reminder.updatedAt` + **`timeZone`**, zeitzonenfähige `schedule.rs` mit `chrono-tz`, LWW, clock; Testvektoren **mit mehreren Zonen**; TypeScript-Spiegel `src/lib/sync/`, `clock.ts`, **`zoned.ts`**, `schedule.ts` (Vitest auch mit `TZ=America/New_York`/`Asia/Tokyo`); Vertragstypen; D-Einträge | `crates/`, `src/lib/{sync,clock.ts,zoned.ts,schedule.ts}`, `src/types.ts`, `src-tauri/src/model.rs`, `src-tauri/src/reminders*`, `docs/` | – |
| **A Server-Kern** | Auth (desktop/web/mobile), Sync mit Gerätezeitstempeln und Klemme, `deviceState`, Revisionen, Web-App-Auslieferung mit Cache-Headern/CSP, VAPID-Schlüssel (CLI + Laden) | `server/` (ohne `server/src/push/`, `server/src/reminders/`, Dockerfile) | 0 |
| **B Desktop** | Sync-Client, korrigierte Zeitstempel, `set_reminder(timeZone)`, Rust-Erinnerungen über `chrono-tz`, Popover mit Zone, Einstellungsabschnitt | `src-tauri/src/sync/`, `src-tauri/src/commands/{sync,reminders}.rs`, `src/windows/settings/`, `src/windows/notes/{useNotesStore*,Reminder*}`, `src/lib/api*` | 0 |
| **C1 Web-Daten + Sync** | `src/web/data/`, `src/web/sync/` inkl. Plattform-Adapter (Cookie / Bearer) | `src/web/data/`, `src/web/sync/` | 0 |
| **C2 Web-UI + PWA** | `src/web/ui/`, `src/web/sw.ts` (injectManifest: Precache, push, notificationclick), `src/web/notify/` (Web-Push-Abo, Badge, Aufräumen), Manifest, Icons, Install-Hinweise, Update-Banner, Zonen-Anzeige | `src/web/ui/`, `src/web/notify/`, `src/web/sw.ts`, `src/web/main.tsx`, `web.html`, `vite.web.config.ts`, `public-web/`, `package.json` (Skripte/Deps) | 0 |
| **D Server-Push** | Scheduler, `push_log` pro Gerät, **Web Push** (web-push + reqwest, TTL/Urgency/Topic, 404/410-Aufräumen), `/push/*`, Versandregeln §7.4 inkl. nativer Dedupe-Regel (Kanal FCM/APNs als Trait, Umsetzung in N2) | `server/src/reminders/`, `server/src/push/` | A |
| **E Deployment** | `server/Dockerfile`, `deploy/*` (ohne ntfy), VAPID-Schritt, Anleitung | `deploy/`, `server/Dockerfile` | A |
| **N1 Native Hülle** | `mobile/` (Tauri 2 Android/iOS), `vite.mobile.config.ts`, Bearer-Adapter, sicherer Token-Speicher, **lokale Planung §10.3**, Aktionen, Channels/Erlaubnisse, Prüfung §10.4, CI-Workflows Android (Linux) und iOS (macOS), `mobile/README.md` | `mobile/`, `vite.mobile.config.ts`, `src/web/notify/native*`, `.github/workflows/mobile-*.yml` | C1, C2 |
| **N2 Nativer Push** | Plugin-Auswahl, Token-Registrierung, FCM HTTP v1 / APNs im Server-Kanal, Anleitung Firebase/APNs | `mobile/` (Push-Teil), `server/src/push/native*` | N1, D |
| **F Integration** (Orchestrator) | End-to-End, Abnahme §13, Doku, Version 0.3.0, Installer | alle | A–E, N1 (N2 falls umgesetzt) |
| **G optional** | SSE, Windows-CI mit MSVC, Server-Image nach GHCR, Declarative Web Push (WebKit, iOS ≥ 18.4) prüfen | – | F |

Reihenfolge: 0 → (A ∥ B ∥ C1 ∥ C2) → (D ∥ E ∥ N1) → N2 → F.

## 13. Tests und Abnahme

**Pflicht-Checks:**
- `npm test`, auch mit `TZ=America/New_York` und `TZ=Asia/Tokyo`;
- `npm run build`, `npm run build:web`, `npm run build:mobile`;
- in `src-tauri`, `server`, `crates/buddy-core`: `cargo test` + clippy `-D warnings` + `fmt`;
- Windows-clippy und NSIS-Cross-Build;
- Android-Build in CI, iOS-Build in CI (falls macOS-Runner verfügbar).

**Abnahmeszenarien** (lokal: Server + **Fake-Push-Dienst**, der Web-Push-Anfragen annimmt, mit dem
Gegenschlüssel entschlüsselt, protokolliert und auf Wunsch zurückhält oder mit 410 antwortet; dazu Desktop unter
Xvfb, PWA mit Playwright/Chromium, native Hülle im Android-Emulator in CI):

| Nr. | Szenario | Erwartung |
|---|---|---|
| 1 | Notiz am PC anlegen | nach „Jetzt synchronisieren“ in der PWA sichtbar |
| 2 | Notiz in der PWA ändern | PC-Notizfenster zeigt den neuen Inhalt; ungespeichertes Tippen am PC bleibt |
| 3 | Offline auf zwei Geräten ändern | die neueste Fassung gewinnt überall, die andere steht in `note_revisions` |
| 4 | Am PC löschen | verschwindet in der PWA; eine spätere Bearbeitung bringt die Notiz zurück |
| 5 | Erinnerung am PC setzen, PC beenden | Server sendet zur Zeit **genau einen** Web-Push an jede abonnierte PWA (verschlüsselt, Header TTL/Urgency/Topic korrekt) |
| 6 | „Erledigt“ in der Benachrichtigung (Chromium, Playwright) | Aktion läuft im Service Worker über die Datenschicht, danach Sync; PC ohne Badge, kein Nachfeuern |
| 7 | „10 Min. später“ | neues `at`; der Topic-Header ersetzt eine ältere, noch nicht zugestellte Nachricht; nach 10 min (simulierte Uhr) genau ein neuer Push |
| 8 | Erinnerung in der PWA setzen | PC zeigt den Toast, die PWA bekommt den Push |
| 9 | Falsches Passwort / widerrufenes Gerät | „Abgemeldet – bitte neu verbinden“, kein Datenverlust |
| 10 | Server nicht erreichbar | PC voll benutzbar, die Outbox überlebt den Neustart |
| 11 | Sync aus | Verhalten exakt wie 0.2.0 |
| 12 | Sicherheit | Cross-Site-POST mit Cookie wird abgelehnt; keine Inhalte/Tokens/Endpunkte im Log; Cookie-Attribute stimmen; Login-Bremse greift |
| 13 | Installierbarkeit | Manifest-Pflichtfelder (MDN), Service Worker aktiv, `beforeinstallprompt` (Chromium); Cache-Header von `/sw.js`, `/index.html`, Manifest |
| 14 | Offline-Start | einmal online laden, dann offline neu laden → App und Notizen da |
| 15 | Offline bearbeiten | anlegen/ändern/löschen/Erinnerung offline → App schließen, offline öffnen → alles da → online → automatisch synchronisiert |
| 16a | Handy offline T1, PC T2 > T1, Handy danach online | PC-Fassung gewinnt, Hinweis am Handy, Handy-Fassung `rejected` in Revisionen |
| 16b | PC T1 synchronisiert, Handy offline T2 > T1, Stunden später online | **Handy-Fassung gewinnt**, obwohl sie später ankommt |
| 16c | Handy-Uhr 10 min vor (simuliert) | korrigierte Gerätezeit, Warnung; ohne Messung greift die Klemme |
| 17 | Session abgelaufen, während offline | nach dem Login wird die Outbox gesendet |
| 18 | Update der Web-App | Banner → Aktualisieren ohne Datenverlust |
| 19 | Zwei Tabs | nie zwei Syncs parallel (Web Locks), beide zeigen die Änderungen |
| 20 | Rust = TypeScript | beide bestehen `lww_vectors.json` und `schedule_vectors.json` |
| 21 | **Push bei geschlossener PWA** (Chromium, Service Worker ohne offene Seite) | Benachrichtigung erscheint, Klick öffnet `/notes/<id>` |
| 22 | **Push während die PWA offline ist** (Fake-Push-Dienst hält zurück) | Nach dem Online-Gehen kommt die Benachrichtigung mit „fällig seit …“ |
| 23 | **Abo verloren** (Fake-Dienst antwortet 410) | Server löscht das Abo; beim nächsten Start meldet die PWA sich neu an |
| 24 | **Zeitzonen PC/Handy:** PC `TZ=Europe/Berlin` legt „täglich 09:00“ an; PWA mit Playwright `timezoneId: 'America/New_York'` | PWA zeigt „03:00 (09:00 Berlin)“; der Push kommt zum selben Zeitpunkt wie der PC-Toast; „Erledigt“ in New York ergibt den nächsten Tag **09:00 Berlin**, nicht 09:00 New York |
| 25 | **DST-Zwischenwochen:** Termine zwischen US- und EU-Umstellung (März, Oktober/November) | korrekte Zeitpunkte in beiden Anzeigen, Wiederholung bleibt 09:00 Berlin |
| 26 | **Zone ändern:** Erinnerung auf `Asia/Tokyo` umstellen | neues `at`, alle Geräte übernehmen den Zeitpunkt; Anzeige stimmt überall |
| 27 | **Altdaten** ohne `timeZone` | PC füllt seine Zone, Server nutzt die Kontozone, keine Verschiebung |
| 28 | **Native Hülle offline** (Android-Emulator, Flugmodus nach dem Sync) | lokal geplante Benachrichtigung klingelt pünktlich, auch bei geschlossener App; „Erledigt“ offline → nach Wiederverbindung synchronisiert |
| 29 | **Native Planung aktualisiert** | Verschieben/Erledigen am PC → nach dem Sync ist der alte Plan gelöscht und der neue gesetzt; `scheduledSeq` gemeldet → Server sendet diesem Gerät keinen doppelten Push |
| 30 | **iOS-Zeitpunkt (§10.4)** | 2-min-Plan mit Gerätezone Europe/Berlin und America/New_York klingelt pünktlich (Simulator oder Gerät; sonst Handtest) |

**Handtests nur durch den Benutzer** (`MANUAL_TESTS.md` v3):
- PWA auf Android und iOS installieren und Benachrichtigungen aktivieren;
- Push bei geschlossener App;
- Flugmodus: PWA zeigt die Nachricht nach dem Wiederverbinden, die native App klingelt offline;
- Reise bzw. Zonenwechsel am Handy;
- native App unter Android (APK) und iOS (TestFlight/Xcode);
- Windows-Anmeldeinformationsspeicher, zwei PCs.

## 14. Risiken und noch zu prüfende Punkte

- **PWA ohne Internet:** Klingeln zur fälligen Zeit ist technisch nicht möglich, weil Notification Triggers
  eingestellt sind und es keinen Ersatz-Standard gibt. Die Nachricht kommt nachgeholt (TTL). Zuverlässiges
  Klingeln ohne Netz gibt es nur in der nativen Hülle.
- **iOS-PWA:**
  - Push nur installiert (≥ 16.4);
  - keine Knöpfe, kein `notificationclick`, kein `tag`;
  - Abo-Änderungen werden nicht gemeldet, deshalb Abgleich bei jedem Start;
  - keine unsichtbaren Pushes.
- **Native Hülle:**
  - iOS braucht macOS/Xcode und für dauerhafte Installation das Apple Developer Program;
  - iOS-Grenze 64 geplante Benachrichtigungen;
  - Android: exakte Alarme brauchen eine Erlaubnis, Hersteller-Energiesparmodi können stören (Hinweis in der App);
  - möglicher iOS-Zeitzonenfehler im Plugin (§10.4).
- **Nativer Push (N2):** hängt von einem Community-Plugin oder einem eigenen Plugin ab und braucht Firebase/APNs-Zugänge.
- **Doppelte Benachrichtigungen,** wenn PWA und native App auf demselben Handy aktiv sind: in der Anleitung „entweder
  oder“ empfehlen.
- **Zeitzonen:** In TypeScript gibt es kein `Temporal` in Safari. Deshalb wird die Intl-Umrechnung umfassend gegen
  die gemeinsamen Vektoren getestet; Alternative wäre der offizielle TC39-Polyfill. tzdata-Unterschiede zwischen
  den Plattformen sind unkritisch, weil nur das handelnde Gerät rechnet.
- **Zu verifizieren beim Umsetzen:**
  - aktuelle Versionen: sqlx, web-push, vite-plugin-pwa (Vite 8), idb, Tauri-Plugins;
  - keyring-Stores für Windows/iOS/Android;
  - reqwest-TLS unter MinGW;
  - Android-SDK-Downloads in der Cloud.

## 15. Nicht-Ziele in v3

- Ende-zu-Ende-Verschlüsselung
- CRDT
- App-Store-Veröffentlichung (nur private Verteilung)
- „schwebende“ Erinnerungszeiten (Ortszeit des jeweiligen Geräts)
- mehrere Benutzerkonten
- Sync von Einstellungen, Shortcuts und Skins
- Anhänge
- ntfy
