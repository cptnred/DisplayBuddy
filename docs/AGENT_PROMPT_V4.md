# Prompts für die ausführenden Agenten – v4

Diese Datei enthält:
1. den **Start-Prompt für den Orchestrator** (in eine neue Claude-Code-Session kopieren),
2. die **gemeinsamen Regeln** für jeden Subagenten (v3-Regeln + v4-Ergänzungen),
3. je einen **Auftrag pro Phase** (0, A, B, C, P, N, E, F),
4. die **Vorlage für den Abschlussbericht**.

Grundlage ist `docs/PLAN_V4_ACCOUNTS.md`. Bei Widersprüchen gilt der Plan; Abweichungen werden in
`docs/DECISIONS.md` begründet (v4-Vorschläge D-85 ff. dort finalisieren).

---

## 1. Start-Prompt für den Orchestrator

```text
Du setzt v4 von Display Buddy um:
- Benutzerkonten werden in der Desktop-App angelegt („Konto anlegen“, Proof-of-Work, Wiederherstellungscode);
- Handys (PWA und native Android/iOS-App) melden sich per QR-Code an, den die Desktop-App zeigt
  (Code 3 min, einmalig, ohne Bestätigung am PC – Ausgleich laut Plan §6.2/§8);
- Standard-Server ist https://buddy.pev-point.de; Selbst-Hoster tragen eine eigene Adresse ein
  (Desktop: Einstellung, native App: zur Laufzeit, PWA: immer ihr eigener Server);
- Konto-Funktionen: Geräte, Passwort ändern/vergessen, Export, Konto löschen, Kontingente, Admin-CLI.
Antworte dem Benutzer auf Deutsch; Code, Bezeichner und Commits auf Englisch.

Lies zuerst vollständig, in dieser Reihenfolge:
CLAUDE.md, docs/HANDOFF.md (§5 Lektionen, §7a), docs/DECISIONS.md (v. a. D-28…D-106), docs/PLAN_V3_SYNC.md,
docs/PLAN_V4_ACCOUNTS.md, docs/AGENT_PROMPT_V4.md.

Deine Rolle: Orchestrator.
- Phase 0 und Phase F erledigst du selbst.
- Die Phasen A, B, C, P, N, E gibst du an Subagenten, jeweils mit eigenem git-Worktree und den exklusiven Ordnern
  aus PLAN_V4 §12.
- Gib jedem Subagenten den Block „Gemeinsame Regeln“ (§2) und seinen Phasenauftrag (§3) wörtlich mit.
- Reihenfolge: 0 → (A ∥ B ∥ C) → (P ∥ N ∥ E) → F.
  B und C arbeiten bis zum Ende von A/P gegen Mock-Server bzw. Fakes der neuen Endpunkte.

Vor Phase 0:
1. Bau-Umgebung wie in HANDOFF §4 einrichten, npm install, alle bestehenden Checks einmal grün sehen
   (Frontend, src-tauri, server, crates/buddy-core, mobile/src-tauri). Rote Checks zuerst melden.
2. Versionen prüfen und als D-Eintrag festhalten (cargo info / npm view, stabile Linien, keine Alphas):
   tauri-plugin-barcode-scanner (+ npm), qrcode (Rust), jsqr, sha2 in buddy-core (dieselbe Linie wie im Server),
   Herkunft und Lizenz der Liste häufiger Passwörter.
3. Mit dem Benutzer klären (Multiple-Choice), falls noch offen (PLAN_V4 §14):
   - Ist buddy.pev-point.de ein neuer Server oder die neue Adresse seines bestehenden v3-Servers?
   - Liegen die URLs für Impressum und Datenschutzerklärung schon vor (für BUDDY_IMPRINT_URL/BUDDY_PRIVACY_URL)?
   - Gibt es ein Firebase-Projekt für die öffentliche Android-App (sonst bleibt FCM auf pev-point aus)?

Produktfragen stellst du dem Benutzer als Multiple-Choice-Frage (max. 4 pro Runde), technische Details entscheidest
du selbst und begründest sie in docs/DECISIONS.md. Die Entscheidungen in PLAN_V4 §1 sind gesetzt.

Nach jeder Phase:
- Ergebnis prüfen: Diff lesen, alle Checks selbst laufen lassen.
- Integrieren, Konflikte lösen, erneut grün, committen, pushen.

Am Ende: Abschlussbericht (§4), ehrlich getrennt nach „getestet“, „nur kompiliert/statisch geprüft“ und
„nicht prüfbar (nur Benutzer)“. Installer, APK und Anleitungen als ZIP liefern (HANDOFF §2).
```

