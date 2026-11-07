# v4 – Konten, Registrierung, Handy-Anmeldung per QR, Standard-Server (Plan)

Stand: 2026-11-07, erste Fassung · Grundlage: Version 0.3.0 (v3) · Status: **geplant**

Dieser Plan ist für v4 so verbindlich wie `docs/PLAN_V3_SYNC.md` für v3. Abweichungen nur mit Begründung in
`docs/DECISIONS.md` (Vorschläge D-85 ff., Abschnitt „v4 (geplant)“). Ausführende Agenten starten mit
`docs/AGENT_PROMPT_V4.md`.

---

## 1. Ziel und Entscheidungen des Benutzers

**Ziel:**
1. Konten werden **in der Desktop-App** angelegt („Konto anlegen“), nicht mehr nur per Server-Kommandozeile.
2. Handys (PWA und native Android/iOS-App) melden sich durch **Scannen eines QR-Codes** an, den die Desktop-App
   zeigt. Server-Adresse, Benutzer und Passwort muss man am Handy nicht mehr abtippen.
3. Standard-Server ist **https://buddy.pev-point.de** (vom Projekt betrieben). Nur wer selbst hostet, trägt eine
   eigene Server-Adresse ein.

| Frage (Multiple-Choice, 2026-11-07) | Entscheidung |
|---|---|
| Wer darf sich auf buddy.pev-point.de registrieren? | **Offen mit Schutz** (Limits pro IP, Proof-of-Work ohne Drittanbieter, Kontingente); per Schalter auf Einladung/geschlossen umstellbar |
| E-Mail-Adresse im Konto | **Keine** – nur Benutzername + Passwort |
| Passwort vergessen | **Wiederherstellungscode** (beim Registrieren) **plus jedes angemeldete Gerät** kann ein neues Passwort setzen; ohne beides ist das Konto verloren |
| Ende-zu-Ende-Verschlüsselung | **Später**; v4 bereitet das Datenmodell vor (Versionsfeld) |
| Bestätigung am PC beim QR-Anmelden | **Nein, Scannen genügt** (Ausgleich siehe §6.2 und §8) |
| Passwort-Login am Handy | **Bleibt als Alternative** (Standard ist QR) |
| Konto löschen | **Sofort**, mit Passwort; Backups rollen nach 14 Tagen heraus |
| Kontingente (öffentlicher Server) | **Moderat:** 50 MB, 5 000 Notizen, 10 Geräte pro Konto; Admin kann einzelne Konten anheben |
| Admin-Werkzeuge | **Nur CLI** |
| Wo registrieren? | **Nur am Desktop**; Handys kommen per QR (oder Passwort) dazu |
| Erst-Start am Desktop | **Einmaliger Hinweis** im Notizfenster; alles Weitere in Einstellungen → „Konto & Handy“ |

Gesetzt bleiben aus v3: Desktop ist **local-first** und ohne Konto voll nutzbar (D-28); LWW mit Gerätezeitstempeln
(D-29, D-41); ein Schreibweg `/sync/push` (D-43); Erinnerungen mit eigener Zeitzone (D-39); Web-Push-Regeln (D-46);
native lokale Planung (D-47).

### 1.1 Kurswechsel gegenüber v3

v3 ging von **einem** Benutzerkonto und privater Verteilung aus; „mehrere Benutzerkonten“ war ein Nicht-Ziel
(`PLAN_V3_SYNC.md` §1 Annahmen, §15). v4 hebt das auf. Folgen, die dieser Plan ausdrücklich behandelt:

| Bereich | v3 | v4 |
|---|---|---|
| Konten | eins, per CLI | beliebig viele, Registrierung am Desktop; CLI bleibt für Admins |
| Server | jeder betreibt seinen eigenen | **öffentlicher Standard-Server** + Selbst-Hosting |
| Missbrauch | kein Thema (privat) | Registrierungsschutz, Kontingente, Sperren (§8) |
| Recht | privat | Impressum, Datenschutzerklärung, Löschung, Export (§11) |
| Datenbank | bereits mandantenfähig (`user_id` überall, `ON DELETE CASCADE`) – **im Code geprüft** | additive Migration `0003_accounts.sql` (§4) |
| Native App | Server fest beim Bauen | Standard beim Bauen, eigener Server zur Laufzeit wählbar (§7.2) |
| Login-Bremse | pro (IP, Benutzer) | zusätzlich IP-weit und für neue Endpunkte (§8) |

Die Annahme „PWA **oder** native App pro Handy“ (doppelte Benachrichtigungen) gilt weiter.

## 2. Faktenbasis

Ehrlich getrennt: was im Code geprüft ist, was aus Quellen abgeleitet ist, was offen bleibt.

**Im Code geprüft (Stand `fd963e2`):**
- `server/migrations/0001_init.sql`: `users.username UNIQUE COLLATE NOCASE`; alle Nutzdaten (`devices`, `sessions`,
  `notes`, `note_revisions`, `reminders`, `note_order`) mit `user_id … ON DELETE CASCADE`; `push_subscriptions`,
  `push_log`, `sessions` hängen per Cascade an `devices`. `db.rs` schaltet `foreign_keys(true)` ein. Ein
  `DELETE FROM users` löscht damit alle Daten eines Kontos.
- Widerrufene Geräte bleiben als Zeile mit `revoked_at` stehen (`api.rs::revoke_device`); es gibt keine Aufräumung.
- Login-Bremse (`auth/throttle.rs`): nur im Speicher, Schlüssel (IP, Benutzername klein), 5 Fehlversuche frei, dann
  30 s verdoppelt bis 15 min. Kein IP-weites Limit über verschiedene Benutzernamen.
- `auth/csrf.rs` + `auth::csrf_guard`: CSRF greift bei Cookie-Anfragen und bei Pfaden, die auf `/session` **enden**.
  Ein neuer Pfad `/session/pairing` würde davon **nicht** erfasst → Regel muss angepasst werden (§6.3).
- `cli.rs::validate_username`: 1–64 Zeichen `A–Z a–z 0–9 . _ - @`; `password.rs`: ≥ 12 Zeichen, ≤ 1024 Bytes,
  Argon2id m=19 MiB t=2 p=1, Dummy-Hash gegen Timing.
- `lib.rs`: `TraceLayer::new_for_http()` protokolliert Anfrage-URIs (Pfad + Query), keine Bodys. → Geheimnisse nie in
  Pfad oder Query.
- FCM (`push/native_fcm.rs`): sendet eine **sichtbare** Benachrichtigung mit Titel/Text → für Google lesbar
  (anders als Web Push, das nach RFC 8291 verschlüsselt ist).
- Desktop: `sync::connect` normalisiert die URL (`client::normalize_server_url`), registriert per `POST /devices`,
  legt das Token im Windows-Anmeldeinformationsspeicher ab; `syncServerUrl` ist geschützt (D-62), Standard `""`.
  CSP des Desktops erlaubt `img-src 'self' data:` (QR als Data-URL möglich). `tauri-plugin-dialog` und
  `tauri-plugin-opener` sind schon eingebunden.
- Native App: `SERVER_ORIGIN = option_env!("BUDDY_SERVER_ORIGIN")` aus `build.rs`; der HTTP-Scope wird in `setup`
  per `app.add_capability(...)` gesetzt. Tauri 2.12.5 bietet `Manager::add_capability` (Feature `dynamic-acl`) –
  jederzeit aufrufbar, **es gibt kein Entfernen**. Der Scope wird bei jedem `fetch` neu geprüft
  (`tauri-plugin-http` 2.8.3, `commands.rs`).
- `createNativeHttp` (`src/web/sync/http.ts`) fängt das Token aus der Antwort von `POST /devices` ab und speichert
  es; für einen neuen Einlöse-Endpunkt muss dieselbe Regel gelten.
- PWA: CSP `connect-src 'self'` (`server/src/web.rs`), App-CSP der Hülle `connect-src ipc: http://ipc.localhost`
  (HTTP läuft über das Plugin in Rust).

**Aus offiziellen Quellen abgeleitet (gelesen am 2026-11-07):**
- `@mdn/browser-compat-data` 8.1.8: `BarcodeDetector` – Chrome Android 83 ✓, WebView Android 83 ✓,
  **Safari iOS nur hinter Flag** („Shape Detection API“), Firefox Android ✗ → nur optional nutzbar.
  `MediaDevices.getUserMedia`: Chrome Android 53, Safari iOS 11 ✓.
- `tauri-plugin-barcode-scanner` **2.5.3** (crates.io, npm `@tauri-apps/plugin-barcode-scanner` 2.5.3; daneben
  3.0.0-alpha, die wir nicht nehmen): Android + iOS; Android-Manifest des Plugins trägt `CAMERA` und
  `uses-feature android.hardware.camera.any` selbst ein; iOS bricht ohne `NSCameraUsageDescription` in der
  Info.plist ab (`BarcodeScannerPlugin.swift` Z. 301–304). Standard-Permission erlaubt `scan`, `cancel`,
  `check/request-permissions`, `open-app-settings`, `vibrate`.
- `qrcode` (Rust) **0.14.1**, MIT/Apache-2.0: QR-Erzeugung mit SVG-Ausgabe.
- `jsqr` **1.4.0**, Apache-2.0: QR-Dekodierung in reinem JavaScript (kein `eval`, kein Worker) – passt zur CSP.
- OWASP Cheat Sheets (Authentication, Forgot Password, Session Management, CSRF, Password Storage) und NIST SP 800-63B:
  keine Kompositionsregeln, Mindestlänge, Abgleich mit häufigen Passwörtern, einheitliche Fehlermeldungen,
  Sitzungen nach Passwortänderung beenden, Rücksetz-Geheimnisse einmalig und zufällig.