---

## 2. Gemeinsame Regeln (jedem Subagenten mitgeben)

```text
GEMEINSAME REGELN – Display Buddy v4

Projekt & Vertrag
- Lies CLAUDE.md, docs/HANDOFF.md (§5 Lektionen!), docs/PLAN_V3_SYNC.md (gilt weiter) und
  docs/PLAN_V4_ACCOUNTS.md (verbindlich für v4).
- Arbeite NUR in den Ordnern deines Auftrags. Änderungen außerhalb beschreibst du präzise im Bericht.
- API-Vertrag: PLAN_V4 §5. Nachrichten NUR aus crates/buddy-core (Rust) bzw. src/lib/sync/types.ts (TypeScript);
  Beispiele in crates/buddy-core/tests/fixtures/api_examples.json. Keine eigenen Feldnamen. Abweichungen begründen.
- Desktop-Regeln:
  - nur src/lib/api.ts ruft invoke()/listen();
  - außerhalb state.rs nie .state(), immer try_state;
  - 4-Stellen-Regel für Commands (+ api.test.ts, plan_commands() in tests/contract.rs, Least-Privilege-Test);
  - Settings-Felder in types.ts + model.rs + Tests; geschützte Felder (D-62) nur über ihre Commands;
  - HTTP nur Rust-seitig (D-36), Netzwerk nie unter einem Lock.
- UI-Texte Deutsch (Ausgangspunkt PLAN_V4 §10); Animationen nur transform/opacity; prefers-reduced-motion;
  aria-label; Tastatur.

Zeit, Zeitstempel, Zeitzonen (PLAN_V3_SYNC §5.3–§5.5, gilt überall)
- updatedAt = korrigierte Gerätezeit (UTC, YYYY-MM-DDTHH:MM:SS.sssZ) zum Zeitpunkt der Bearbeitung, auch
  offline. Der Server stempelt nie um (nur Klemme > 2 min Zukunft). Zeitpunkte als Zeitpunkte vergleichen.
- LWW, Uhr-Korrektur und Erinnerungsmathe NUR über die gemeinsamen Funktionen:
  - Rust: buddy-core;
  - TypeScript: src/lib/sync, src/lib/clock.ts, src/lib/zoned.ts, src/lib/schedule.ts;
  - nie eigene Vergleiche oder Datumsrechnungen schreiben.
- Erinnerungen rechnen in reminder.timeZone (IANA), nie in der Gerätezone. „Jetzt“ ist immer UTC.
- Kein `new Date()` / `Local::now()` / `Utc::now()` direkt in Geschäftslogik: Uhr injizieren (Tests mit simulierter
  Zeit). Das gilt auch für Ablaufzeiten von Codes, Challenges und Limits.

Konten, Codes, Geheimnisse (v4, gilt überall)
- Pairing-Codes, Wiederherstellungscodes und PoW NUR über buddy-core (pairing.rs, pow.rs, accounts.rs) bzw.
  src/lib/pairing.ts; beide bestehen pairing_vectors.json bzw. pow_vectors.json.
- Geheimnisse (Passwörter, Tokens, Sitzungen, Pairing-, Einladungs- und Wiederherstellungscodes) stehen NIE in
  URL-Pfad oder Query, nie in Logs, nie in Fehlermeldungen; der Server speichert nur Hashes (SHA-256 bzw. Argon2id
  für Passwörter). Zufall nur aus einem CSPRNG (rand::rng / crypto.getRandomValues).
- Einheitliche Fehlermeldungen, wo sonst Existenz verraten würde (Login, Wiederherstellung, Pairing:
  ein Code „pairing_invalid“). Bremsen nach PLAN_V4 §8.2; IP nur über BUDDY_TRUSTED_PROXIES.
- Cookie-Endpunkte unter /api/v1/session* immer mit CSRF-Prüfung (D-104); Bearer-Endpunkte setzen nie Cookies.
- Neue Schreibwege für Notizen/Erinnerungen gibt es nicht: /sync/push bleibt der einzige (D-43).

Quellen (verbindliche Reihenfolge)
1. Offizielle Dokumentation und Beispiele, insbesondere:
   - Server: axum/tower-http, sqlx, OWASP Cheat Sheets (Authentication, Forgot Password, Session Management,
     CSRF Prevention, Password Storage), NIST SP 800-63B, RustCrypto, Docker;
   - Desktop & App: Tauri (tauri-docs, plugins-workspace inkl. Quellcode von barcode-scanner, http, dialog,
     opener), keyring-rs, qrcode-Crate;
   - Web: MDN (mdn/content) + browser-compat-data (getUserMedia, BarcodeDetector, History.replaceState),
     jsQR-README;
   - nativer Push: Firebase/FCM-Doku.
   Halte dich an die dort beschriebenen Vorgehensweisen.
2. Bei Problemen: GitHub Issues/Discussions/Changelogs des betroffenen Projekts.
3. Danach Stack Overflow.
- Browser-Funktionen nur als Pflicht nutzen, wenn browser-compat-data sie für Chrome Android UND Safari iOS
  ausweist. Sonst nur als optionale Ergänzung mit Fallback (Beispiele: BarcodeDetector, Notification-actions).
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
- Keine Geheimnisse ins Repo (Passwörter, Tokens, VAPID-/FCM-Schlüssel, google-services.json, Keystores,
  Wiederherstellungscodes aus Testläufen). Beispielwerte nur in .env.example. CI-Geheimnisse nur als
  GitHub-Secrets mit Namen dokumentieren.
- Logs enthalten nie Notizinhalt, Passwörter, Tokens, Codes, Push-Endpunkte oder Schlüssel. Ein Test prüft das
  für deinen Bereich (z. B. Log-Ausgabe eines Testlaufs nach dem Testcode durchsuchen).

Bericht am Ende (Pflicht, Deutsch)
- Was umgesetzt ist (Dateien); was getestet ist (Befehle + Ergebnis); was nur kompiliert; was offen ist.
- Gewählte Versionen und Entscheidungen mit Quelle (Vorschlag für DECISIONS.md).
- Nötige Änderungen außerhalb deiner Ordner.
```