**Offen (in den Phasen zu klären, siehe §14):** genaue Info.plist-Einbindung in Tauri-CLI 2 für iOS
(`Info.ios.plist`-Zusammenführung laut tauri-docs), Verhalten von iOS-Home-Bildschirm-Apps bei Cookies aus Safari,
Android-Verhalten „Kamera-App öffnet Link in installierter PWA“, Inhalte der Rechtstexte (liefert der Betreiber).

## 3. Architektur

```
 Windows-PC (Display Buddy)                     buddy-server (axum + SQLite)                Handy
┌───────────────────────────────┐   HTTPS   ┌──────────────────────────────────────┐  ┌────────────────────────┐
│ Einstellungen „Konto & Handy“ │──────────►│ GET  /info (öffentlich)              │  │ PWA (Origin = Server)  │
│  ├ Konto anlegen (PoW in Rust)│           │ POST /accounts/challenge, /accounts  │  │  /pair#c=CODE → Knopf  │
│  ├ Anmelden / Passwort vergessen          │ POST /accounts/recover               │◄─│  POST /session/pairing │
│  ├ Handy verbinden → QR       │──────────►│ POST /pairing, GET/DELETE /pairing/id│  │  oder Code / Kamera    │
│  ├ Geräte, Passwort, Export,  │           │ /me/account, /me/devices, /me/password  ├────────────────────────┤
│  │  Konto löschen             │           │ /me/recovery-code, /me/export,       │  │ Native App             │
│  └ Sync-Status (wie v3)       │           │ /me/delete                           │◄─│  Scanner-Plugin → URL  │
└───────────────────────────────┘           │ /devices, /session (Passwort, wie v3)│  │  POST /devices/pairing │
          QR = https://<origin>/pair#c=<12 Zeichen>  │ /sync/*, /push/* (wie v3, + Kontingente) │  │  Server wählbar (§7.2) │
                                            └──────────────────────────────────────┘  └────────────────────────┘
```

Grundsätze:
- **Ein API, additiv:** Alles bleibt unter `/api/v1`. v3-Clients funktionieren gegen einen v4-Server unverändert
  weiter (Passwort-Login, Sync). `GET /info` meldet `apiLevel: 2` und `features`; ein v4-Client erkennt einen
  v3-Server an `404` auf `/info` und bietet dann nur den Passwort-Login an.
- **Geheimnisse nie in Pfad/Query:** Codes, Passwörter, Tokens nur im JSON-Body bzw. im URL-Fragment des QR-Codes.
- **Der Server kennt nur Hashes** von Tokens, Sitzungen, Pairing-Codes, Einladungscodes und Wiederherstellungscodes.
- **Desktop spricht HTTP nur aus Rust** (D-36); alle neuen Konto-Funktionen sind Commands des Einstellungsfensters.

## 4. Datenmodell und Migration (`server/migrations/0003_accounts.sql`, nur additiv)

```sql
-- users: Registrierung, Wiederherstellung, Sperre, Kontingente, E2E-Vorbereitung
ALTER TABLE users ADD COLUMN created_via         TEXT    NOT NULL DEFAULT 'cli'
      CHECK (created_via IN ('cli', 'register', 'invite'));
ALTER TABLE users ADD COLUMN recovery_hash       TEXT    NULL;     -- SHA-256 (hex) des normalisierten Codes
ALTER TABLE users ADD COLUMN recovery_created_at TEXT    NULL;
ALTER TABLE users ADD COLUMN password_changed_at TEXT    NULL;
ALTER TABLE users ADD COLUMN disabled_at         TEXT    NULL;     -- Admin-Sperre (CLI)
ALTER TABLE users ADD COLUMN quota_bytes         INTEGER NULL;     -- NULL = Server-Standard
ALTER TABLE users ADD COLUMN quota_notes         INTEGER NULL;
ALTER TABLE users ADD COLUMN quota_devices       INTEGER NULL;
ALTER TABLE users ADD COLUMN content_format      INTEGER NOT NULL DEFAULT 1;  -- 1 = Klartext-JSON (E2E später, D-101)

ALTER TABLE devices ADD COLUMN created_via TEXT NOT NULL DEFAULT 'password'
      CHECK (created_via IN ('password', 'register', 'pairing', 'recovery'));

CREATE TABLE pairings (
    id                 TEXT    PRIMARY KEY,                       -- UUID v4
    user_id            INTEGER NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
    created_by         TEXT    NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    code_hash          TEXT    NOT NULL UNIQUE,                   -- SHA-256 (hex) des normalisierten Codes
    created_at         TEXT    NOT NULL,
    expires_at         TEXT    NOT NULL,                          -- created_at + 3 min
    cancelled_at       TEXT    NULL,
    redeemed_at        TEXT    NULL,
    redeemed_device_id TEXT    NULL REFERENCES devices(id) ON DELETE SET NULL
);
CREATE INDEX pairings_user ON pairings(user_id);

CREATE TABLE invites (
    code_hash  TEXT    PRIMARY KEY,                               -- SHA-256 (hex)
    created_at TEXT    NOT NULL,
    expires_at TEXT    NULL,
    used_at    TEXT    NULL,
    used_by    INTEGER NULL REFERENCES users(id) ON DELETE SET NULL,
    label      TEXT    NULL                                       -- Notiz des Admins, z. B. „für Anna“
);
```

- Bestehende Konten bekommen `created_via = 'cli'`, **keinen** Wiederherstellungscode (`recovery_hash NULL`). Die
  Desktop-App zeigt verbundenen v3-Nutzern deshalb einmal „Wiederherstellungscode erzeugen“ (§9.1); die CLI
  `user add` gibt ab v4 einen Code aus.
- `ALTER TABLE … ADD COLUMN` mit `CHECK` und konstantem `DEFAULT` ist in SQLite erlaubt; die Migration wird mit
  einer Kopie einer v3-Datenbank getestet (Abnahme Nr. 19).
- **Aufräumen** (`housekeeping.rs`, täglich): `pairings` älter als 1 Tag löschen; widerrufene Geräte
  (`revoked_at` älter als 30 Tage) löschen (Cascade räumt `push_log`, `sessions`, `push_subscriptions`); benutzte
  oder abgelaufene `invites` nach 90 Tagen löschen.
- **Kontingent-Messung:** `SUM(length(payload))` über `notes` + `reminders` + `note_revisions` des Kontos,
  `COUNT(*)` lebender Notizen, `COUNT(*)` nicht widerrufener Geräte – in der Schreib-Transaktion, ohne Zusatzspalte
  (5 000 Zeilen pro Konto sind für SQLite trivial; bei Bedarf später zwischenspeichern).

## 5. API-Vertrag (Ergänzungen zu PLAN_V3_SYNC §6)

Basis `https://<server>/api/v1`, JSON, Fehler `{error, message}`, jede Antwort `serverTime` + `Cache-Control:
no-store` (wie v3). Die genauen Nachrichten stehen nach Phase 0 verbindlich in `crates/buddy-core/src/sync.rs`
(bzw. neuem Modul `accounts.rs`, re-exportiert) und `src/lib/sync/types.ts`, mit Beispielen in
`crates/buddy-core/tests/fixtures/api_examples.json` (D-63-Regel).

### 5.1 Öffentlich (ohne Anmeldung)

| Methode & Pfad | Body → Antwort | Hinweise |
|---|---|---|
| `GET /info` | → `ServerInfo {serverTime, version, apiLevel: 2, registration: "open"\|"invite"\|"closed", features: string[], passwordMinChars, legal: {imprintUrl?, privacyUrl?, termsUrl?}, operator?}` | `features` ⊆ `["accounts","pairing","recovery","export","quota"]`; Rechtslinks aus der Konfiguration, nur `https://` |
| `POST /accounts/challenge` | `{}` → `RegistrationChallenge {id, challenge, bits, expiresAt}` | `challenge` = 16 Zufallsbytes base64url; 10 min gültig, einmalig; Limit pro IP (§8). `403 registration_closed` bei Modus `closed` |
| `POST /accounts` | `AccountCreate {username, password, deviceName, timeZone?, inviteCode?, challengeId, nonce}` → `AccountAccess {deviceId, token, recoveryCode, serverTime}` | legt Konto **und** Desktop-Gerät (`kind=desktop`, `created_via=register`) in **einer** Transaktion an; `nonce` = u32 (§6.1) |
| `POST /accounts/recover` | `AccountRecover {username, recoveryCode, newPassword, deviceName}` → `AccountAccess` (neuer `recoveryCode`) | widerruft **alle** Geräte und Sitzungen, setzt das Passwort, registriert den aufrufenden PC neu; Bremse wie Login |
| `POST /devices/pairing` | `PairingRedeem {code, deviceName, kind: "mobile"}` → `PairingAccess {deviceId, token, username, serverTime}` | native App; Bearer-Token wie `POST /devices`; kein Cookie, keine CSRF-Prüfung nötig |
| `POST /session/pairing` | `SessionPairing {code, deviceName, deviceId?}` → `SessionResponse` + `Set-Cookie` | PWA; **CSRF-Pflicht** (Login-CSRF, §6.3); `deviceId` wie bei `POST /session` wiederverwendet |

Bestehend und unverändert: `GET /health`, `POST /devices`, `POST /session` (Passwort-Login).

### 5.2 Angemeldet (Bearer oder Cookie)