---

## 3. Phasenaufträge

### Phase 0 – Fundament (Orchestrator selbst)

```text
1. crates/buddy-core:
   - accounts.rs: ServerInfo, RegistrationMode, LegalLinks, RegistrationChallenge, AccountCreate, AccountAccess,
     AccountRecover, AccountInfo (Usage, Quota), DeviceInfo, DeviceList, DeviceRevoke, PasswordChange,
     RecoveryCodeRequest/Response, AccountDelete, AccountExport (+ RevisionExport); Benutzername-Regeln
     (validate_new_username, RESERVED_USERNAMES); Wiederherstellungscode (generate, normalize, format, hash).
   - pairing.rs: PairingStart, PairingState, PairingStatus, PairingRedeem, PairingAccess, SessionPairing;
     Code erzeugen (60 Bit, Crockford-Base32), normalisieren (O→0, I/L→1, Trennzeichen weg), formatieren
     (XXXX-XXXX-XXXX), pairing_url(origin, code), parse_pairing_url(text) → (origin, code) mit den Regeln aus
     PLAN_V4 §6.2 (nur https bzw. http-localhost, Pfad /pair, Fragment c=…).
   - pow.rs: verify(challenge, bits, nonce) und solve(challenge, bits, max_iter) (SHA-256 über
     challenge_bytes ‖ nonce_u32_le, führende Null-Bits).
   - error_codes um PLAN_V4 §5.3 ergänzen. Alles re-exportiert, serde camelCase, Rundlauf-Tests mit
     api_examples.json (jede neue Nachricht ein Beispiel).
2. Testvektoren: tests/fixtures/pairing_vectors.json, pow_vectors.json (+ Erzeugungsskript, falls nötig).
3. TypeScript-Spiegel: src/lib/sync/types.ts (Nachrichten, ERROR_CODES), src/lib/pairing.ts (normalize, format,
   parsePairingUrl); Vitest liest dieselben Vektoren und typprüft api_examples.json.
4. server/migrations/0003_accounts.sql exakt nach PLAN_V4 §4; Test: Migration auf einer v3-Test-DB (mit Konto,
   Geräten, Notizen) läuft, Altdaten unverändert, Defaults gesetzt.
5. server/src/auth/mod.rs: CSRF-Regel per Präfix /api/v1/session (D-104) + Test (Cross-Site POST
   /api/v1/session/pairing → 403, auch wenn die Route noch 404 wäre: Guard läuft vorher).
6. Desktop-Vertrag: types.ts + model.rs: DEFAULT_SYNC_SERVER_URL (Vertragstest: gleich in Rust und TS),
   Settings-Feld accountHintDismissed (Default false, Schlüsselanzahl im Vertragstest), DTOs AccountRegistered,
   PairingInfo (Rust re-exportiert buddy-core-Typen für AccountInfo/DeviceInfo/PairingStatus/ServerInfo).
   Die Commands selbst (plan_commands, api.ts) trägt Phase B ein.
7. src/web/contract.ts: SyncEngine.loginWithCode/serverInfo/deleteAccount, QrScanner, ServerSelector,
   WebSyncState-Erweiterung nur falls nötig (Kontingent/Format über message), dokumentiert.
8. DECISIONS.md: v4-Vorschläge D-85 ff. finalisieren, Versionen (Vorab-Schritt 2) ergänzen.
Checks: npm test (+ test:tz), npm run build, cargo test/clippy/fmt in crates/buddy-core, server, src-tauri
(+ windows-gnu clippy), NSIS-Cross-Build.
```