| Methode & Pfad | Body → Antwort | Wer | Hinweise |
|---|---|---|---|
| `POST /pairing` | `{}` → `PairingStart {pairingId, code, url, expiresAt, serverTime}` | nur `kind=desktop` | `url` = `<public_origin>/pair#c=<code>`; ein neuer Code desselben PCs bricht den alten ab; max. 3 offene pro Konto |
| `GET /pairing/{id}` | → `PairingStatus {pairingId, state: "pending"\|"redeemed"\|"expired"\|"cancelled", expiresAt, device?: {id, name, kind}, redeemedAt?}` | erzeugendes Gerät | Desktop fragt alle 2 s |
| `DELETE /pairing/{id}` | → 204 | erzeugendes Gerät | Abbrechen |
| `GET /me/account` | → `AccountInfo {username, createdAt, timeZone, contentFormat, usage: {bytes, notes, devices}, quota: {bytes?, notes?, devices?}, recoveryCodeCreatedAt?, serverTime}` | alle | `quota.*` = `null` heißt unbegrenzt |
| `GET /me/devices` | → `DeviceList {devices: DeviceInfo[], serverTime}` | alle | `DeviceInfo {id, kind, name, createdAt, lastSeenAt?, createdVia, current, push}`; nur nicht widerrufene |
| `POST /me/devices/{id}/revoke` | `{password?}` → 204 | alle | ohne Passwort nur **das eigene oder ein jüngeres** Gerät (D-91); sonst `403 password_required` |
| `PUT /me/password` | `PasswordChange {currentPassword?, newPassword, signOutOthers}` → 204 | alle | ohne `currentPassword` nur `desktop`/`mobile`, Gerät ≥ 24 h alt, `signOutOthers` erzwungen (D-89) |
| `POST /me/recovery-code` | `{password}` → `{recoveryCode}` | alle | alter Code wird ungültig |
| `GET /me/export` | → `AccountExport` (JSON, `Content-Disposition: attachment`) | alle | höchstens 1×/min pro Konto |
| `POST /me/delete` | `AccountDelete {password, confirmUsername}` → 204 (+ Cookie löschen) | alle | sofort, Cascade (D-92) |

**Geänderte Regeln bestehender Endpunkte:**
- `POST /devices`, `POST /session`, `POST /devices/pairing`, `POST /session/pairing`: `409 device_limit`, wenn das
  Konto schon `quota_devices` aktive Geräte hat (Wiederverwendung eines Web-Geräts zählt nicht neu).
- `POST /sync/push`: `413 quota_exceeded`, wenn das Paket die Belegung **erhöht** und danach über dem Kontingent
  liegt. Dann wird **nichts** angewendet (Transaktion zurück). Pakete, die die Belegung nicht erhöhen (Löschen,
  Kürzen), gehen immer durch. v3-Clients behalten bei einem Fehler ihre Outbox – kein Datenverlust (D-94).
- Alle angemeldeten Anfragen eines gesperrten Kontos: `403 account_disabled`; Login ebenfalls.

### 5.3 Neue Fehler-Codes (`error_codes` / `ERROR_CODES`)

`username_taken` (409), `username_invalid` (400), `password_weak` (400), `registration_closed` (403),
`invite_required` (403), `invite_invalid` (403), `challenge_invalid` (400), `pairing_invalid` (400 – unbekannt,
abgelaufen, abgebrochen oder schon benutzt; bewusst **ein** Code), `password_required` (403), `account_disabled`
(403), `quota_exceeded` (413), `device_limit` (409), `content_format_unsupported` (409, Client kennt das Format des
Kontos nicht). Bestehend: `unauthorized`, `forbidden`, `bad_request`, `not_found`, `too_many_requests`,
`full_resync_required`, `internal`.

### 5.4 Exportformat

```jsonc
{ "format": "display-buddy-export/1", "exportedAt": "…Z",
  "account": { "username": "anna", "createdAt": "…", "timeZone": "Europe/Berlin", "contentFormat": 1 },
  "devices": [ /* DeviceInfo ohne current */ ],
  "notes": [ /* NoteRecord, nur lebende */ ], "reminders": [ /* ReminderRecord, nur lebende */ ],
  "order": { /* OrderRecord */ }, "revisions": [ { "noteId": "…", "reason": "replaced", "storedAt": "…", "note": { } } ] }
```

Keine Hashes, keine Tokens, keine Push-Endpunkte im Export.

## 6. Abläufe

### 6.1 Registrierung (nur Desktop)

1. Einstellungen → „Konto & Handy“ → **Konto anlegen**. Die App lädt `GET /info` vom gewählten Server
   (Standard: buddy.pev-point.de). Bei `registration = "closed"` erscheint „Auf diesem Server kann man sich nicht
   selbst registrieren.“; bei `"invite"` ein zusätzliches Feld „Einladungscode“; `404` → „Dieser Server ist zu alt
   für die Registrierung (Display-Buddy-Server ab v4 nötig).“
2. Eingaben: Benutzername, Passwort, Passwort wiederholen, Gerätename (Standard „Windows-PC“). Prüfung lokal mit
   denselben Regeln wie der Server (§8.1), Fehlertexte §10.
3. Rust (`sync/account.rs`): `POST /accounts/challenge` → Nonce suchen, bis
   `SHA-256(challenge_bytes ‖ nonce_u32_le)` mindestens `bits` führende Null-Bits hat (Funktion
   `buddy_core::pow::solve`, im Hintergrund-Thread, Abbruch nach 60 s) → `POST /accounts` mit `timeZone` = Zone
   des PCs (`iana-time-zone`).
4. Server prüft in dieser Reihenfolge: Modus → IP-Limit → Challenge (gültig, unbenutzt, Lösung korrekt;
   danach verbraucht) → Einladung (bei `invite`) → Benutzername (Regeln, reserviert, frei) → Passwort (Regeln,
   Liste) → globales Tageslimit. Dann in **einer** Transaktion: `users` (+ `recovery_hash`), `devices`
   (`desktop`, `register`), ggf. `invites.used_*`.
5. Antwort mit Token + Wiederherstellungscode. Der PC verhält sich danach wie nach `sync_connect` (Token im
   Anmeldeinformationsspeicher, Erstabgleich, Sync an).
6. **Dialog „Wiederherstellungscode“** (Pflicht-Schritt): Code groß, „Kopieren“, Hinweis, Kästchen
   „Ich habe den Code sicher aufbewahrt.“ → erst dann „Weiter“. Danach Vorschlag „Jetzt Handy verbinden“.

### 6.2 Handy per QR anmelden (Pairing)

**Code:** 12 Zeichen Crockford-Base32 (Alphabet `0123456789ABCDEFGHJKMNPQRSTVWXYZ`, 60 Bit Zufall), angezeigt als
`ABCD-EFGH-JKMN`. Normalisierung (Rust `buddy_core::pairing`, TS `src/lib/pairing.ts`, gemeinsame Testvektoren
`pairing_vectors.json`): Großbuchstaben, Leerzeichen/Bindestriche weg, `O→0`, `I/L→1`, dann genau 12 Zeichen aus
dem Alphabet. Gespeichert wird nur SHA-256 der normalisierten Form. **QR-Inhalt:** `https://<origin>/pair#c=<CODE>`
(Fragment: landet nie in Server- oder Proxy-Logs, Platz für einen späteren E2E-Schlüssel, D-101).

**Am PC:**
1. „Handy verbinden“ (nur sichtbar, wenn verbunden). Rust: `POST /pairing` → QR als SVG (`qrcode` 0.14.1, Fehlerkorrektur M)
   → Anzeige als `data:image/svg+xml`-Bild **erst nach dem Klick**, mit Countdown 3:00, Code als Text darunter und
   der Anleitung (§10).
2. Rust fragt alle 2 s `GET /pairing/{id}`. Bei `redeemed`: QR verschwindet, Meldung „✓ ‚Pixel 8‘ ist jetzt
   angemeldet.“ mit Knopf **„Das war ich nicht – abmelden“** (widerruft sofort; Regel „jüngeres Gerät“ erlaubt das
   ohne Passwort). Bei `expired`: „Code abgelaufen“ + „Neuen Code“. Schließen des Bereichs/Fensters →
   `DELETE /pairing/{id}`.

**Native App (Android/iOS):**
1. Anmeldeseite: **„QR-Code scannen“** (Standard), darunter „Code eingeben“ und „Mit Passwort anmelden“.
2. Scannen über `@tauri-apps/plugin-barcode-scanner` (`requestPermissions` → `scan({formats: [QRCode]})`).
   Ergebnis mit `parsePairingUrl` prüfen: `https://`, Pfad `/pair`, Fragment `c=` mit gültigem Code. Alles andere:
   „Das ist kein Display-Buddy-Anmeldecode.“
3. **Origin-Prüfung:** gleich der eingestellten Origin → weiter. **Andere Origin** → Bestätigungsdialog (§10,
   Origin groß anzeigen, Standard-Knopf ist „Abbrechen“). Bei Zustimmung: `server_set(origin)` (nur abgemeldet
   möglich), Code in `sessionStorage` merken, App lädt neu und löst den Code nach dem Start ein (Code gilt 3 min).
4. `POST /devices/pairing` → Token (der HTTP-Adapter speichert es selbst, wie bei `POST /devices`) → `GET /me` →
   Erst-Sync → Erlaubnis für Benachrichtigungen (D-81).

**PWA:**
1. **Weg A – System-Kamera** (Android Chrome, iOS Kamera-App): öffnet `https://<server>/pair#c=…` im Browser.
   Die Seite `/pair` liest das Fragment, entfernt es sofort (`history.replaceState`) und löst **nie automatisch**
   ein (Link-Vorschauen, Prefetch). Sie zeigt den Server, den Gerätenamen und den Knopf „Hier anmelden“
   → `POST /session/pairing`. Zusätzlich steht dort der Code als Text mit dem Hinweis „Nutzt du die
   Display-Buddy-App oder die installierte Web-App? Dann dort ‚Code eingeben‘ wählen.“ – nötig, weil die iOS-Kamera
   immer Safari öffnet, nicht die Home-Bildschirm-App.