### Phase A – Server: Konten, Registrierung, Admin (Subagent)

```text
Auftrag: Konten auf dem Server gemäß PLAN_V4 §4, §5, §6.1, §6.4, §6.6, §7.4, §8, §11.2.
Ordner (exklusiv): server/ OHNE server/src/pairing/, server/tests/pairing.rs, server/migrations/.
Quellen: OWASP Authentication / Forgot Password / Session Management / Password Storage Cheat Sheets,
NIST SP 800-63B (Abschnitt Memorized Secrets), axum-Beispiele (testing), sqlx-Doku.
- config.rs: BUDDY_REGISTRATION (open|invite|closed, Standard closed), BUDDY_REGISTRATION_POW_BITS (22),
  BUDDY_REGISTRATION_DAILY_LIMIT (200), BUDDY_QUOTA_BYTES/NOTES/DEVICES (leer = unbegrenzt),
  BUDDY_IMPRINT_URL/PRIVACY_URL/TERMS_URL (nur https), BUDDY_OPERATOR_NAME, BUDDY_FCM_PAYLOAD (minimal|full,
  Standard full). Fehlerhafte Werte → Start bricht mit klarer Meldung ab.
- auth/limits.rs: Limiter verallgemeinern (Schlüssel, Fenster, Sperre; im Speicher; Prune in housekeeping);
  bestehende Login-Bremse (D-67) unverändert im Verhalten; neue Limits laut PLAN_V4 §8.2; 429 + Retry-After.
- Auth-Extraktor: Konto gesperrt (users.disabled_at) → 403 account_disabled; Login ebenfalls.
- accounts/ (neu):
  - GET /info (öffentlich, apiLevel 2, features, registration, passwordMinChars, legal, operator).
  - POST /accounts/challenge (Speicher im RAM, max. 10 000, 10 min, einmalig) und POST /accounts
    (Prüfreihenfolge PLAN_V4 §6.1 Schritt 4; eine Transaktion für users + devices + invites; created_via).
  - Passwortregeln: buddy-core-Regeln + Liste häufiger Passwörter (include_str!, Herkunft/Lizenz in einer
    README-Zeile neben der Datei), ≠ Benutzername.
  - POST /accounts/recover (Bremse wie Login, einheitliche Fehlermeldung, Dummy-Arbeit bei unbekanntem Namen,
    revoke aller Geräte/Sitzungen, neues Gerät created_via=recovery, neuer Code).
  - GET /me/account, GET /me/devices, POST /me/devices/{id}/revoke (Regel „eigenes oder jüngeres“, sonst
    password_required; Passwort über die Bremse), PUT /me/password (Regeln D-89, ohne currentPassword nur
    desktop/mobile ≥ 24 h), POST /me/recovery-code, GET /me/export (Format §5.4, Content-Disposition,
    1/min), POST /me/delete (Passwort + confirmUsername, Cascade, Cookie löschen bei Web).
  - Geräte-Limit in POST /devices und POST /session (Hilfsfunktion, die Phase P mitbenutzt: öffentlich in
    accounts::quota exportieren und im Bericht nennen).
- sync.rs: Kontingent-Prüfung in der Push-Transaktion (Netto-Regel D-94, 413 quota_exceeded, nichts angewendet).
- push/native_fcm.rs: BUDDY_FCM_PAYLOAD=minimal → Titel „Erinnerung fällig“, Text „Tippen zum Öffnen“, data
  unverändert (noteId/at).
- cli.rs: user list|show|disable|enable|delete (--yes)|quota (--bytes/--notes/--devices, „default“)|recovery;
  invite create (--expires, --label; Code nur einmal ausgeben)|list|revoke; user add gibt einen
  Wiederherstellungscode aus. Passwörter weiterhin nur über Terminal/stdin.
- housekeeping.rs: Aufräumen laut PLAN_V4 §4 (pairings, widerrufene Geräte nach 30 Tagen, invites nach 90 Tagen).
- Router: neue Routen in api.rs bzw. accounts::router(), in lib.rs gemergt. Phase P hängt pairing::router()
  daneben ein – lass dafür eine kommentierte Zeile in lib.rs (build_app) frei.
Tests (oneshot, Temp-SQLite, simulierte Uhr):
- Abnahme PLAN_V4 §13 Nr. 1–4, 14–20, 22–27 soweit serverseitig; Limits und Retry-After; Migration +
  Altkonten; Logs ohne Geheimnisse; Export ohne Hashes; Cascade beim Löschen (alle Tabellen leer für das Konto,
  anderes Konto unberührt).
Checks: cd server && cargo test && cargo clippy --all-targets -- -D warnings && cargo fmt --check.
```