2. **Weg B – In der App scannen:** auf der Anmeldeseite „QR-Code scannen“, wenn `getUserMedia` verfügbar ist;
   Dekodierung mit `BarcodeDetector`, falls vorhanden, sonst `jsqr` (eigener, nachgeladener Chunk).
3. **Weg C – Code eingeben:** Feld mit Format-Hilfe `XXXX-XXXX-XXXX`.
4. Bereits angemeldet: `/pair` zeigt „Du bist schon als ‚anna‘ angemeldet.“ und bietet nichts weiter an.

**Passwort-Login** bleibt in PWA und nativer App unter „Mit Passwort anmelden“ (Benutzerentscheidung); die native
App zeigt dort den Server und „Server ändern“.

### 6.3 CSRF und Pairing

`auth::csrf_guard` prüft künftig alle Pfade, die mit `/api/v1/session` **beginnen** (also `/session` und
`/session/pairing`), plus jede Cookie-Anfrage (wie bisher). `/devices/pairing` setzt kein Cookie und ist wie
`POST /devices` ausgenommen. Test: Cross-Site-`POST /session/pairing` → 403 (Login-CSRF, OWASP).

### 6.4 Passwort vergessen

- **Am PC mit Wiederherstellungscode:** Anmeldeformular → „Passwort vergessen?“ → Benutzername, Code, neues
  Passwort ×2, Gerätename → `POST /accounts/recover`. Ergebnis: alle anderen Geräte und Web-Sitzungen sind
  abgemeldet, der PC ist verbunden, **neuer** Code wird angezeigt (Pflicht-Dialog wie §6.1).
- **Auf einem angemeldeten Gerät** (PC oder native App, Gerät ≥ 24 h alt): „Passwort ändern“ → „Ich kenne mein
  aktuelles Passwort nicht“ → neues Passwort ×2 → `PUT /me/password` ohne `currentPassword`. Alle anderen Geräte
  und Sitzungen werden abgemeldet. Der Wiederherstellungscode bleibt gültig (er ist der Vertrauensanker gegen ein
  gestohlenes Gerät, D-89).
- Ohne Code und ohne angemeldetes Gerät: Konto verloren (so in der App gesagt). Der Admin kann per CLI
  `user recovery <name>` einen neuen Code erzeugen – nur nach eigener Identitätsprüfung außerhalb der App; für den
  öffentlichen Dienst ist das **nicht** zugesagt (Datenschutzerklärung).

### 6.5 Server-Wahl

**Desktop:**
- `DEFAULT_SYNC_SERVER_URL = "https://buddy.pev-point.de"` (Konstante in `src/types.ts` **und** `model.rs`,
  Vertragstest prüft Gleichheit). `syncServerUrl = ""` bedeutet „Standard-Server“.
- Formular: Zeile „Server: buddy.pev-point.de“ + Link **„Eigenen Server verwenden …“** → Feld „Server-Adresse“
  (Regeln wie v3: `https://`, `http://` nur localhost). „Standard-Server verwenden“ setzt zurück.
- **Migration:** Eine v3-Installation mit gesetztem `syncServerUrl` (nur durch ein früheres Verbinden möglich, D-62)
  behält ihn und bleibt verbunden; die Oberfläche zeigt „Eigener Server: …“. Nicht verbundene, leere Installationen
  zeigen den Standard-Server. Es werden keine Einstellungen umgeschrieben.

**Native App:**
- `BUDDY_PUBLIC_URL` beim Bauen ist der **Standard**; ohne Variable: `https://buddy.pev-point.de` (statt „kein
  Server“). Validierung unverändert (`server_url::normalize`).
- Laufzeit: Commands `server_get` → `{origin, defaultOrigin, isDefault}` und `server_set(origin | null)`
  (null = Standard). `server_set` nur, wenn **kein Token** gespeichert ist (sonst Fehler `signed_in`), nur
  `https://` (bzw. `http://` für localhost/10.0.2.2 wie bisher), speichert in `app_config_dir/server.json` und ruft
  `app.add_capability(http_capability(origin))`. Beim Start wird genau **eine** Capability für die gespeicherte bzw.
  Standard-Origin gesetzt. Weil Tauri Capabilities nicht entfernen kann, bleibt eine vorher erlaubte Origin bis zum
  nächsten App-Start im Scope; die App lädt nach `server_set` ohnehin neu (D-97).
- Oberfläche: Anmeldeseite zeigt „Server: buddy.pev-point.de · ändern“. Ändern → Eingabe → Bestätigung (§10).

**PWA:** spricht immer nur mit ihrer eigenen Origin (CSP `connect-src 'self'` bleibt, D-98). Selbst-Hoster nutzen die
PWA ihres Servers; der QR-Code ihres Desktops zeigt auf ihren Server.

### 6.6 Konto löschen, Export

- Desktop „Konto löschen …“: Hinweis + „Vorher Daten exportieren“ (Knopf), Passwort, Benutzername zur Bestätigung →
  `POST /me/delete` → Sync aus, Token gelöscht, **lokale Notizen bleiben auf dem PC** (Text sagt das).
- PWA/native App: „Konto löschen …“ in den Einstellungen (gleiche Felder); danach wie Abmelden (lokale DB löschen).
- Export am PC: `GET /me/export` → Speichern-Dialog (`tauri-plugin-dialog`, Rust-seitig) mit Vorschlag
  `display-buddy-export-<name>-<JJJJ-MM-TT>.json`.

## 7. Clients im Detail

### 7.1 Desktop (`src-tauri/`, `src/windows/settings/`, `src/windows/notes/`)

**Neue Commands** (4-Stellen-Regel HANDOFF §5.7, alle nur im Einstellungsfenster, `capabilities/settings.json`):

| Command | Argumente (JS camelCase) | Ergebnis |
|---|---|---|
| `account_server_info` | `serverUrl` (`""` = Standard) | `ServerInfo` |
| `account_register` | `serverUrl, username, password, deviceName, inviteCode?` | `AccountRegistered {status: SyncStatus, recoveryCode}` |
| `account_recover` | `serverUrl, username, recoveryCode, newPassword, deviceName` | `AccountRegistered` |
| `account_info` | – | `AccountInfo` |
| `account_devices` | – | `DeviceInfo[]` |
| `account_revoke_device` | `deviceId, password?` | `DeviceInfo[]` |
| `account_change_password` | `currentPassword?, newPassword` | – |
| `account_new_recovery_code` | `password` | `string` |
| `account_export` | – | Pfad oder `null` (abgebrochen) |
| `account_delete` | `password, confirmUsername` | `SyncStatus` (off) |
| `account_open_link` | `kind: "imprint" \| "privacy" \| "terms"` | – (öffnet die URL aus `ServerInfo`, nur `https`) |
| `pairing_start` | – | `PairingInfo {pairingId, code, qrSvg, expiresAt}` |
| `pairing_status` | `pairingId` | `PairingStatus` |
| `pairing_cancel` | `pairingId` | – |

Geändert: `open_settings` bekommt `section?` (`"account"`), damit der Hinweis im Notizfenster direkt dorthin führt.
Die Notizfenster-Capability hat heute nur `allow-save-settings`, **nicht** `allow-open-settings` (geprüft) → in
`capabilities/notes.json` ergänzen (Least-Privilege-Test: wird dann genutzt). `sync_connect` akzeptiert
`serverUrl = ""` (Standard-Server).

**Settings-Felder** (types.ts + model.rs + Vertragstest): `accountHintDismissed: boolean` (Standard `false`).

**Fehler-Codes der Commands:** Präfix wie v3 (`code: detail`), neu: `username_taken`, `username_invalid`,
`password_weak`, `registration_closed`, `invite_required`, `invite_invalid`, `server_too_old`, `pow_timeout`,
`quota_exceeded`, `device_limit`, `password_required`, `account_disabled`, `pairing_invalid`.

**Oberfläche** – Abschnitt **„Konto & Handy“** ersetzt „Synchronisation“ (`AccountSection.tsx`, die bestehenden
Funktionen aus `SyncSection.tsx` – Status, Uhr-Warnung, „Jetzt synchronisieren“, Trennen – wandern hinein):
- *Nicht verbunden:* Server-Zeile, Umschalter **„Konto anlegen“ / „Anmelden“**, Formular, Rechtslinks
  („Datenschutz“, „Impressum“ aus `/info`), „Passwort vergessen?“.
- *Verbunden:* Status (wie v3), **„Handy verbinden“** (QR-Bereich §6.2), **Geräte** (Liste mit Typ-Symbol,
  „zuletzt aktiv“, „Dieses Gerät“, „Abmelden“), **Konto** (Name, Speicher „12 MB von 50 MB“ als Balken,
  „Passwort ändern“, „Neuer Wiederherstellungscode“, „Daten exportieren“, „Konto löschen …“), „Trennen (nur dieser
  PC)“. Bei Konten ohne Code (v3-Bestand): Hinweisbox „Für dieses Konto gibt es noch keinen
  Wiederherstellungscode.“ + Knopf.
- **Hinweis im Notizfenster** (`AccountHint.tsx`): wenn `!syncEnabled && !accountHintDismissed`, eine kleine
  Karte oberhalb der Shortcut-Leiste: „Notizen auch aufs Handy? Lege ein kostenloses Konto an.“ –
  „Konto anlegen“ (öffnet Einstellungen, Abschnitt Konto), „Später“ (bis zum nächsten Start), „Nicht mehr
  zeigen“ (setzt `accountHintDismissed`). Nur `transform`/`opacity`, `prefers-reduced-motion`.