### Phase B – Desktop: Konto & Handy (Subagent)

```text
Auftrag: Konto-Funktionen und QR-Anzeige am Desktop gemäß PLAN_V4 §6.1–§6.6, §7.1, §10.
Ordner (exklusiv):
- src-tauri/src/sync/ (neu account.rs, pairing.rs), src-tauri/src/commands/{account,pairing,sync,windows}.rs;
- src/windows/settings/ (AccountSection ersetzt SyncSection, Bestandteile übernehmen), src/windows/notes/AccountHint*
  (+ minimale Einbindung in NotesApp), src/lib/api*;
- nur Einträge in lib.rs (generate_handler!), build.rs (COMMANDS), capabilities/settings.json und notes.json
  (allow-open-settings), tests/contract.rs (plan_commands), Cargo.toml (qrcode), commands/mod.rs.
Quellen: tauri-docs (Capabilities, plugin dialog/opener), qrcode-Crate-Doku (SVG-Renderer), keyring-rs.
- Client (Rust, tauri_plugin_http::reqwest, https-Regeln wie v3):
  - account_server_info, account_register (Challenge → buddy_core::pow::solve in spawn_blocking, max. 60 s →
    POST /accounts → wie sync::connect weiter: Token in den Anmeldeinformationsspeicher, Erstabgleich, Sync an),
    account_recover, account_info, account_devices, account_revoke_device, account_change_password,
    account_new_recovery_code, account_export (Speichern-Dialog Rust-seitig, Dateiname laut Plan),
    account_delete (danach wie sync_disconnect, lokale Notizen bleiben), account_open_link (nur https aus
    ServerInfo, über opener Rust-seitig);
  - pairing_start (POST /pairing, QR-SVG mit qrcode, EC-Level M, als String), pairing_status, pairing_cancel;
  - sync_connect: serverUrl "" = DEFAULT_SYNC_SERVER_URL; open_settings(section?).
  - Fehler als „code: detail“ (PLAN_V4 §7.1); keine Geheimnisse in Logs (Codes, Passwörter, Tokens).
- Oberfläche „Konto & Handy“ (PLAN_V4 §7.1, Texte §10):
  - Server-Zeile + „Eigenen Server verwenden …“; Umschalter Konto anlegen / Anmelden; Passwort vergessen;
    Rechtslinks; Einladungscode bei registration=invite; „Server zu alt“ bei 404.
  - Pflicht-Dialog Wiederherstellungscode (Kopieren über navigator.clipboard, Kästchen, erst dann Weiter;
    Fokusfalle, Esc schließt NICHT, data-local-escape-Konvention beachten).
  - Handy verbinden: QR erst auf Klick, Countdown (aria-live nur bei Start und < 30 s), Code als Text, Polling
    alle 2 s, Erfolg mit „Das war ich nicht – abmelden“, Ablauf/Neuer Code, Abbrechen beim Schließen.
  - Geräte, Konto (Speicherbalken, Passwort ändern inkl. „aktuelles Passwort unbekannt“, Code erzeugen, Export,
    Konto löschen mit Bestätigung), Trennen; Hinweis für Konten ohne Code.
  - QR bei 100/150/200 % lesbar (SVG, feste Mindestgröße 220 px, heller Rand).
- Hinweiskarte im Notizfenster (accountHintDismissed, Später/Nicht mehr zeigen, open_settings("account")).
Tests:
- Rust: Client gegen HTTP-Mock (Registrierung inkl. PoW mit kleinem bits-Wert, Fehlerabbildung, Recover,
  Pairing-Polling-Zustände, Export schreibt Datei), Default-URL, kein Geheimnis im Log.
- Vitest: AccountSection (alle Zustände, Fehltexte, Dialog-Pflicht, Countdown mit Fake-Timern, Tastatur),
  AccountHint, api.test.ts für jeden Command, capabilities.test.ts.
Checks: npm test (+ test:tz), npm run build, cargo test, clippy (Linux + windows-gnu), fmt, NSIS-Cross-Build.
```