**Rust-Struktur:** `src-tauri/src/sync/account.rs` (Info, Challenge + PoW über `buddy_core::pow`, Register,
Recover, Konto-Endpunkte), `src-tauri/src/sync/pairing.rs` (Start, Status, Cancel, QR-SVG). Netzwerk nie unter Lock
(Lektion v3). `buddy-core` bekommt `sha2` für PoW (bereits transitive Abhängigkeit, MinGW-tauglich).

### 7.2 Native App (`mobile/`)

- `mobile/src-tauri`: Plugin `tauri-plugin-barcode-scanner = "=2.5.3"`, Permission `barcode-scanner:default` in
  `capabilities/main.json`; Commands `server_get`, `server_set` (build.rs `COMMANDS`, Capability, Tests); Speicher
  `server.json`; Standard-Origin-Fallback in `build.rs`/`lib.rs`; `shell_config.serverUrl` = wirksame Origin.
- iOS: `NSCameraUsageDescription` = „Display Buddy nutzt die Kamera nur, um den Anmelde-QR-Code von deinem PC zu
  scannen.“ – Einbindung über die von Tauri 2 vorgesehene Info.plist-Ergänzung (laut tauri-docs `Info.ios.plist`
  im `src-tauri`-Ordner; in Phase N am Simulator-Build prüfen, `gen/apple` wird in CI erzeugt, D-79).
- Android: `CAMERA` kommt aus dem Plugin-Manifest. `uses-feature camera.any` ohne `required="false"` → Geräte ohne
  Kamera könnten die App aus einem Store nicht installieren; für Sideload egal. Phase N ergänzt per
  `update_android_manifest` `android:required="false"`, falls es ohne Konflikt mit dem Plugin-Manifest geht
  (Manifest-Merger prüfen).
- `mobile/src/main.tsx`: Scanner-Adapter (`QrScanner`) und Server-Wahl (`ServerSelector`) an die Oberfläche geben;
  nach `server_set` neu laden; ausstehenden Code nach dem Neustart einlösen.
- `mobile/README.md`: Abschnitt „Server-Adresse“ neu (Standard + eigener Server), Kamera-Erlaubnis.

### 7.3 PWA und gemeinsame Oberfläche (`src/web/`)

- `contract.ts` (Phase 0): `SyncEngine.loginWithCode(code, deviceName)`, `SyncEngine.serverInfo()`,
  `SyncEngine.deleteAccount(password, confirmUsername)`; Schnittstellen `QrScanner {isAvailable(), scan(),
  cancel()}` und `ServerSelector {current(), set(origin|null)}` (nur native App).
- `src/web/sync/`: `loginWithCode` → web: `POST /session/pairing`, nativ: `POST /devices/pairing` (HTTP-Adapter
  speichert das Token auch hier) → danach `GET /me` wie beim Passwort-Login; `account_mismatch`-Regel (D-71) gilt.
  Neuer Fehler `content_format_unsupported`, wenn `GET /me/account` ein unbekanntes `contentFormat` meldet → Sync
  stoppt, Hinweis „Bitte Display Buddy aktualisieren“.
- `src/web/pairing/`: `parse.ts` (nutzt `src/lib/pairing.ts`), `web-scanner.ts` (getUserMedia, Rückkamera,
  BarcodeDetector oder jsQR, Kamera beim Verlassen sicher stoppen).
- `src/web/ui/`: `LoginPage` mit drei Wegen (QR / Code / Passwort), `PairPage` (`/pair`), Konto-Bereich in
  `/settings` („Angemeldet als …“, Server, „Konto löschen …“, Rechtslinks), Server-Zeile + Dialog nur, wenn ein
  `ServerSelector` übergeben ist.

### 7.4 Server (`server/`)

- `config.rs`: neue Variablen (§11.2), Validierung (Rechtslinks nur `https://`).
- `accounts/` (neu): Registrierung, Challenge-Speicher (im Speicher, max. 10 000 offene, je 10 min), Wiederherstellung,
  `/me/*`, Export, Löschen, Kontingente; `auth/`: Sperre (`disabled_at`) im Extraktor, Limiter verallgemeinert
  (`auth/limits.rs`, §8.2), CSRF-Pfadregel (§6.3, Phase 0).
- `pairing/` (neu): `/pairing*`, `/devices/pairing`, `/session/pairing`.
- `sync.rs`: Kontingent-Prüfung in der Push-Transaktion (§5.2).
- `push/native_fcm.rs`: `BUDDY_FCM_PAYLOAD=minimal|full` (Standard `full` für Selbst-Hoster wie bisher; pev-point:
  `minimal` → Titel „Erinnerung fällig“, Text „Tippen zum Öffnen“, D-102).
- `cli.rs`: `user list|show|disable|enable|delete|quota|recovery`, `invite create|list|revoke`; `user add` gibt
  einen Wiederherstellungscode aus.
- `housekeeping.rs`: Aufräumen §4.

## 8. Sicherheitsanalyse

### 8.1 Regeln für Benutzername und Passwort

- **Benutzername (neu registriert):** `^[a-z0-9][a-z0-9._-]{2,31}$` nach Kleinschreibung; eindeutig ohne
  Groß/Klein (Spalte ist `NOCASE`); reserviert: `admin, administrator, root, system, support, help, info, buddy,
  displaybuddy, server, server-restore, api, www, mail, security, abuse, postmaster, hostmaster, webmaster,
  noreply, null, undefined, test`. Keine `@` (keine Verwechslung mit E-Mail). Bestehende CLI-Namen bleiben gültig.
- **Passwort:** 12–1024 Bytes/Zeichen wie v3; **keine** Kompositionsregeln; abgelehnt, wenn gleich dem
  Benutzernamen (ohne Groß/Klein) oder in einer mitgelieferten Liste häufiger Passwörter (z. B. die 10 000 häufigsten
  aus SecLists, MIT; Quelle und Lizenz in Phase A dokumentieren, `include_str!`, Vergleich ohne Groß/Klein). Kein
  Abgleich mit Online-Diensten (Datenschutz, kein Drittanbieter).
- **Wiederherstellungscode:** 24 Zeichen Crockford-Base32 (120 Bit), Anzeige in 6 Vierergruppen; nur SHA-256
  gespeichert (hohe Entropie, kein Argon2 nötig – wie Tokens); einmalig.

### 8.2 Limits (alle im Speicher, wie die v3-Bremse; Werte per Umgebung änderbar)

| Was | Schlüssel | Grenze (Standard) |
|---|---|---|
| Login, Wiederherstellung, Passwort bestätigen | (IP, Benutzer) | wie D-67: 5 frei, dann 30 s … 15 min |
| Fehlversuche über alle Benutzernamen | IP | 30 pro Stunde → 15 min Sperre |
| Registrierungs-Challenges | IP | 10 pro Stunde |
| Registrierungen | IP | 3 pro Stunde, 10 pro Tag |
| Registrierungen | global | 200 pro Tag (`BUDDY_REGISTRATION_DAILY_LIMIT`) |
| Pairing einlösen (Fehlversuche) | IP | 10 pro 10 min → 15 min Sperre |
| Pairing erzeugen | Konto | 20 pro Stunde, max. 3 offen |
| Export | Konto | 1 pro Minute |

Alle Sperren antworten `429` mit `Retry-After`; die IP kommt wie bisher nur über `BUDDY_TRUSTED_PROXIES` aus
`X-Forwarded-For` (D-67).

### 8.3 Bedrohung → Gegenmaßnahme