### Phase C – Web: Anmeldung per Code/QR, Konto in der App (Subagent)

```text
Auftrag: PWA und gemeinsame Oberfläche gemäß PLAN_V4 §6.2 (PWA), §6.6, §7.3, §10.
Ordner (exklusiv): src/web/sync/, src/web/pairing/ (neu), src/web/ui/, src/web/main.tsx, package.json (nur jsqr).
Quellen: MDN getUserMedia, BarcodeDetector, History.replaceState, Permissions; browser-compat-data;
jsQR-README; OWASP CSRF (Login-CSRF).
- Sync-Engine (contract.ts aus Phase 0):
  - loginWithCode: web → POST /session/pairing (Cookie), nativ → POST /devices/pairing; danach wie login()
    (GET /me, account_mismatch-Regel D-71).
  - createNativeHttp: Token auch aus der Antwort von POST /devices/pairing übernehmen und aus dem Body
    entfernen (wie bei POST /devices).
  - serverInfo() (GET /info, 404 → null), deleteAccount(password, confirmUsername) → danach wie logout +
    DataStore.signOut.
  - GET /me/account nach Login und bei Start: unbekanntes contentFormat → Sync stoppt, message
    „content_format_unsupported“; 413 quota_exceeded und 409 device_limit als eigene Meldungen.
- src/web/pairing/: parse.ts (src/lib/pairing.ts), web-scanner.ts (QrScanner: getUserMedia mit
  facingMode environment, BarcodeDetector wenn vorhanden, sonst jsqr per dynamischem import; Stream bei
  Abbruch/Erfolg/Seitenwechsel stoppen; isAvailable() ohne Kamera-Abfrage).
- Oberfläche:
  - LoginPage: QR scannen (nur wenn ein Scanner verfügbar ist) / Code eingeben / Mit Passwort anmelden;
    Hinweis „Konto am PC anlegen“; Rechtslinks aus serverInfo; Server-Zeile + Dialog nur mit ServerSelector.
  - Fremde Origin aus einem gescannten Code: nur in der nativen App relevant (ServerSelector vorhanden) →
    Bestätigungsdialog (Text PLAN_V4 §10), „Abbrechen“ ist Standard; ohne ServerSelector (PWA): Code mit fremder
    Origin wird abgelehnt mit „Dieser Code gehört zu einem anderen Server (…). Öffne ihn dort.“
  - PairPage (/pair): Fragment lesen, sofort per history.replaceState entfernen, nie automatisch einlösen,
    Server + Gerätename + „Hier anmelden“, Code als Text für App/installierte PWA, „schon angemeldet“-Zustand.
  - Settings: „Angemeldet als … auf …“, „Konto löschen …“, Datenschutz/Impressum.
- Keine Registrierung in der PWA (Nicht-Ziel).
Tests (Vitest + Testing Library, gemocktes fetch, fake-indexeddb, gemocktes getUserMedia/BarcodeDetector):
- Engine: loginWithCode web/nativ, Token-Übernahme, pairing_invalid, device_limit, content_format, deleteAccount.
- PairPage: Fragment entfernt, kein Request ohne Klick, Erfolg/Fehler, schon angemeldet.
- LoginPage: drei Wege, Fehltexte, fremde Origin mit/ohne ServerSelector, Tastatur/aria.
- Scanner: Stream wird gestoppt; Fallback auf jsqr; kein Scanner → Knopf versteckt.
Checks: npm test (+ test:tz), npm run build, npm run build:web.
```

### Phase P – Server: Pairing (Subagent)

```text
Auftrag: QR-Pairing auf dem Server gemäß PLAN_V4 §5.1/§5.2 (Pairing-Zeilen), §6.2, §6.3, §8 (S4–S9).
Ordner (exklusiv): server/src/pairing/, server/tests/pairing.rs; dazu genau eine Zeile in server/src/lib.rs
(pairing::router() in build_app mergen, an der von Phase A vorbereiteten Stelle).
Abhängig von Phase A (Limiter in auth/limits.rs, Geräte-Limit in accounts::quota, Sperre im Extraktor).
- POST /pairing (nur kind=desktop, sonst 403; ein neuer Code desselben Geräts bricht offene ab; max. 3 offene pro
  Konto; Limit 20/h pro Konto; Code über buddy_core::pairing, nur Hash speichern; url = public_origin + /pair#c=…).
- GET /pairing/{id}, DELETE /pairing/{id}: nur das erzeugende Gerät, sonst 404 (kein Orakel).
- POST /devices/pairing (kind mobile, Bearer-Antwort) und POST /session/pairing (Cookie, deviceId
  wiederverwenden wie POST /session, neue Sitzungs-ID, CSRF über den Guard aus Phase 0):
  - Code normalisieren, Hash suchen, in EINER Transaktion: Einlösen per bedingtem UPDATE (nicht abgelaufen,
    nicht abgebrochen, nicht eingelöst; genau 1 Zeile), Geräte-Limit, Gerät anlegen (created_via=pairing),
    redeemed_device_id setzen.
  - Fehler immer pairing_invalid (400); Fehlversuche zählen im IP-Limiter (10/10 min → 429).
  - Konto gesperrt → account_disabled.
- Logs: nie den Code, nur pairing-id und device-id.
Tests: Abnahme PLAN_V4 §13 Nr. 5–8, 11–13 (serverseitig), parallele Einlöse-Versuche (genau einer gewinnt),
Ablauf mit simulierter Uhr, Cross-Site, Limits, Geräte-Limit, gesperrtes Konto, Cascade beim Konto-Löschen.
Checks: cd server && cargo test && cargo clippy --all-targets -- -D warnings && cargo fmt --check.
```

### Phase N – Native App: Scanner und Server-Wahl (Subagent)

```text
Auftrag: native App gemäß PLAN_V4 §6.2 (native), §6.5 (native), §7.2, §9.2.
Ordner (exklusiv): mobile/ (ohne mobile/patches/), .github/workflows/mobile-*.yml.
Abhängig von Phase C (Oberfläche, contract-Schnittstellen QrScanner/ServerSelector).
Quellen: tauri-docs (plugin/barcode-scanner, Capabilities zur Laufzeit, iOS-Konfiguration/Info.plist),
Quellcode plugins-workspace/plugins/barcode-scanner (Android-Manifest, iOS NSCameraUsageDescription),
Android-Doku <uses-feature>, Apple-Doku NSCameraUsageDescription.
- mobile/src-tauri:
  - tauri-plugin-barcode-scanner =2.5.3 + @tauri-apps/plugin-barcode-scanner 2.5.3 (package.json in mobile/),
    Permission barcode-scanner:default in capabilities/main.json.
  - Commands server_get ({origin, defaultOrigin, isDefault}) und server_set(origin|null): Validierung mit
    server_url::normalize, nur ohne gespeichertes Token (Fehler „signed_in“), Speicherung app_config_dir/server.json
    (atomar schreiben), add_capability für die neue Origin. build.rs COMMANDS, Capability, Rust-Tests.
  - Standard-Origin: BUDDY_PUBLIC_URL, sonst https://buddy.pev-point.de (build.rs); shell_config.serverUrl =
    wirksame Origin (server.json vor Standard); beim Start genau eine HTTP-Capability.
  - iOS: NSCameraUsageDescription (Text PLAN_V4 §7.2) über den von Tauri 2 vorgesehenen Weg (tauri-docs prüfen,
    z. B. Info.ios.plist im src-tauri-Ordner); im iOS-CI-Build prüfen, dass der Schlüssel in der fertigen
    Info.plist steht.
  - Android: CAMERA aus dem Plugin; uses-feature camera.any möglichst required=false (Manifest-Merger prüfen,
    ehrlich berichten).
- mobile/src/main.tsx: QrScanner-Adapter über das Plugin (requestPermissions, scan QRCode, cancel),
  ServerSelector über server_get/set; nach server_set neu laden; ausstehenden Code (sessionStorage) nach dem
  Start einlösen (nur wenn < 3 min alt); Origin-Prüfung PLAN_V4 §9.2 (meta.account.serverUrl ≠ wirksame Origin
  bei vorhandenem Token → kein Sync, Hinweis).
- CI: BUDDY_PUBLIC_URL weiter aus der GitHub-Variable; ohne Variable baut CI mit dem Standard pev-point (Hinweis
  im Log); Emulator-Szenario „Code eingeben“ (Scanner gemockt) ergänzen, falls im Runner möglich.
- mobile/README.md: Server-Adresse (Standard + eigener Server zur Laufzeit), Kamera-Erlaubnis, QR-Anmeldung,
  Hinweis D-105 (FCM nur mit dem Firebase-Projekt des Server-Betreibers).
Tests: Rust (normalize/server.json/Fehler bei Token), Vitest (Scanner-Adapter mit gemocktem Plugin, Neustart-Fluss
mit ausstehendem Code, Origin-Abweichung); Builds in CI; ehrlich berichten, was nur in CI oder gar nicht lief.
Checks: npm test, npm run build:mobile, cd mobile/src-tauri && cargo test/clippy/fmt; Android-/iOS-Build (CI).
```