| Nr. | Bedrohung | Gegenmaßnahme |
|---|---|---|
| S1 | Massenregistrierung durch Bots | Proof-of-Work (22 Bit Standard, ~4 Mio. SHA-256 ≈ 0,3 s am PC; Bremse, keine Mauer), IP- und Tageslimits, Kontingente, Admin-Schalter `invite`/`closed`, CLI `user disable/delete` |
| S2 | Herausfinden, ob ein Benutzername existiert | Registrierung muss „vergeben“ melden (unvermeidbar, OWASP) → nur hinter PoW + Limit; Login/Wiederherstellung: einheitliche Meldung, Dummy-Hash (v3) |
| S3 | Passwort-Raten, Credential Stuffing | Bremse (IP, Benutzer) + neue IP-weite Bremse; Argon2id; Liste häufiger Passwörter |
| S4 | Abfotografierter QR-Code | 3 min gültig, einmalig, QR erst auf Klick, verschwindet nach Einlösen; PC zeigt sofort **welches** Gerät angemeldet wurde, Knopf „Das war ich nicht – abmelden“; Geräteliste; Benutzer hat auf eine zusätzliche Bestätigung bewusst verzichtet (Restrisiko: wer den Code in den 3 min vor dem Besitzer einlöst, ist drin, bis er abgemeldet wird) |
| S5 | Wiederholtes Einlösen (Replay) | `UPDATE pairings SET redeemed_at … WHERE code_hash=? AND redeemed_at IS NULL AND cancelled_at IS NULL AND expires_at > now` in der Geräte-Transaktion; nur bei genau 1 Zeile weiter |
| S6 | Code erraten | 60 Bit Zufall bei 3 min Gültigkeit und 10 Fehlversuchen/10 min pro IP: selbst 10⁵ Versuche/s weltweit ergäben ~2·10⁻¹¹ Trefferchance pro offenem Code |
| S7 | Code in Logs/Referer | Code nur im URL-Fragment und im POST-Body; `Referrer-Policy: no-referrer` (v3); keine Bodys im Log; Desktop protokolliert den Code nicht |
| S8 | Phishing-Server im QR | Native App: fremde Origin nur nach Bestätigungsdialog, nur abgemeldet, nur `https`, Scope nur `/api/v1/*`; PWA: Browser zeigt die Domain, `/pair` nennt den Server und löst nie automatisch ein |
| S9 | Login-CSRF über `/session/pairing` | CSRF-Regel auf Präfix `/session` (§6.3), `X-Buddy-Request` Pflicht |
| S10 | Gestohlenes/übernommenes Gerät übernimmt das Konto | Passwort ohne altes Passwort nur von desktop/mobile ≥ 24 h; Wiederherstellungscode bleibt Anker und nur mit Passwort neu erzeugbar; `recover` meldet alle anderen ab; Konto löschen und ältere Geräte abmelden nur mit Passwort |
| S11 | „Abmelde-Krieg“ zwischen Angreifer- und Besitzergerät | Regel „nur eigenes oder jüngeres Gerät ohne Passwort“ (D-91): der PC, der den Code erzeugt hat, ist immer älter als das so gekoppelte Gerät |
| S12 | Wiederherstellungscode erraten | 120 Bit + Bremse (IP, Benutzer) |
| S13 | Speicher-/Kosten-Missbrauch | Kontingente (Netto-Regel), Body-Limits (v3), Geräte-Limit |
| S14 | Speicher-Erschöpfung durch offene Challenges | max. 10 000 im Speicher, älteste fliegen raus, IP-Limit |
| S15 | Upgrade öffnet private Server ungewollt | `BUDDY_REGISTRATION` Standard **`closed`**; nur die pev-point-Konfiguration setzt `open` |
| S16 | XSS im Webview der nativen App | strenge CSP (v3); Restrisiko ehrlich: Skript im Webview könnte `server_set` aufrufen – aber nur abgemeldet und erst nach Neustart wirksam; es könnte ohnehin schon `token_get` aufrufen |
| S17 | Betreiber liest Notizen | ohne E2E technisch möglich → Datenschutzerklärung sagt es offen; Logs ohne Inhalte (v3); E2E als v5-Option (D-101) |
| S18 | Push-Dienste lesen Inhalte | Web Push ist Ende-zu-Ende zum Browser verschlüsselt (RFC 8291); FCM nicht → auf pev-point `BUDDY_FCM_PAYLOAD=minimal` |
| S19 | Gesperrtes Konto benutzt alte Tokens | Extraktor prüft `users.disabled_at` bei jeder Anfrage → 403 |
| S20 | Gelöschtes Konto, Daten in Backups | Backups rotieren nach 14 Tagen (v3); steht in der Datenschutzerklärung; kein Wiederherstellen einzelner gelöschter Konten aus Backups (CLI-Hinweis) |

## 9. Kompatibilität und Migration

### 9.1 Matrix

| Client ↓ / Server → | v3-Server | v4-Server |
|---|---|---|
| v3-Desktop / v3-PWA / v3-App | wie bisher | wie bisher (Passwort-Login, Sync); Kontingent-Fehler erscheinen als allgemeiner Sync-Fehler, Outbox bleibt |
| v4-Desktop | Passwort-Login + Sync; „Konto anlegen“/„Handy verbinden“ zeigen „Server zu alt“ | voll |
| v4-PWA | – (PWA kommt immer vom eigenen Server) | voll |
| v4-App | Passwort-Login; QR scheitert mit „Server zu alt“ (404) | voll |

### 9.2 Bestehende Installationen

- **Server-Upgrade v3 → v4:** Migration 0003 läuft beim Start; Registrierung bleibt aus (`closed`), bestehende Konten
  und Geräte funktionieren weiter. Admin kann `buddy-server user recovery <name>` ausgeben lassen oder der Nutzer
  erzeugt den Code am Desktop.
- **Desktop-Upgrade 0.3 → 0.4:** verbunden bleibt verbunden (auch mit eigenem Server); Hinweiskarte erscheint nur,
  wenn nicht verbunden. Kein Umschreiben von `settings.json`.
- **Native App:** Ein Update installiert Android nur über eine APK mit **demselben Signierschlüssel** – also baut
  derselbe Ersteller v3 und v4, normalerweise mit derselben `BUDDY_PUBLIC_URL`. Dann bleibt alles angemeldet
  (Token im Schlüsselspeicher, Daten in IndexedDB, wirksame Origin = eingebaute Origin, keine `server.json` nötig).
  Schutz gegen einen Build ohne bzw. mit anderer Variable: Beim Start vergleicht die App `meta.account.serverUrl`
  (legt v3 schon in IndexedDB ab) mit der wirksamen Origin. Weichen sie bei vorhandenem Token ab, synchronisiert sie
  **nicht** und zeigt: „Diese App-Version ist für einen anderen Server eingerichtet (…). Melde dich ab und neu an.“
  Kein stilles Umschalten, kein Datenverlust (Outbox bleibt). Abnahme Nr. 21.
- **Eigener v3-Server des Benutzers → buddy.pev-point.de:** siehe offene Punkte §14 (Domainwechsel = neue
  PWA-Origin, Geräte neu verbinden; Daten bleiben in derselben DB).

## 10. UI-Texte (Deutsch, verbindlich als Ausgangspunkt)

**Desktop – Abschnitt „Konto & Handy“**
- Überschrift: „Konto & Handy“
- Einleitung (nicht verbunden): „Mit einem Konto siehst du deine Notizen und Erinnerungen auch auf dem Handy.
  Display Buddy funktioniert auch ohne Konto.“
- Server: „Server: buddy.pev-point.de“ · „Eigenen Server verwenden …“ · „Standard-Server verwenden“
- Umschalter: „Konto anlegen“ / „Anmelden“
- Felder: „Benutzername“, „Passwort“, „Passwort wiederholen“, „Gerätename“, „Einladungscode“
- Hilfen: „3–32 Zeichen: Kleinbuchstaben, Ziffern, Punkt, Unterstrich, Bindestrich.“ · „Mindestens 12 Zeichen.
  Ein langer Satz ist ein gutes Passwort.“
- Knöpfe: „Konto anlegen“, „Anmelden“, „Passwort vergessen?“
- Fortschritt: „Konto wird angelegt …“ (während PoW + Anfrage)
- Rechtliches: „Mit dem Anlegen gelten die Datenschutzhinweise des Servers.“ + Links „Datenschutz“, „Impressum“
- Fehler: „Dieser Benutzername ist schon vergeben.“ · „Der Benutzername erfüllt die Regeln nicht.“ · „Dieses
  Passwort ist zu kurz oder zu leicht zu erraten.“ · „Die Passwörter stimmen nicht überein.“ · „Auf diesem Server
  kann man sich nicht selbst registrieren.“ · „Dieser Server braucht einen Einladungscode.“ · „Der Einladungscode ist
  ungültig oder abgelaufen.“ · „Zu viele Versuche. Bitte später erneut versuchen.“ · „Dieser Server ist zu alt für
  diese Funktion (Display-Buddy-Server ab Version 0.4 nötig).“ · „Das Konto ist gesperrt.“ · „Zu viele Geräte. Bitte
  zuerst ein altes Gerät abmelden.“
- Wiederherstellungscode-Dialog: Titel „Dein Wiederherstellungscode“ · Text „Mit diesem Code kannst du ein neues
  Passwort setzen, falls du deins vergisst. Er wird nur jetzt angezeigt. Bewahre ihn sicher auf, z. B. im
  Passwort-Manager oder ausgedruckt.“ · „Kopieren“ · Kästchen „Ich habe den Code sicher aufbewahrt.“ · „Weiter“
- Handy verbinden: Knopf „Handy verbinden“ · Text „Scanne den Code mit der Kamera deines Handys (Web-App) oder in
  der Display-Buddy-App mit ‚QR-Code scannen‘.“ · „Oder gib diesen Code ein: ABCD-EFGH-JKMN“ · „Gültig noch 2:41“ ·
  „Neuen Code“ · „Abbrechen“ · Erfolg „✓ ‚Pixel 8‘ ist jetzt angemeldet.“ · „Das war ich nicht – abmelden“ ·
  Ablauf „Der Code ist abgelaufen.“
- Geräte: „Geräte“ · „Dieses Gerät“ · „zuletzt aktiv: heute 09:12“ · „Abmelden“ · Typen „PC“, „Handy-App“,
  „Web-App“ · Passwortabfrage „Dieses Gerät wurde vor deinem angemeldet. Zum Abmelden bitte dein Passwort
  eingeben.“
- Konto: „Angemeldet als anna“ · „Speicher: 12 MB von 50 MB“ · „Passwort ändern“ · „Ich kenne mein aktuelles
  Passwort nicht“ · „Neuer Wiederherstellungscode“ · „Daten exportieren“ · „Konto löschen …“ · „Trennen (nur
  dieser PC)“ · Hinweis „Für dieses Konto gibt es noch keinen Wiederherstellungscode.“ + „Code erzeugen“
- Konto löschen: „Konto endgültig löschen?“ · „Alle Notizen, Erinnerungen und Geräte dieses Kontos werden sofort
  vom Server gelöscht. Auf diesem PC bleiben deine Notizen erhalten. Aus den Sicherungen des Servers verschwinden die
  Daten spätestens nach 14 Tagen.“ · „Vorher Daten exportieren“ · Felder „Passwort“, „Benutzername zur
  Bestätigung“ · „Endgültig löschen“