### Phase E – Betrieb und Anleitung (Subagent)

```text
Auftrag: Betrieb für Selbst-Hoster und für buddy.pev-point.de gemäß PLAN_V4 §11, §9.2.
Ordner (exklusiv): deploy/, docs/OPERATIONS.md (neu).
Abhängig von Phase A (Variablennamen).
- deploy/compose.yaml und compose.npm.yaml: neue Variablen (§11.2) mit Standardwerten für Selbst-Hoster
  (Registrierung closed, keine Kontingente), auskommentiert die pev-point-Werte; Docker-Log-Rotation
  (logging: json-file, max-size/max-file). .env.example nur Platzhalter.
- deploy/README.md (Deutsch, für Laien): Upgrade v3 → v4 (Registrierung bleibt aus, was neu ist), Registrierung
  einschalten (open/invite), Einladungscodes, Kontingente, Admin-Befehle (user list/show/disable/delete/quota/
  recovery, invite …), Rechtslinks, Abschnitt „Handy einrichten“ auf QR umstellen (Passwort als Alternative),
  „PC verbinden“ mit Standard-Server vs. eigener Server.
- docs/OPERATIONS.md (Deutsch): Betriebshandbuch für buddy.pev-point.de: Checkliste Recht (Impressum § 5 DDG,
  Datenschutzerklärung Art. 13 mit den Punkten aus PLAN_V4 §11.3, AV-Vertrag, Verzeichnis, TOMs – ausdrücklich
  „kein Rechtsrat“), Backups außerhalb des VPS (z. B. restic, inkl. vapid.pem und FCM-Dienstkonto,
  Rücksicherungstest), Überwachung (/api/v1/health, Platte, Zertifikat), Log-Aufbewahrung 7 Tage (Docker, NPM),
  Kosten, Firebase/VAPID-Zuständigkeit, Vorgehen bei Missbrauch (disable, invite-Modus), Update-Ablauf.
Prüfen: docker compose config für beide Compose-Dateien (wenn Docker verfügbar), Server-Start mit
Beispielvariablen; ehrlich berichten.
```

### Phase F – Integration (Orchestrator selbst)

```text
1. Alle Zweige integrieren; Wünsche aus den Berichten umsetzen.
2. Lokaler End-to-End-Aufbau wie v3 (HANDOFF §4): buddy-server mit Temp-DB und BUDDY_REGISTRATION=open,
   kleinen PoW-Bits und Kontingenten für Tests; Desktop unter Xvfb; PWA mit Playwright/Chromium
   (/pair#c=…, Code-Eingabe, Cross-Site-Versuch); native App im Android-Emulator in CI (Code-Eingabe).
3. Alle Abnahmeszenarien aus PLAN_V4 §13 (1–28) durchspielen und dokumentieren (Befehle, Screenshots, DB-Prüfungen).
   Nicht Automatisierbares (echte Kameras, iPhone, Windows-Skalierung, echter Server hinter NPM) als Handtest in
   docs/MANUAL_TESTS.md (§32 ff.).
4. Doku: HANDOFF (Stand v4, Lektionen), README, deploy/README, mobile/README, OPERATIONS.md gegenlesen.
5. Version 0.4.0 (package.json, Cargo.toml in src-tauri/server/mobile, tauri.conf.json beider Projekte),
   NSIS-Installer cross-bauen; APK aus CI holen. Alles als ZIP liefern.
6. Abschlussbericht (§4).
```

---

## 4. Vorlage Abschlussbericht (an den Benutzer, Deutsch)

```text
## v4 – Ergebnis
**Was neu ist** (5–8 Punkte, verständlich)
**Getestet** (Befehl → Ergebnis; Abnahmeszenarien 1–28 mit Status)
**Nur kompiliert / statisch geprüft** (z. B. iOS-Build ohne Gerät, Kamera-Scan ohne echte Kamera)
**Nicht prüfbar – bitte selbst testen** (Verweis auf MANUAL_TESTS v4: Android-Kamera, iPhone Kamera-App → /pair
und installierte PWA, native App per Xcode, Windows-Installer gegen buddy.pev-point.de)
**Entscheidungen** (neue D-Einträge, je ein Satz)
**Vor dem Start von buddy.pev-point.de zu erledigen** (DNS/NPM, Rechtstexte + URLs, Backups, Firebase/VAPID,
Variablen setzen)
**Bekannte Einschränkungen / nächste Schritte**
**Lieferung** (Installer-ZIP, APK, Anleitungen deploy/README.md, mobile/README.md, docs/OPERATIONS.md)
```