- Kontingent: „Der Speicher deines Kontos ist voll. Lösche oder kürze Notizen, damit wieder synchronisiert wird.“
- Hinweiskarte (Notizfenster): „Notizen auch aufs Handy?“ · „Lege ein kostenloses Konto an und verbinde dein Handy
  per QR-Code.“ · „Konto anlegen“ · „Später“ · „Nicht mehr zeigen“

**Handy (PWA und native App)**
- Anmeldeseite: „Anmelden“ · „QR-Code scannen“ · „Code eingeben“ · „Mit Passwort anmelden“ · Erklärung „Öffne am
  PC Display Buddy → Einstellungen → Konto & Handy → ‚Handy verbinden‘.“ · „Noch kein Konto? Lege es am PC in
  Display Buddy an.“
- Code-Feld: „Anmeldecode“ · Platzhalter „XXXX-XXXX-XXXX“ · Fehler „Der Code ist ungültig, abgelaufen oder
  wurde schon benutzt. Lass dir am PC einen neuen anzeigen.“ · „Das ist kein Display-Buddy-Anmeldecode.“
- Kamera: „Kamera-Zugriff wird nur zum Scannen benötigt.“ · „Kein Zugriff auf die Kamera. Erlaube ihn in den
  Einstellungen oder gib den Code ein.“
- `/pair`: „Dieses Gerät anmelden“ · „Server: buddy.pev-point.de“ · „Gerätename“ · „Hier anmelden“ · „Nutzt du
  die Display-Buddy-App oder die installierte Web-App? Dann tippe dort auf ‚Code eingeben‘: ABCD-EFGH-JKMN“ ·
  „Du bist schon als ‚anna‘ angemeldet.“
- Server (nur native App): „Server: buddy.pev-point.de · ändern“ · Dialog „Eigenen Server verwenden“ · „Adresse
  deines Servers (https://…)“ · „Standard-Server verwenden“
- Fremder Server im QR: Titel „Anderer Server“ · „Dieser Code gehört zum Server **notes.example.net**. Das ist
  nicht dein eingestellter Server (buddy.pev-point.de). Fahre nur fort, wenn du diesen Server selbst betreibst oder
  ihm vertraust.“ · „Abbrechen“ (Standard) · „Server verwenden und anmelden“
- Einstellungen: „Angemeldet als anna auf buddy.pev-point.de“ · „Konto löschen …“ (Texte wie Desktop, letzter Satz
  „Auf diesem Gerät werden die Daten ebenfalls gelöscht.“) · „Datenschutz“ · „Impressum“
- Format zu neu: „Dein Konto nutzt ein neueres Datenformat. Bitte aktualisiere Display Buddy.“

## 11. Betrieb des Standard-Servers buddy.pev-point.de

### 11.1 Rollen und Verantwortung

Der Betreiber (das Projekt bzw. der Benutzer als Verantwortlicher im Sinne der DSGVO) besitzt: Domain, VPS,
VAPID-Schlüssel, Firebase-Projekt (FCM) der offiziellen Android-App, Signierschlüssel der APK, Backups. Nichts davon
gehört ins Repo.

### 11.2 Konfiguration (neu in v4, alle optional)

| Variable | Standard (Selbst-Host) | pev-point |
|---|---|---|
| `BUDDY_REGISTRATION` | `closed` | `open` |
| `BUDDY_REGISTRATION_POW_BITS` | `22` | `22` |
| `BUDDY_REGISTRATION_DAILY_LIMIT` | `200` | `200` |
| `BUDDY_QUOTA_BYTES` / `BUDDY_QUOTA_NOTES` / `BUDDY_QUOTA_DEVICES` | leer = unbegrenzt | `52428800` / `5000` / `10` |
| `BUDDY_IMPRINT_URL` / `BUDDY_PRIVACY_URL` / `BUDDY_TERMS_URL` | leer | URLs der Seiten des Betreibers |
| `BUDDY_OPERATOR_NAME` | leer | z. B. „pev-point.de“ |
| `BUDDY_FCM_PAYLOAD` | `full` | `minimal` |

### 11.3 Pflichten und Aufgaben (Checkliste, kein Rechtsrat)

- **Impressum** (§ 5 DDG) und **Datenschutzerklärung** (Art. 13 DSGVO) – Inhalte schreibt der Betreiber; die App
  verlinkt sie über `/info` an Registrierung, Anmeldeseite und Einstellungen. Die Erklärung muss mindestens nennen:
  Zweck (Sync), gespeicherte Daten (Benutzername, Passwort-Hash, Notizen/Erinnerungen **im Klartext**, Gerätenamen,
  IP-Adressen in Logs und Bremsen), Empfänger (VPS-Hoster, Push-Dienste von Google/Apple/Mozilla, bei der
  Android-App Firebase), Speicherdauer (Löschung sofort, Backups 14 Tage, Logs 7 Tage), Rechte (Auskunft = Export,
  Löschung = „Konto löschen“), keine E2E-Verschlüsselung.
- **Auftragsverarbeitung** (Art. 28) mit dem VPS-Hoster; Verzeichnis der Verarbeitungstätigkeiten (Art. 30); TOMs
  (dieser Plan §8 als Grundlage).
- **Backups außerhalb des VPS** (z. B. verschlüsselt mit restic auf einen Speicher-Dienst) inkl. `vapid.pem` und
  FCM-Dienstkonto; Rücksicherung einmal testen.
- **Überwachung:** externer Check auf `/api/v1/health` (z. B. Uptime Kuma), Plattenplatz, Zertifikatsablauf
  (Nginx Proxy Manager), Docker-Log-Rotation (`max-size`), NPM-Access-Logs mit IPs nach 7 Tagen löschen.
- **Verfügbarkeit:** ohne Zusage („best effort“), in den Nutzungshinweisen so formuliert; Updates mit Ankündigung.
- **Kosten:** VPS (vorhanden), Domain (vorhanden), FCM kostenlos, kein Apple-Programm nötig (iOS nur PWA bzw.
  Selbstbau, D-54).
- **Firebase für die öffentliche App:** Das Firebase-Projekt der offiziellen APK und das Dienstkonto des Servers
  müssen zusammengehören. Selbst-Hoster, die die offizielle APK mit ihrem Server nutzen, bekommen **keinen**
  FCM-Weckruf (lokale Planung funktioniert trotzdem, D-105).

## 12. Phasen und Arbeitspakete

| Phase | Inhalt | Ordner (exklusiv) | Abhängig von | Aufwand |
|---|---|---|---|---|
| **0 Fundament** (Orchestrator) | Nachrichten + Fehler-Codes in `buddy-core` (`accounts.rs`, `pairing.rs`, `pow.rs`) + TS-Spiegel (`src/lib/sync/types.ts`, `src/lib/pairing.ts`); `api_examples.json`, `pairing_vectors.json`, `pow_vectors.json`; Migration `0003_accounts.sql` + Migrationstest; CSRF-Präfixregel; Desktop-Vertrag (`DEFAULT_SYNC_SERVER_URL`, `accountHintDismissed`, DTOs); `contract.ts`-Erweiterung; D-Einträge final | `crates/`, `src/lib/{sync,pairing.ts}`, `server/migrations/`, `server/src/auth/{mod,csrf}.rs` (nur Pfadregel), `src/types.ts`, `src-tauri/src/model.rs`, `src/web/contract.ts`, `docs/` | – | M |
| **A Server-Konten** | `/info`, Registrierung (PoW, Limits, Einladung, Passwortliste), Wiederherstellung, `/me/*`, Export, Löschen, Kontingente in `sync.rs`, Sperre, verallgemeinerte Limits, CLI-Admin, Aufräumen, `BUDDY_FCM_PAYLOAD`, Config | `server/` ohne `server/src/pairing/`, `server/tests/pairing.rs`, `server/migrations/` | 0 | L |
| **B Desktop** | Konto- und Pairing-Client in Rust, 14 Commands, `open_settings(section)`, Abschnitt „Konto & Handy“, QR-Anzeige, Wiederherstellungs-Dialog, Hinweiskarte | `src-tauri/src/sync/`, `src-tauri/src/commands/{account,pairing,sync,windows}.rs`, `lib.rs`/`build.rs`/`capabilities/*.json`/`tests/contract.rs`/`Cargo.toml` (nur Einträge), `src/windows/settings/`, `src/windows/notes/AccountHint*` (+ Einbindung in `NotesApp`), `src/lib/api*` | 0 (gegen Mock-Server; echter Server ab A/P) | L |
| **C Web** | `loginWithCode`, Adapter-Tokenregel, `serverInfo`, `deleteAccount`, Format-Sperre; Web-Scanner; `LoginPage`, `PairPage`, Konto in Settings, Rechtslinks, Server-Zeile über `ServerSelector` | `src/web/sync/`, `src/web/pairing/`, `src/web/ui/`, `src/web/main.tsx`, `package.json` (jsqr) | 0 | M |
| **P Server-Pairing** | `/pairing*`, `/devices/pairing`, `/session/pairing`, Limits, Geräte-Limit, Tests | `server/src/pairing/`, `server/tests/pairing.rs` (+ eine Zeile Router in `lib.rs`, mit A abgestimmt) | A | M |
| **N Native App** | Scanner-Plugin, `server_get/set`, Laufzeit-Scope, Standard-Origin, Info.plist/Kamera, Migration der Origin, `main.tsx`-Verdrahtung, README, CI-Variable | `mobile/` (ohne `mobile/patches/`), `.github/workflows/mobile-*.yml` | C, 0 | M |
| **E Betrieb** | Compose-Variablen, `.env.example`, `deploy/README.md` (Upgrade v3→v4, Registrierung, Admin-Befehle), `docs/OPERATIONS.md` (§11), Docker-Log-Rotation | `deploy/`, `docs/OPERATIONS.md` | A | S |
| **F Integration** (Orchestrator) | Zusammenführen, Abnahme §13, Doku (HANDOFF, MANUAL_TESTS §32 ff., README), Version 0.4.0, Installer, APK | alle | alle | M |

Reihenfolge: **0 → (A ∥ B ∥ C) → (P ∥ N ∥ E) → F.** B und C arbeiten gegen Mocks der neuen Endpunkte, bis A/P fertig
sind. Aufwand: S ≈ ein kurzer Agentenlauf, M ≈ ein voller, L ≈ ein voller Lauf mit Nacharbeit.

## 13. Tests und Abnahme

**Pflicht-Checks** (wie v3 §13): `npm test` (+ `test:tz`), `npm run build`, `npm run build:web`,
`npm run build:mobile`; `cargo test`, clippy `-D warnings`, `fmt` in `src-tauri`, `server`, `crates/buddy-core`,
`mobile/src-tauri`; Windows-clippy + NSIS-Cross-Build; Android/iOS-Build in CI.

**Neue Testvektoren:** `pairing_vectors.json` (Normalisierung, Format, URL-Parsing gut/schlecht: http, falscher Pfad,
fehlendes/zusätzliches Fragment, Query statt Fragment, Großbuchstaben-Host, Port, IDN), `pow_vectors.json`
(Challenge + bits → gültige/ungültige Nonces). Rust und TypeScript lesen dieselben Dateien.

**Abnahmeszenarien** (lokal: Server mit Temp-DB, Desktop unter Xvfb, PWA mit Playwright/Chromium, native App im
Android-Emulator in CI):

| Nr. | Szenario | Erwartung |
|---|---|---|
| 1 | Registrieren am Desktop (Modus open) | Konto + Gerät angelegt, Wiederherstellungscode angezeigt, Sync läuft, `created_via=register` |
| 2 | Registrieren: Name vergeben / ungültig / Passwort zu kurz / häufig / = Name | jeweils richtige deutsche Meldung, nichts angelegt |
| 3 | Registrieren: Modus closed / invite ohne, mit falschem, mit gültigem Code | Meldung bzw. Erfolg; Einladung danach verbraucht |
| 4 | Registrieren: falsche/abgelaufene/wiederverwendete Challenge, 4. Registrierung pro Stunde von einer IP | `challenge_invalid` bzw. `429` |
| 5 | QR in der PWA (Playwright: `/pair#c=…` öffnen) | Fragment sofort entfernt, kein Einlösen ohne Klick, nach Klick Cookie-Sitzung, Sync, PC zeigt „angemeldet“ |
| 6 | QR in der nativen App (Emulator: Scanner gemockt bzw. Code eingeben) | Token gespeichert, Sync, PC zeigt Gerät |
| 7 | Abgelaufener Code (simulierte Uhr + 3 min) | `pairing_invalid`, PC zeigt „abgelaufen“ |
| 8 | Benutzter Code ein zweites Mal / parallel zweimal | genau ein Gerät, zweiter Versuch `pairing_invalid` |
| 9 | Falscher Server im QR (native) | Bestätigungsdialog mit Origin; Abbrechen → nichts gespeichert; Zustimmen → `server.json`, Neustart, Anmeldung |
| 10 | Falscher Server: `http://`-URL, anderer Pfad, kaputtes Fragment | „kein Display-Buddy-Anmeldecode“ |
| 11 | Cross-Site-`POST /session/pairing` | 403 |
| 12 | 11 falsche Codes von einer IP | 429 mit `Retry-After` |
| 13 | „Das war ich nicht – abmelden“ am PC | Gerät widerrufen, nächste Anfrage des Handys 401 |
| 14 | Jüngeres Gerät will älteres abmelden ohne/mit Passwort | 403 `password_required` / 204 |
| 15 | Passwort ändern mit altem Passwort; ohne (Gerät < 24 h / ≥ 24 h, simulierte Uhr) | Regeln §6.4; andere Geräte abgemeldet |
| 16 | Wiederherstellung mit Code | alle anderen Geräte 401, neuer Code, alter Code ungültig |
| 17 | Konto löschen am PC | alle Zeilen des Kontos weg (DB-Prüfung), PC-Notizen lokal vorhanden, Handy beim nächsten Sync abgemeldet |
| 18 | Export | JSON nach §5.4, keine Hashes/Tokens/Endpunkte |
| 19 | Migration einer v3-DB (Kopie der Testdaten aus v3-Tests) | Migration läuft, v3-Konto loggt ein, Sync unverändert, `recovery_hash NULL`, Desktop bietet „Code erzeugen“ |
| 20 | v3-Desktop gegen v4-Server, v4-Desktop gegen v3-Server | wie §9.1 |
| 21 | Native App v3 → v4 (gleiche `BUDDY_PUBLIC_URL`) / v4-Build mit anderer Origin als `meta.account.serverUrl` | bleibt angemeldet und synchronisiert / kein Sync, Hinweis „anderer Server“, Outbox bleibt |
| 22 | Kontingent: Paket über Limit / Paket mit Löschungen über Limit | 413 + Outbox bleibt / geht durch |
| 23 | Geräte-Limit (11. Gerät) | 409 `device_limit` + Meldung |
| 24 | Konto gesperrt (CLI) | alle Geräte 403 `account_disabled`, Meldung „Das Konto ist gesperrt.“ |
| 25 | Selbst-Hoster: Server ohne neue Variablen | Registrierung aus, unbegrenzte Kontingente, alles wie v3; Desktop mit eigener Adresse registriert nicht, meldet „nicht selbst registrieren“ |
| 26 | Logs | kein Code, Passwort, Token, Wiederherstellungscode in Server- und Desktop-Logs (grep im Testlauf) |
| 27 | `content_format` = 2 (manuell gesetzt) | v4-Clients stoppen den Sync mit Hinweis, keine Schreibvorgänge |
| 28 | Hinweiskarte | erscheint nicht verbunden; „Nicht mehr zeigen“ wirkt dauerhaft; verbunden nie |

**Nur durch den Benutzer testbar** (`MANUAL_TESTS.md` v4): echtes Android-Handy (Kamera-Scan in der App und mit der
Kamera-App → PWA), iPhone (Kamera-App → Safari → `/pair`, installierte PWA mit „Code eingeben“ bzw. In-App-Scanner,
native App per Xcode mit Kamera-Erlaubnis), Windows-Installer (Registrierung gegen buddy.pev-point.de, Anzeige des
QR-Codes bei 100/150/200 % Skalierung), Betrieb auf dem echten Server hinter NPM (echte Client-IPs in den Limits),
Rechtslinks.

## 14. Risiken und offene Punkte

- **iOS-PWA und Kamera-App:** Die iOS-Kamera öffnet Links in Safari, nicht in der Home-Bildschirm-App; ob Cookies
  von Safari in eine später installierte Web-App übernommen werden, ist je nach iOS-Version unterschiedlich und in
  der Doku nicht verlässlich beschrieben. Deshalb Code-Eingabe und In-App-Scanner in der installierten PWA; am echten
  iPhone prüfen.
- **In-App-Scanner in iOS-Home-Bildschirm-Apps:** `getUserMedia` in Standalone-Web-Apps am Gerät prüfen; Fallback ist
  die Code-Eingabe.
- **Proof-of-Work** bremst nur; ein entschlossener Angreifer mit vielen IPs registriert trotzdem → Kontingente,
  Tageslimit und `invite`-Schalter sind die eigentliche Absicherung. Wert nach dem Start beobachten.
- **Kein E2E** beim öffentlichen Dienst: Vertrauensfrage, offen kommuniziert (D-101).
- **Ohne Bestätigung am PC** (Benutzerentscheidung) bleibt S4 ein Restrisiko für 3 min.
- **Firebase:** Nur Builds mit dem Firebase-Projekt des Betreibers bekommen FCM-Weckrufe von pev-point.
- **Android-Manifest** (`uses-feature camera.any`) beim Store-Vertrieb; Sideload unkritisch.
- **Origin beim App-Update** (§9.2): nur relevant, wenn ein Ersteller die Variable ändert; Schutz durch Vergleich
  mit `meta.account.serverUrl`.
- **Offen beim Benutzer:** Ist buddy.pev-point.de ein neuer Server oder die neue Adresse des bestehenden? Bei
  Domainwechsel: alte Adresse eine Zeit lang parallel betreiben (zweiter Proxy-Host, aber `BUDDY_PUBLIC_URL` kann nur
  eine Origin – CSRF und Cookies hängen daran), Geräte neu verbinden, PWA neu installieren.
- **Rechtliches:** Inhalte von Impressum/Datenschutz und ggf. Nutzungsbedingungen liefert der Betreiber.

## 15. Nicht-Ziele in v4

- Ende-zu-Ende-Verschlüsselung (vorbereitet, D-101)
- E-Mail-Adressen, E-Mail-Versand, Passwort-Reset per E-Mail
- Registrierung in PWA oder nativer App
- Admin-Oberfläche (nur CLI)
- Bestätigung des Pairings am PC (Benutzerentscheidung)
- Pairing PC → PC (zweiter PC meldet sich mit Passwort an)
- Android App Links / iOS Universal Links (Kamera öffnet direkt die native App)
- App-Store-/Play-Store-Veröffentlichung
- Teilen von Notizen zwischen Konten
- Zwei-Faktor-Authentifizierung, Passkeys (später möglich: `PublicKeyCredential` ist laut browser-compat-data
  in Chrome Android 70 / Safari iOS 13 vorhanden)
- Sync von Einstellungen, Shortcuts, Skins (wie v3)
