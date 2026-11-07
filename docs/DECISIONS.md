# Entscheidungen (ADR-light)

**D-01 Styling: CSS Modules.** Keine zusätzliche Build-Abhängigkeit (Vite kann es nativ), Styles bleiben pro Komponente gekapselt. Tailwind wäre für die wenigen, sehr spezifischen Animationen kein Gewinn.

**D-02 React 18.3.1 statt 19.** Das Tauri-Template liefert React 19; der Auftrag schreibt React 18 verbindlich vor. TipTap 3 unterstützt beide.

**D-03 Ein HTML-Einstieg pro Fenster.** Das Buddy-Fenster lädt nur React + SVG (kein TipTap) → schneller Start, weniger RAM.

**D-04 TipTap 3 FontSize offiziell.** `@tiptap/extension-text-style` enthält seit v3 `FontSize`; keine eigene Extension nötig. Underline und ListKeymap sind in StarterKit 3 enthalten.

**D-05 Notiztitel als eigenes Eingabefeld** (nicht „erste Zeile“). Grund: Der Titel ist optional; mit eigenem Feld bleibt der Editorinhalt unverändert und der Titel lässt sich in Seitenkarten anzeigen, ohne den Inhalt zu parsen. Leerer Titel → Karte zeigt „Ohne Titel“.

**D-06 Eigene Positionsspeicherung statt `tauri-plugin-window-state`.** Die Position soll laut Auftrag in `settings.json` liegen und beim Start gegen die aktuellen Monitore geprüft werden (abgestöpselter Zweitmonitor). Das Plugin speichert in eine eigene Datei und kennt die Rücksetzregel „unten rechts“ nicht. Gespeichert werden physische Pixel.

**D-07 Autostart & globales Kürzel nur Rust-seitig.** Die Plugins werden ausschließlich aus Rust angesprochen (Tray-Checkbox, Commands `get_autostart`/`set_autostart`). Dadurch braucht kein Fenster Plugin-Permissions → minimale Capabilities. Die npm-Pakete der Plugins werden nicht benötigt.

**D-08 Pro-Fenster-Berechtigungen für App-Commands** über `tauri_build::AppManifest::commands` (build.rs). Jede Capability erlaubt nur ihre Commands.

**D-09 `save_settings` nimmt einen Patch** (JSON-Merge) statt des ganzen Objekts. Buddy-, Notiz- und Einstellungsfenster schreiben unterschiedliche Felder; ein Patch verhindert, dass ein Fenster mit veraltetem Stand die Änderungen eines anderen überschreibt.

**D-10 Kontextmenü des Buddys nativ** (`Window::popup_menu`). Ein HTML-Menü würde im 96-px-Fenster abgeschnitten.

**D-11 Anheften-Semantik.** Das Notizfenster ist immer im Vordergrund und bleibt standardmäßig bei Fokusverlust offen. Zusätzlich gibt es die Einstellung „Bei Fokusverlust ausblenden“ (Standard aus); „Anheften“ setzt diese für das Fenster außer Kraft.

**D-12 Fenstergröße des Buddys = Smiley-Größe.** Das Gesicht wird im SVG mit Innenabstand gezeichnet (Kreis ≈ 84 % der Fläche), damit Hover-Vergrößerung und Hüpfen nicht abgeschnitten werden.

**D-13 Beenden mit Flush-Handshake.** Rust sendet `flush-request` an das Notizfenster und beendet erst nach `flush_done` (max. 1,5 s). So gehen Eingaben der letzten 500 ms nicht verloren.

**D-14 `tauri-plugin-log` (2.10.1) zusätzlich.** Release-Builds haben keine Konsole; Fehler (z. B. `*.corrupt`-Quarantäne) müssen nachvollziehbar sein. Log nach stdout und `%LOCALAPPDATA%\de.displaybuddy.desktop\logs\` (max. 1 MB, 3 Dateien).

**D-15 Click-Through ist experimentell und standardmäßig aus** (Einstellung `clickThrough`). tao setzt dafür `WS_EX_TRANSPARENT | WS_EX_LAYERED` um; Nebenwirkungen (Flackern) konnten nicht unter Windows geprüft werden, und der Polling-Thread kostet CPU. Ausgeschaltet macht der Thread keine Fensteraufrufe.

**D-16 Autostart-Eintrag mit Anführungszeichen.** `auto-launch` 0.6 schreibt den Run-Wert ohne Quotes; der Installationspfad enthält ein Leerzeichen. Nach `enable()` (und beim Start) wird der HKCU-Wert gleichen Namens mit gequotetem Pfad überschrieben (`windows-registry`, ohnehin transitive Abhängigkeit).

**D-17 Cross-Build über `x86_64-pc-windows-gnu` (MinGW-w64).** In der Linux-Build-Umgebung ist der MSVC-CRT-Download (`aka.ms`) per Proxy-Policy gesperrt, daher kein `cargo-xwin`. Die GNU-Variante bündelt `WebView2Loader.dll` neben der EXE (der NSIS-Installer enthält sie). Für offizielle Releases wird ein Build auf Windows mit MSVC-Toolchain empfohlen (`npm run tauri build`).

**D-18 Ein Drag-Mechanismus in der Titelleiste.** Eigener `startDragging()`-Handler auf `[data-drag-region]`, nicht zusätzlich Tauris `data-tauri-drag-region`-Skript (sonst zwei native Drags pro Klick).

**D-19 Reihenfolge-Speicherungen werden serialisiert.** Async-Commands laufen in Rust parallel; zwei schnelle Umsortierungen könnten sonst in falscher Reihenfolge ankommen.

**D-20 Abmelden/Herunterfahren von Windows** (v1: bekannte Lücke, **in v2 geschlossen**, siehe D-22).

## v2

**D-21 Erinnerungen getrennt von Notizen** (`reminders.json`, eigener Rust-Scheduler). Das Notizfenster speichert ganze Notizen; läge der Erinnerungsstatus in der Notiz, könnte ein Autosave mit altem Stand ein „fällig/erledigt“ überschreiben. Rust ist alleiniger Besitzer.

**D-22 Flush bereits in `WM_QUERYENDSESSION`.** tao beendet den Prozess, sobald sein verstecktes Fenster `WM_ENDSESSION(TRUE)` erhält – die Reihenfolge der Fenster ist nicht garantiert. Deshalb startet der Buddy-Subclass schon bei `WM_QUERYENDSESSION` den Flush-Handshake, setzt `ShutdownBlockReasonCreate` und pumpt Nachrichten (max. 3 s), damit `flush_done` aus dem WebView ankommt.

**D-23 Lottie nur als `lottie_light`, dynamisch geladen.** Keine `eval`-Expressions (CSP bleibt streng), kein Web-Worker aus Blob. Eigener Chunk (≈ 170 kB), wird nur geladen, wenn ein Lottie-Skin gewählt ist.

**D-24 Native Dateiablage bleibt aktiv** (für Drag & Drop in die Shortcut-Leiste). Folge: HTML5-Drag-&-Drop von Dateien im WebView ist nicht verfügbar; Umsortieren in der Leiste ist zeigerbasiert implementiert.

**D-25 Shortcuts öffnen nur gespeicherte Einträge.** Das Frontend übergibt nur IDs, nie Pfade/URLs (`open_shortcut(id)`); URLs nur http/https. Kein Plugin-JS, keine Plugin-Permissions im Frontend (Fortsetzung von D-07).

**D-26 Skin-Import validiert Inhalt.** Dateiendung und Magic Bytes müssen passen; SVG mit `<script>`, `javascript:` oder `<foreignObject>` wird abgelehnt; Lottie muss die Pflichtfelder haben; max. 5 MB. Bilder werden als Data-URL in `<img>` angezeigt (Skripte in SVG würden dort ohnehin nicht laufen).

**D-27 Monatliche Wiederholung ohne Anker-Tag.** Das Modell speichert nur `at`; nach 31. → 28. Februar bleibt die Erinnerung auf dem 28. Ein `anchorDay`-Feld wäre die Erweiterung.

## v3 (geplant, siehe `docs/PLAN_V3_SYNC.md`)

Benutzerentscheidungen vom 2026-11-06: eigener Sync-/Relay-Server auf einem **VPS mit Domain**; Notizen am Handy
**lesen und bearbeiten**; **keine Ende-zu-Ende-Verschlüsselung**; Konflikte: **neueste Änderung gewinnt**.
Nachtrag am selben Tag: Web-App **installierbar** (Android/iOS), **offline** lokal speichern und bei Verbindung
automatisch synchronisieren; **Gerätezeitstempel** auf PC und Handy entscheiden.
Dritte Fassung: die App zeigt **Push selbst** (Web Push, ntfy entfällt); **native Hülle** (Tauri 2 Mobile), damit
synchronisierte Erinnerungen **auch ohne Internet** klingeln; **jede Erinnerung hat ihre eigene Zeitzone**.

**D-28 Eigener Server, Desktop bleibt local-first.** `buddy-server` (axum + SQLite) synchronisiert Notizen, plant Erinnerungen und sendet Push. Die Desktop-App funktioniert ohne Server unverändert; Sync ist optional und standardmäßig aus.

**D-29 Last-Writer-Wins pro Dokument** (Notiz, Erinnerung, Reihenfolge) nach `updatedAt`, Gleichstand → größeres `updatedBy`. Löschen ist ein Tombstone, der an LWW teilnimmt. Entscheidend ist der **Zeitstempel der Bearbeitung auf dem Gerät** (PC und Handy, siehe D-41); der Server stempelt nie um und klemmt nur Zeitstempel, die mehr als 2 min in der Zukunft liegen. Verlierer-Fassungen (überschrieben oder beim Hochladen abgelehnt) 30 Tage in `note_revisions`. TipTaps offizieller Weg für Zusammenführen wäre Collaboration/Yjs (CRDT) – bewusst nicht gewählt (Benutzerentscheidung; das Speicherformat müsste von TipTap-JSON auf Yjs-Dokumente umgestellt werden).

**D-30 Fällig-Werden ändert `updatedAt` nicht.** Nur Benutzeraktionen (setzen, erledigen, verschieben, entfernen) zählen als Bearbeitung. Sonst könnte ein PC, der offline nachfeuert, eine am Handy erledigte Erinnerung wieder „fällig“ machen.

**D-31 Push über Web Push und native Kanäle statt ntfy** (dritte Fassung, Benutzerwunsch: „die App zeigt Push selbst“). Der Server sendet pro Gerät: Web Push (VAPID, RFC 8030/8291) an die PWA, deren Service Worker die Benachrichtigung selbst anzeigt; die native Hülle plant lokal und bekommt nur bei Bedarf einen nativen Push (D-48). Die Desktop-App sendet nie Push. Höchstens eine Nachricht pro Gerät und Vorkommen über `push_log(device_id, note_id, at)`. ntfy entfällt vollständig (weniger Dienste, keine Abhängigkeit von ntfy.sh für iOS).

**D-32 Der Server plant Erinnerungen selbst** (Wiederholungen, Erledigt/Verschieben und Sync-Zustand liegen dort) und stößt den Versand zur fälligen Zeit an. Web Push wird mit `TTL: 86400`, `Urgency: high` und `Topic` je Notiz gesendet (Apple-Doku): Ist das Gerät offline, liefert der Push-Dienst nach; eine ältere, noch nicht zugestellte Nachricht derselben Erinnerung wird ersetzt.

**D-33 Knöpfe in Benachrichtigungen laufen auf dem Gerät** (PWA: `notificationclick` im Service Worker, nur Chromium/Firefox laut browser-compat-data; native Hülle: Tauri-Aktionen) über die Datenschicht mit Outbox – damit auch offline. Die zuvor geplanten signierten Aktions-URLs entfallen.

**D-34 Web-App als installierbare, offline-first PWA** (Benutzerwunsch): eigener Vite-Einstieg (`web.html` → `src/web/`), dieselben TipTap-Extensions wie am Desktop (TipTap-Doku: Schema-Parität). Installierbar laut MDN (Manifest mit name/short_name, Icons 192+512, start_url, display standalone; HTTPS). Service Worker über vite-plugin-pwa mit **`injectManifest`** (eigener `src/web/sw.ts` für `push`/`notificationclick`, Precache über `workbox-precaching`), `registerType: 'prompt'`, `injectRegister: null` (kein Inline-Skript, CSP bleibt streng). Daten in IndexedDB über `idb` mit Outbox; die Oberfläche liest nur lokal.

**D-35 Gemeinsames Crate `crates/buddy-core` ohne Cargo-Workspace.** Path-Dependency aus `src-tauri` und `server`; Tauri-Build, `target/` und MinGW-Cross-Build bleiben unverändert. `model.rs` re-exportiert die verschobenen Typen.

**D-36 Desktop-HTTP über `tauri_plugin_http::reqwest`, nur Rust-seitig** (offizieller Tauri-Weg laut Doku „HTTP Client“; Fortsetzung von D-07, keine JS-Permissions). TLS-Backend muss mit `x86_64-pc-windows-gnu` bauen.

**D-37 Geräte-Token im Windows-Anmeldeinformationsspeicher** (`keyring-core` + Windows-Store-Crate, wie im keyring-rs-README für Anwendungen empfohlen), nie in `settings.json`.

**D-38 Web-Login nach OWASP:** Argon2id (mind. 19 MiB, t=2, p=1), Cookie `__Host-buddy_session; Secure; HttpOnly; SameSite=Strict; Path=/`, serverseitige Sessions; CSRF über `Sec-Fetch-Site` mit Origin-Fallback plus Custom-Header `X-Buddy-Request`.

**D-39 Jede Erinnerung hat ihre eigene IANA-Zeitzone** (`Reminder.timeZone`, Benutzerentscheidung der dritten Fassung): Standard ist die Zone des Geräts beim Anlegen, änderbar. Wandzeit und Wiederholung gelten in dieser Zone – auf PC, Server und Handy gleich (`chrono-tz` bzw. `src/lib/zoned.ts`); „jetzt“, Zeitstempel und LWW sind UTC. Die Erinnerung klingelt überall im selben Moment; jedes Gerät zeigt seine Ortszeit plus Originalzeit. „Schwebende“ Ortszeit pro Gerät wurde verworfen (bei Geräten in verschiedenen Zonen mehrdeutig, mehrfaches Klingeln). Altdaten ohne Zone: PC füllt seine Zone, Server nutzt `users.time_zone`.

**D-40 Betrieb: VPS + Docker Compose + Caddy** (automatisches HTTPS laut Caddy-Doku), eine Subdomain `buddy.<domain>`, nur Caddy veröffentlicht Ports; VAPID-Schlüssel per `buddy-server vapid generate` im Daten-Volume (mitsichern).

**D-41 Gerätezeitstempel mit Uhr-Korrektur** (Nachtrag, Benutzerwunsch). `updatedAt` setzt das Gerät, auf dem bearbeitet wird – sofort beim lokalen Speichern, auch offline – als korrigierte Gerätezeit: Gerätezeit + Median der letzten 5 gemessenen Abweichungen zur Serveruhr (`serverTime` jeder Antwort, RTT/2 abgezogen, nur RTT < 5 s). Offline gilt der letzte bekannte Wert. Eine späte Offline-Änderung behält ihren frühen Zeitstempel und verliert deshalb korrekt gegen eine inzwischen neuere Änderung. Hybrid Logical Clocks wären robuster gegen falsche Uhren, sind aber für einen Benutzer mit NTP-synchronisierten Geräten unnötig komplex.

**D-42 LWW, Uhr-Korrektur und Erinnerungsmathe doppelt (Rust + TypeScript) mit gemeinsamen Testvektoren** (`crates/buddy-core/tests/fixtures/*.json`, von `cargo test` und Vitest gelesen). Die Web-App muss offline entscheiden und rechnen können (z. B. „Erledigt“ bei einer Wiederholung); WebAssembly aus `buddy-core` wäre die Alternative, vergrößert aber Build und CSP-Anforderungen (`wasm-unsafe-eval`).

**D-43 Ein Schreibweg: `/sync/push`.** Keine CRUD-Endpunkte mit Serverzeit, damit PC und Web-App denselben Regeln folgen und Offline-Änderungen nicht anders behandelt werden als Online-Änderungen. `/sync/push` ist idempotent (Wiederholung nach Verbindungsabbruch ist sicher).

**D-44 Sync der Web-App ohne Background Sync.** Laut browser-compat-data gibt es `SyncManager` nur in Chromium (nicht Safari, nicht Firefox). Ausgelöst wird deshalb beim Start, bei `online`, bei `visibilitychange`, alle 60 s sichtbar und nach Änderungen; `navigator.onLine` nur als Hinweis (MDN: unzuverlässig). Background Sync höchstens als optionale Ergänzung. Parallele Läufe mehrerer Tabs verhindert die Web Locks API (Safari ≥ 15.4), Änderungen verteilt `BroadcastChannel`.

**D-45 iOS: Installation empfohlen, Speicher-Persistenz anfragen.** Safari löscht per Skript angelegte Daten nach 7 Tagen ohne Interaktion (MDN); Web-Apps auf dem Home-Bildschirm sind laut WebKit ausgenommen. Die App zeigt unter iOS deshalb deutlich den Installationshinweis und ruft nach dem Login `navigator.storage.persist()` auf. Gefährdet sind ohnehin nur nicht synchronisierte Änderungen.

**D-46 Web Push: Apples Regeln sind maßgeblich.** Erlaubnis nur aus einer Nutzergeste anfragen; jeder Push zeigt sofort eine Benachrichtigung (keine unsichtbaren Pushes, sonst entzieht Safari die Erlaubnis); Payload ≤ 4 KB; VAPID-JWT höchstens 24 h gültig und nicht öfter als stündlich erneuert; 404/410 → Abo löschen. Unter iOS (≥ 16.4) nur für installierte Home-Bildschirm-Apps; ohne `pushsubscriptionchange`, `notificationclick`, `actions` und `tag` (browser-compat-data) → Abo-Abgleich bei jedem Start, fällige Erinnerungen mit Knöpfen in der App. Server-Bibliothek `web-push` (0.11) mit eigenem reqwest-Client über `request_builder`.

**D-47 Native Hülle mit Tauri 2 Mobile für Benachrichtigungen ohne Internet** (Benutzerentscheidung). Eine Web-App kann ohne Netz nicht zu einer festen Zeit benachrichtigen: Notification Triggers (`TimestampTrigger`) sind eingestellt und nicht mehr in browser-compat-data, Periodic Background Sync gibt es nur in Chromium ohne garantierte Zeit. Die Hülle nutzt dieselbe Oberfläche, Datenschicht und Sync-Engine und plant alle synchronisierten Erinnerungen über das offizielle `tauri-plugin-notification` (`Schedule.at`, Android AlarmManager mit `allowWhileIdle`, iOS `UNTimeIntervalNotificationTrigger` = absoluter Zeitpunkt). Eigenes Tauri-Projekt unter `mobile/`, damit Windows-Code und Desktop-Fenster unberührt bleiben. iOS-Builds brauchen macOS/Xcode; dauerhafte Installation das Apple Developer Program.

**D-48 Native Push nur zum Aufwecken, mit Dedupe über `scheduled_seq`.** Die Hülle meldet nach jeder Planung, bis zu welchem Sync-Stand sie alle Erinnerungen lokal geplant hat. Der Server schickt ihr nur dann FCM/APNs, wenn sie die aktuelle Fassung einer fälligen Erinnerung noch nicht geplant hat oder lokale Benachrichtigungen verweigert sind – sonst klingelt die lokale Planung und ein Push würde sie verdoppeln. Phase N2 nur nach Zustimmung des Benutzers (Firebase/APNs-Zugänge, Community-Plugin oder eigenes Mobile-Plugin).

**D-49 Zeitzonenrechnung in TypeScript über `Intl`, nicht `Temporal`.** `Temporal.ZonedDateTime` gibt es laut browser-compat-data in Chrome 144 und Firefox 139, in Safari nur als Preview. `src/lib/zoned.ts` nutzt `Intl.DateTimeFormat` mit `timeZone`/`formatToParts` (überall verfügbar) und muss dieselben Vektoren bestehen wie `chrono-tz`; Tests zusätzlich unter `TZ=America/New_York` und `TZ=Asia/Tokyo`. Nur das handelnde Gerät rechnet ein neues `at`, alle anderen übernehmen den absoluten Zeitpunkt – unterschiedliche tzdata-Stände können so nicht auseinanderlaufen.

**D-50 Bekannter Prüfpunkt im iOS-Plugin:** `plugins/notification/ios/Sources/Notification.swift` parst das `…Z`-Datum mit einem `DateFormatter` ohne gesetzte UTC-Zeitzone (Android parst in UTC). Vor Freigabe auf Gerät/Simulator in mehreren Zonen prüfen; bei Abweichung Issue suchen/anlegen und eine getestete Umgehung dokumentieren.


## v3 – Umsetzung (Phase 0, 2026-11-06)

Benutzerantworten vor N1/N2 (Multiple-Choice, 2026-11-06): **eigener Mac** für iOS-Builds, **kein Apple Developer
Program** (vorerst), **Phase N2 nur für Android (FCM)**.

**D-51 Versionen v3** (geprüft am 2026-11-06 mit `cargo info` / crates.io-API / `npm view`; stabile Linien, keine
Alphas – die Tauri-Plugins haben parallel 3.0.0-alpha-Linien, die wir **nicht** nehmen):

| Paket | Version | Bemerkung |
|---|---|---|
| sqlx | 0.9.0 | stabil seit 2026-05 (Feature `sqlite`, `migrate`) |
| web-push | 0.11.0 | `default-features = false` (kein isahc); `ece` 2.4 mit OpenSSL-Backend → D-56 |
| axum / tower / tower-http | 0.8.9 / 0.5.3 / 0.7.1 | |
| argon2 | 0.6.0 | |
| chrono-tz / iana-time-zone | 0.10.4 / 0.1.65 | auch in `buddy-core` bzw. `src-tauri` |
| reqwest (Server direkt) | 0.13.5 | Standard-TLS ist `default-tls`; Server wählt rustls explizit |
| tauri-plugin-http (Rust + `@tauri-apps/plugin-http`) | 2.8.3 | Desktop nur Rust-seitig |
| tauri-plugin-notification (+ npm) | 2.8.0 | Desktop unverändert, Hülle mit JS |
| keyring-core / windows-native-keyring-store | 1.0.1 / 1.1.0 | D-53 |
| apple-native-keyring-store / android-native-keyring-store | 1.0.2 / 1.0.0 | Kandidaten für N1 |
| vite-plugin-pwa | 2.0.0 | Peer `vite ^8` ausdrücklich unterstützt |
| workbox-precaching / workbox-window | 7.4.1 | |
| idb / fake-indexeddb | 8.0.4 / 6.2.7 | fake-indexeddb nur für Tests |

**D-52 reqwest-TLS unter MinGW geprüft.** `tauri-plugin-http` 2.8.3 aktiviert standardmäßig `rustls-tls`; `cargo tree`
zeigt das **ring**-Backend (`reqwest/__rustls-ring`, kein aws-lc-rs, das cmake/nasm bräuchte). Ein Probe-Crate mit
`tauri-plugin-http` + `keyring-core` + `windows-native-keyring-store` baut als Release für `x86_64-pc-windows-gnu`
(1 min 41 s) ohne Zusatzwerkzeuge. Standard-Features beibehalten, aws-lc nicht einschalten.

**D-53 Token-Speicher Desktop:** `keyring-core` 1.0.1 mit `windows-native-keyring-store` 1.1.0 (baut mit MinGW,
D-52), hinter einem Trait; unter Linux (Tests, Smoke-Test) ein In-Memory-Store. Für die Hülle prüft N1
`apple-native-keyring-store`/`android-native-keyring-store`; sonst ein offizielles Tauri-Plugin (begründen).

**D-54 Mobile-Builds außerhalb der Cloud.** Der Download des Android-SDK von `dl.google.com` ist in der
Cloud-Umgebung per Proxy-Policy gesperrt (403 auf CONNECT, nicht umgangen); Maven Central/Google Maven/Gradle sind
erreichbar, reichen aber nicht. Android wird deshalb über **GitHub Actions** (`ubuntu-latest`) gebaut. iOS baut der
Benutzer **auf seinem Mac** (Xcode, kostenloses Apple-Konto, 7-Tage-Signatur); ein `macos-latest`-Workflow baut nur
unsigniert zur Kontrolle.

**D-55 Nativer Push nur Android (FCM)** (Benutzerentscheidung). APNs wird nicht umgesetzt; der Kanal bleibt als Trait
(`NativePushChannel`) erweiterbar. iOS verlässt sich auf die lokale Planung nach jedem Sync/Start/Fortsetzen.

**D-56 OpenSSL nur im Server.** `web-push` 0.11 verschlüsselt über `ece` mit OpenSSL-Backend (kein Rust-Backend
verfügbar). Das betrifft nur den Linux-Server (Docker-Image mit `libssl3`), nicht den Windows-Desktop. Docker ist in der
Cloud-Umgebung verfügbar (dockerd 29.9.2) → Phase E kann das Image wirklich bauen.

**D-57 Format der Zeitpunkte.** Neue Schreibvorgänge verwenden `YYYY-MM-DDTHH:MM:SS.sssZ` (`zoned::format_utc` bzw.
`toISOString()`); Altdaten mit Offset (`+01:00`) bleiben unverändert, bis sie bearbeitet werden. Verglichen wird
überall als Zeitpunkt (`parse_instant`), nie als Text. Bekannte Eigenheit (wie D-27): Liegt ein Vorkommen in einer
Sommerzeit-Lücke (02:30 → 03:00), speichert `ack` 03:00, und die folgenden Vorkommen bleiben bei 03:00.

**D-58 LWW-Reihenfolge exakt:** `updatedAt` als Zeitpunkt (unlesbar = ältester), bei Erinnerungen dann Zustand
`scheduled < due < done` (Fällig-Werden ändert `updatedAt` nicht, D-30), dann `updatedBy`, vollständiger Gleichstand →
lokal bleibt (Echo). Die Zukunfts-Klemme gibt gültige Zeitstempel **wörtlich** zurück und ersetzt nur solche > 2 min
nach Serverzeit.

**D-59 Drei unabhängige Implementierungen prüfen die Zeitzonenmathe.** `schedule_vectors.json` (24 Wandzeit-, 25
Anzeige-, 136 Wiederholungs-, 27 Erledigt-Fälle in Berlin, New York, Tokio, Lord Howe, Kolkata inkl. EU/US-Zwischenwochen,
Lücken und Doppelungen) wird von `gen_schedule_vectors.py` mit Pythons `zoneinfo` erzeugt; einige Fälle sind von Hand
festgelegt und im Generator geprüft. `chrono-tz` (Rust) und `Intl`/ICU (TypeScript, auch unter `TZ=America/New_York`
und `TZ=Asia/Tokyo`) bestehen alle Fälle.

**D-60 Uhr-Median:** gerade Anzahl → Mittelwert der beiden mittleren Werte, **zur Null hin abgeschnitten** (Rust `/`,
TS `Math.trunc`); `clock_vectors.json` prüft das. Am Desktop hält `src-tauri/src/clock.rs` den Offset (Atomic,
Standard 0); das Sync-Modul setzt ihn, `reminders` stempelt mit `clock::corrected_now()`.

**D-61 `set_reminder(timeZone)`:** `timeZone = null` behält die Zone einer bestehenden Erinnerung, neue Erinnerungen
bekommen die PC-Zone (`iana-time-zone`, unbekannt → UTC mit Warnung); ein unbekannter Zonenname ist ein Fehler. Der
Command ist in Phase 0 schon Rust-seitig umgesetzt (sonst wäre der Vertragstest rot); Phase B baut das Popover.

**D-62 Sync-Einstellungen sind geschützt.** `syncEnabled`, `syncServerUrl`, `syncDeviceName` werden von
`save_settings` ignoriert (wie `autostart`) und nur von `sync_connect`/`sync_disconnect` geändert.

**D-63 Feinheiten des Sync-Protokolls** (verbindlich in `crates/buddy-core/src/sync.rs` + `src/lib/sync/types.ts`,
Beispiele in `api_examples.json`): Cursor ist die ganze Zahl `seq`; `/sync/push` antwortet je Datensatz mit `applied`
(auch identische Wiederholung), `stale` (Serverfassung neuer; sie steht im Feld `note`/`reminder`/`order` der Antwort,
weil ein Pull sie nicht erneut liefert, wenn der Cursor schon dahinter liegt) oder `invalid`; geklemmte Zeitstempel
meldet `clampedUpdatedAt`. Tombstones haben `deleted: true` und `note`/`reminder: null`. Fehler-Codes in
`error_codes` (u. a. `full_resync_required` für 410).

**D-64 ICU-Zonennamen:** `Intl.supportedValuesOf('timeZone')` liefert kanonische ICU-Namen (z. B. `Asia/Calcutta`
statt `Asia/Kolkata`). Beide Schreibweisen sind gültig; chrono-tz kennt die Alias-Namen ebenfalls. Gespeichert wird,
was der Benutzer wählt bzw. was das Gerät meldet.

**D-65 Kein `cdylib` im Desktop-Crate.** Mit den v3-Abhängigkeiten (reqwest/rustls/ring, keyring) überschreitet die `display_buddy_lib.dll` beim MinGW-Cross-Build auch im Release die 65535 Export-Ordinals („export ordinal too large“). Die DLL braucht nur Tauri Mobile; die Desktop-EXE linkt das `rlib`. `crate-type = ["staticlib", "rlib"]`.

## v3 – Entscheidungen aus den Phasen A–E, N1 (2026-11-06)

**D-66 Server-CSRF (A):** gilt für unsichere Methoden mit Session-Cookie ohne Bearer sowie für `POST /session`
(Login-CSRF). `Sec-Fetch-Site` darf nur `same-origin`/`none` sein (strenger als der Plan: auch `same-site` wird
abgelehnt, weil die PWA immer von derselben Origin kommt); fehlt der Header, muss `Origin` = `BUDDY_PUBLIC_URL` sein;
`X-Buddy-Request: 1` ist immer Pflicht. Bearer-Anfragen sind ausgenommen (fremde Seiten können `Authorization`
ohne CORS-Preflight nicht setzen; der Server erlaubt kein CORS). Quelle: OWASP CSRF Prevention Cheat Sheet.

**D-67 Login-Bremse (A):** pro (IP, Benutzer) 5 Fehlversuche frei, dann 30 s, verdoppelt bis 15 min, 429 mit
`Retry-After` (Passwort wird dann nicht geprüft), Erfolg setzt zurück, nach 24 h vergessen. `X-Forwarded-For`
(letzter Eintrag) gilt nur von Adressen in `BUDDY_TRUSTED_PROXIES`; Compose gibt Caddy dafür eine feste Adresse
(D-75). Quelle: OWASP Authentication Cheat Sheet.

**D-68 Sitzungen und Geräte (A):** `DELETE /session` widerruft das web-Gerät samt Push-Abo (die PWA löscht beim
Abmelden ihre lokale DB). Sitzung 30 Tage, Verlängerung höchstens stündlich und nur bei `/sync/*`. `user passwd`
beendet alle Web-Sitzungen, mit `--revoke-devices` auch alle Tokens. Passwörter nur über Terminal/stdin.

**D-69 Cursor- und Klemmen-Details (A):** 410 auch bei `since > users.seq` (DB zurückgesetzt/Restore); `since=0`
geht immer. Die Zukunfts-Klemme wirkt auch auf `note.updatedAt`/`reminder.updatedAt` im Inhalt; gemeldet wird
`clampedUpdatedAt`. Der Server füllt fehlende Zonen **nicht** auf (er ändert keine Gerätedaten), sondern rechnet mit
`effective_zone` (Erinnerung → Konto → UTC). Einzige Server-Stempelung: CLI `restore` (`updatedBy = "server-restore"`).

**D-70 VAPID-Schlüssel als PKCS#8-PEM** (A, D): `vapid generate` schreibt 0600; `web-push` 0.11 liest PKCS#8
(`read_pem`), per Test mit dem erzeugten Schlüssel bestätigt (D).

**D-71 Web-Datenschicht (C1):** Zeitstempel pro Dokument **streng steigend** (`nextStampMs`): Zwei Bearbeitungen in
derselben Millisekunde bekämen sonst denselben Stempel, den der Server als Echo verwirft (D-58). Tombstones bleiben
lokal für LWW. Die Engine erreicht Cursor/Outbox/Merge über `syncAccess(store)` (WeakMap, nicht im UI-Vertrag).
Startstatus `idle` statt `signedOut`, bis das Konto gelesen ist (kein Flackern zur Login-Seite). Auf eine belegte
Web Lock wird gewartet (kein Auslöser geht verloren). Pull-Größe 200. Lokal gestempelte Outbox-Einträge werden nach dem
Login auf die Server-`deviceId` umgeschrieben; anderer Benutzer → `account_mismatch`.

**D-72 PWA-Build (C2):** zusätzlich `workbox-routing` 7.4.1 (für `NavigationRoute`, laut vite-pwa-Doku). Unter
Rolldown (Vite 8) wird `web.html` per `delete` + `emitFile` zu `index.html`. `includeManifestIcons: false` gegen
doppelte Precache-Einträge. Service-Worker-Typen über `/// <reference lib="webworker" />`.

**D-73 Benachrichtigungen in der PWA (C2), nach browser-compat-data 8.1.8:** Pflicht nur `push` +
`showNotification`; `actions` nur bei `Notification.maxActions ≥ 2`; `tag`/`data`/`navigate` werden mitgegeben
(Unbekanntes ignoriert WebIDL); `notificationclick`-Aktionen wirken nur, wenn die Erinnerung noch beim gemeldeten
`at` steht (eine veraltete Benachrichtigung überspringt kein Vorkommen). Der Wunsch „Push an“ liegt in
`localStorage` (`buddy.push.wanted`), weil der DataStore-Vertrag dafür nichts vorsieht und der Service Worker ihn nicht
braucht. `DELETE /push/subscription` mit Body `{endpoint}`.

**D-74 Server-Push (D):** Vor jedem Versand wird `push_log` mit `pending` reserviert, danach `sent`/`gone`/`failed`;
nach Neustart werden offene `pending` neu versendet (solange < 24 h) → genau einmal pro Gerät und Vorkommen. VAPID-JWT
12 h gültig, höchstens stündlich neu. reqwest 0.13.5 mit `rustls-no-provider` + rustls 0.23.46 (ring), keine
Weiterleitungen. Neue Spalte `reminders.at_seq` (Migration 0002, per Trigger): ändert sich nur, wenn sich der Termin
ändert – mit `seq` würde schon das Fällig-Werden einen nativen Push auslösen und die lokale Benachrichtigung doppeln.
Push-Endpunkte nur `https` mit DNS-Namen (keine IP/localhost), `p256dh` muss ein gültiger P-256-Punkt sein.
`web-push` zieht OpenSSL in das Server-Binary (D-56) – das Image enthält `libssl`.

**D-75 Deployment (E):** Dockerfile mit drei Stufen (Web-Build, `cargo build --release --locked`, Debian trixie slim),
Basis-Images mit Tag + Digest, UID 10001, `/data`-Volume, HEALTHCHECK über `curl` auf `/api/v1/health`. Compose:
eigenes Netz 172.30.0.0/24, Caddy fest auf 172.30.0.10 außerhalb des automatisch vergebenen Bereichs
(172.30.0.128/25), `BUDDY_TRUSTED_PROXIES` nur Caddy; buddy `read_only`, `cap_drop: ALL`, `no-new-privileges`.
Caddy: HSTS ohne `preload`, Cache-Header des Servers unverändert.

**D-76 Patch für `tauri-plugin-notification` 2.8.0 (N1).** Quellcode-Befund (§10.4, D-50) bestätigt und erweitert:
(1) iOS-`DateFormatter` ohne Zeitzone → Erinnerung um den Zonenversatz verschoben; (2) iOS-Absturz bei
Benachrichtigungen aus einem früheren App-Start (`notificationsMap[...]!`); (3) Rust sendet 9 Nachkommastellen, die
Parser erwarten 3; (4) Android verliert Aktionen beim Kaltstart. (5) Android `show` speicherte geplante Benachrichtigungen nicht (nur `batch` tat das) → `getPending()` leer und nach einem Neustart des Geräts keine Wiederherstellung der Alarme; gefunden über die Emulator-Diagnose (Alarm gesetzt, Pending-Liste leer). (6) `sourceJson` wurde nirgends gesetzt: gespeichert wurde der Text `"null"`, `getPending()` scheiterte daran (auch bei `batch`); jetzt die Roh-Argumente der Anfrage, unlesbare Einträge werden übersprungen. Die unveränderte Kopie liegt in
`mobile/patches/tauri-plugin-notification` (erster Commit), der Fix im zweiten Commit, eingebunden per
`[patch.crates-io]`. Entfernen, sobald upstream behoben. Ein Upstream-Issue ist noch nicht angelegt (GitHub-Zugriff
auf plugins-workspace fehlte in der Sitzung).

**D-77 Exakte Alarme ohne eigenen Kotlin-Code (N1):** `USE_EXACT_ALARM` plus `SCHEDULE_EXACT_ALARM` (bis Android 12L)
laut Android-Doku „Schedule alarms“ für Erinnerungs-Apps. Verteilung per Sideload; bei Google Play wäre das eine
Richtlinienfrage.

**D-78 Token in der Hülle über keyring-Stores (N1):** iOS `apple-native-keyring-store` 1.0.2 mit `protected`
(after-first-unlock), Android `android-native-keyring-store` 1.0.0 (tao initialisiert `ndk-context`). Kein Zusatz-Plugin.

**D-79 Weitere Hüllen-Details (N1):** `gen/android`/`gen/apple` werden in CI erzeugt (nicht eingecheckt; lokal ohne
SDK nicht erzeugbar, D-54); Build-Ausgabe `mobile/dist` statt `dist-mobile/`; Android-WebView mit
`https://tauri.localhost` (fester IndexedDB-Ursprung); HTTP-Scope zur Laufzeit nur `<BUDDY_PUBLIC_URL>/api/v1/*`;
`buddy-core` wird in der Hülle nicht eingebunden (Logik in TypeScript). IndexedDB bleibt die Speicherung; ob sie in
WKWebView/Android-WebView dauerhaft hält, ist ein Gerätetest (sonst `tauri-plugin-sql`). Höchstens 60 geplante
Benachrichtigungen (iOS-Grenze 64), weitere beim nächsten Sync/Öffnen.

**D-80 Bekannter wackeliger Test:** ein bestehender Buddy-Skin-Test („falls back to the smiley … for an unknown id“)
schlug einmal unter hoher Last (vier parallele Agenten) fehl und war in drei Wiederholungen grün. Unter Beobachtung.

**D-81 Native App fragt die Benachrichtigungs-Erlaubnis selbst an.** Unter Android 13+ (`POST_NOTIFICATIONS`)
und iOS startet die App ohne Erlaubnis; bisher fragte sie nur beim Tipp auf „Benachrichtigungen aktivieren“, und
ohne Erlaubnis plant sie nichts – Erinnerungen blieben auf echten Geräten still (der Emulator-Test hatte die Erlaubnis
per `adb pm grant` vorab erteilt). Jetzt fragt die App nach dem Anmelden einmal pro App-Start von selbst (bei nativen
Apps ohne Nutzergeste erlaubt; die Web-Push-Regel D-46 gilt nur für die PWA), außer der Benutzer hat
Benachrichtigungen in der App ausgeschaltet.

**D-82 Zähler „Änderungen warten“ liest nach jedem Sync neu.** Ein erfolgreicher Push leert die Outbox ohne
Datenänderungs-Ereignis; die Statuszeile nahm das Maximum aus Engine-Zähler und einem nur auf Datenänderungen
hörenden UI-Zähler und zeigte deshalb dauerhaft „1 Änderung wartet“ (PWA und native App).

**D-83 Android-Build (Beitrag des Benutzers):** Build-Tools 36.1.0 und API 37 (Tauri erzeugt `compileSdk`/`targetSdk`
37), gesetzt per `mobile/scripts/android-build-tools.mjs` nach `tauri android init`; Rust-Bibliothek mit 16-KB-Seiten
gelinkt (`build.rs`, für Android 15+; NDK r28+ macht das von selbst).

**D-84 Android-Empfänger des Notification-Plugins lesen `extra` selbst (Fix an D-76).** Seit D-76 speichert das Plugin
geplante Benachrichtigungen; `TimedNotificationPublisher` las sie mit einem nackten `ObjectMapper()` zurück, der das
`JSObject`-Feld `extra` nicht füllen kann (`UnrecognizedPropertyException: "at"`). Der Empfänger stürzte ab, bevor
`notify()` lief – **keine Erinnerung kam an** (gefunden per `adb logcat`, „Unable to start receiver“). Neu:
`NotificationMapper.kt` (Deserializer für `JSObject`, unbekannte Felder ignoriert) in allen Empfängern und im Plugin;
`getSavedNotification` fängt jeden Lesefehler ab, die Benachrichtigung selbst kommt mit dem Alarm und wird immer gezeigt.

## v4 (geplant, siehe `docs/PLAN_V4_ACCOUNTS.md`) – Vorschläge

Benutzerentscheidungen vom 2026-11-07 (Multiple-Choice): Registrierung auf dem öffentlichen Server **offen mit
Schutz**; **keine E-Mail**; Passwort vergessen über **Wiederherstellungscode + angemeldetes Gerät**; **E2E später,
v4 bereitet vor**; **keine Bestätigung am PC** beim QR-Anmelden; **Passwort-Login am Handy bleibt** als Alternative;
Konto **sofort** löschen (mit Passwort); **moderate Kontingente** (50 MB, 5 000 Notizen, 10 Geräte); Admin **nur
CLI**; Registrierung **nur am Desktop**; am Desktop ein **einmaliger Hinweis** statt Assistent.

**D-85 Kurswechsel: mehrere Konten und ein öffentlicher Standard-Server.** Die v3-Annahme „ein Benutzerkonto,
private Verteilung“ und das Nicht-Ziel „mehrere Benutzerkonten“ (PLAN_V3_SYNC §1, §15) entfallen. Die Datenbank ist
schon mandantenfähig (`user_id` + `ON DELETE CASCADE`, `foreign_keys` an – im Code geprüft), deshalb nur eine
additive Migration `0003_accounts.sql`. D-28 bleibt: Der Desktop ist ohne Konto voll nutzbar, Sync ist optional.
App-Store-Vertrieb bleibt Nicht-Ziel.

**D-86 Registrierung nur am Desktop, Modus per Server-Schalter.** `BUDDY_REGISTRATION=open|invite|closed`, Standard
**`closed`**: Ein Selbst-Hoster, der v3 → v4 aktualisiert, öffnet seinen Server damit nicht versehentlich. Die
pev-point-Konfiguration setzt `open`. `POST /accounts` legt Konto und Desktop-Gerät in einer Transaktion an. Die CLI
`user add` bleibt.

**D-87 Missbrauchsschutz ohne Drittanbieter.** Proof-of-Work: SHA-256 über 16 Zufallsbytes + u32-Nonce, Standard
22 führende Null-Bits (≈ 4 Mio. Hashes, am PC ≈ 0,3 s). Lösen und Prüfen stehen einmal in `buddy-core::pow`;
gelöst wird im Desktop-Rust. Dazu Limits pro IP (10 Challenges/h, 3 Registrierungen/h, 10/Tag), global 200/Tag,
Kontingente. Kein Captcha: Captchas brauchen Drittanbieter (Datenschutz) und sind schlecht barrierefrei. PoW ist
eine Bremse, keine Mauer; die eigentliche Absicherung sind Kontingente, Tageslimit und der Schalter
`invite`/`closed`.

**D-88 Benutzername statt E-Mail; Regeln nach OWASP/NIST SP 800-63B.** Neue Namen `^[a-z0-9][a-z0-9._-]{2,31}$`,
eindeutig ohne Groß/Klein (Spalte `NOCASE`), Liste reservierter Namen, kein `@`. Passwort 12–1024 Zeichen bzw.
Bytes ohne Kompositionsregeln. Abgelehnt werden Passwörter, die gleich dem Benutzernamen sind oder in einer
mitgelieferten Liste häufiger Passwörter stehen (offline, kein Online-Abgleich). Alte CLI-Namen bleiben gültig.

**D-89 Passwort vergessen: Wiederherstellungscode als Vertrauensanker, dazu angemeldete Geräte.**
- Der Code hat 120 Bit (24 Zeichen Crockford-Base32) und wird nur als SHA-256 gespeichert (hohe Entropie wie
  Tokens). Er wird nur einmal angezeigt. Nach `POST /accounts/recover` ist er verbraucht, und ein neuer wird
  ausgegeben; `recover` meldet alle Geräte und Sitzungen ab.
- Ohne das alte Passwort darf nur ein `desktop`- oder `mobile`-Gerät, das mindestens 24 h alt ist, ein neues
  Passwort setzen. Alle anderen Geräte werden dabei abgemeldet.
- Den Wiederherstellungscode lässt ein Gerät allein nicht neu erzeugen; dafür ist das Passwort nötig. So kann der
  Besitzer ein Konto, das über ein gestohlenes Gerät übernommen wurde, mit dem Code zurückholen.
- v3-Konten haben keinen Code und bekommen am Desktop einen Hinweis.

**D-90 QR-Pairing ohne Bestätigung am PC.**
- Code: 12 Zeichen Crockford-Base32 (60 Bit), 3 min gültig, einmal einlösbar; gespeichert wird nur der Hash.
- QR-Inhalt `https://<origin>/pair#c=<code>`. Das Fragment taucht nie in Logs auf (der `TraceLayer` des Servers
  protokolliert Pfad + Query) und ist für einen späteren E2E-Schlüssel frei.
- Getrennte Einlöse-Endpunkte: `POST /devices/pairing` (Token, wie `POST /devices`) und `POST /session/pairing`
  (Cookie, wie `POST /session`). So bleiben Token- und Cookie-Welt sauber getrennt.
- Weil der Benutzer auf die Bestätigung am PC verzichtet, gibt es diesen Ausgleich:
  - der QR erscheint erst auf Klick;
  - der PC zeigt sofort, welches Gerät angemeldet wurde, mit „Das war ich nicht – abmelden“;
  - es gilt die Regel „jüngeres Gerät“ (D-91).
- Gemeinsame Normalisierung in Rust und TypeScript mit `pairing_vectors.json`.

**D-91 Geräte abmelden: eigenes oder jüngeres Gerät ohne Passwort, älteres nur mit Passwort.** Der PC, der einen
Code erzeugt, ist immer älter als das damit gekoppelte Gerät und kann es deshalb sofort abmelden. Ein Angreifer mit
einem abfotografierten Code kann die älteren Geräte des Besitzers nicht abmelden. Widerrufene Geräte werden nach
30 Tagen gelöscht (bisher blieben sie für immer stehen – im Code geprüft).

**D-92 Konto löschen sofort** (DSGVO Art. 17, Benutzerentscheidung): `POST /me/delete` mit Passwort und
Benutzername; `DELETE FROM users` löscht per Cascade alles. Möglich in allen Clients. Am PC bleiben die lokalen
Notizen. Die Backups rotieren nach 14 Tagen; das steht so in der Datenschutzerklärung. `POST` statt `DELETE` mit
Body, weil manche Proxys Bodys von DELETE-Anfragen verwerfen.

**D-93 Datenexport** (Art. 20): `GET /me/export` liefert JSON `display-buddy-export/1` (Konto, Geräte, lebende
Notizen/Erinnerungen, Reihenfolge, Revisionen; keine Hashes, Tokens oder Push-Endpunkte). Der Desktop speichert die
Datei über den Rust-seitigen Speichern-Dialog.

**D-94 Kontingente mit Netto-Regel.**
- Ein Push-Paket, das die Belegung erhöht und danach über dem Kontingent liegt, wird ganz abgelehnt:
  `413 quota_exceeded`, Transaktion zurück. Pakete, die die Belegung nicht erhöhen, gehen immer durch.
- Kein Teil-Anwenden und kein `invalid` pro Datensatz. Bei `invalid` würden Clients die Änderung verwerfen; bei
  einem HTTP-Fehler behalten v3- und v4-Clients ihre Outbox.
- Geräte-Limit: `409 device_limit`.
- Gemessen wird per `SUM(length(payload))` in der Transaktion.
- Die Standardwerte kommen aus der Umgebung (leer = unbegrenzt) und lassen sich pro Konto per CLI ändern.

**D-95 Admin-Werkzeuge nur über die CLI** (Benutzerentscheidung): `user list|show|disable|enable|delete|quota|recovery`,
`invite create|list|revoke`. Keine Admin-API. Gesperrte Konten bekommen bei jeder Anfrage `403 account_disabled`.

**D-96 Standard-Server am Desktop.** `DEFAULT_SYNC_SERVER_URL = "https://buddy.pev-point.de"` steht in `types.ts`
und `model.rs`; der Vertragstest prüft, dass beide gleich sind. `syncServerUrl = ""` heißt „Standard“. Installationen
mit eingetragenem Server (das ging nur über ein früheres Verbinden, D-62) behalten ihn. `settings.json` wird nicht
umgeschrieben.

**D-97 Native App: Server zur Laufzeit wählbar** (ändert D-79 „HTTP-Scope nur `BUDDY_PUBLIC_URL`“).
- `BUDDY_PUBLIC_URL` wird zum Standard; ohne Variable gilt `https://buddy.pev-point.de`.
- `server_set` funktioniert nur abgemeldet und nur mit `https` (bzw. localhost/10.0.2.2 wie bisher). Die Origin
  liegt in `server.json`; der Scope bleibt auf `<origin>/api/v1/*` beschränkt (`Manager::add_capability`, Tauri
  2.12.5, Feature `dynamic-acl`).
- Eine fremde Origin aus einem QR-Code gilt erst nach einem Bestätigungsdialog.
- Tauri kann Capabilities nicht entfernen. Deshalb lädt die App nach einem Wechsel neu, und eine alte Origin bleibt
  höchstens bis zum nächsten App-Start im Scope.
- Ein Update geht nur über eine gleich signierte APK, also vom selben Ersteller. Weicht `meta.account.serverUrl`
  von der wirksamen Origin ab, stoppt der Sync mit einem Hinweis, statt still umzuschalten.
- Der Android-Hintergrundabgleich (D-107) geht am Tauri-Scope vorbei. Deshalb prüft `start_background_sync` die
  Adresse nach denselben Regeln wie `server_url::normalize`. Die Adresse kommt nur aus `shell_config`.

**D-98 Die PWA bleibt an ihre Origin gebunden.** `connect-src 'self'` und das `__Host-`-Cookie bleiben. Die PWA auf
pev-point spricht nie mit fremden Servern. Selbst-Hoster nutzen die PWA ihres eigenen Servers.

**D-99 QR scannen und anzeigen.**
- Native App: `tauri-plugin-barcode-scanner` 2.5.3. Android-Berechtigung `CAMERA` kommt aus dem Plugin; iOS braucht
  `NSCameraUsageDescription`, sonst bricht der Scan ab (Quellcode geprüft).
- PWA, drei Wege:
  - System-Kamera → `/pair`; die Seite löst nie automatisch ein;
  - In-App-Scanner mit `getUserMedia`, dekodiert mit `BarcodeDetector`, wenn vorhanden, sonst mit `jsqr` 1.4.0
    (reines JS, CSP-tauglich, eigener Chunk);
  - Code-Eingabe.
- `BarcodeDetector` ist kein Muss: Safari iOS hat es laut browser-compat-data 8.1.8 nur hinter einem Flag.
- Desktop: QR als SVG mit dem Crate `qrcode` 0.14.1 in Rust, angezeigt als Data-URL (Desktop-CSP `img-src data:`).

**D-100 Öffentlicher Endpunkt `GET /info`.** Er liefert Fähigkeiten (`apiLevel: 2`, `features`), den
Registrierungsmodus, die Mindestlänge für Passwörter und die Rechtslinks (nur `https`). Clients erkennen einen
v3-Server an `404` und bieten dann nur den Passwort-Login an. Die API bleibt `/api/v1` und wächst nur additiv.

**D-101 E2E später, in v4 vorbereitet.**
- `users.content_format` (1 = Klartext) wird über `GET /me/account` gemeldet. Bei einem unbekannten Format stoppen
  v4-Clients den Sync (`content_format_unsupported`), statt Daten zu überschreiben. In der Android-App gehört der
  Hintergrundabgleich (D-107) dazu: Die Web-Schicht stoppt ihn; der Dienst überspringt außerdem Datensätze, die er
  nicht parsen kann, statt falsche Alarme zu setzen.
- Das QR-Fragment kann später einen Schlüssel tragen, ohne dass der Server ihn sieht. Das Exportformat ist
  versioniert.
- Ehrliche Folgen für später: Push nur „Erinnerung fällig“ ohne Text; ohne Code oder Schlüssel ist ein vergessenes
  Passwort gleichbedeutend mit Datenverlust; die Krypto muss in allen drei Clients stehen.

**D-102 Datenschutz beim öffentlichen Dienst.**
- Web Push bleibt mit Text, weil der Inhalt nach RFC 8291 Ende-zu-Ende zum Browser verschlüsselt ist.
- FCM-Benachrichtigungen sind für Google lesbar (im Code geprüft: sichtbare Nachricht mit Titel und Text). Deshalb
  gibt es `BUDDY_FCM_PAYLOAD=minimal|full`: Standard `full` (Verhalten wie v3), pev-point setzt `minimal`.
- Logs enthalten weiter keine Inhalte. Logs mit IP-Adressen werden 7 Tage aufbewahrt.
- Die Rechtslinks kommen aus der Konfiguration, die Texte liefert der Betreiber.

**D-103 Bremsen verallgemeinert** (erweitert D-67): Es bleibt eine Implementierung im Speicher (ein
Server-Prozess). Neu sind ein IP-weites Limit für Fehlversuche (30/h über alle Benutzernamen), Limits für Challenges,
Registrierung, Pairing-Einlösen (10 Fehlversuche/10 min) und Export. Die Bremse (IP, Benutzer) gilt auch für
`recover` und für Passwort-Bestätigungen. Die IP wird weiter nur über `BUDDY_TRUSTED_PROXIES` bestimmt.
`/sync/changes` und `/sync/push` bekommen **keine** neue Bremse: Der Android-Hintergrundabgleich (D-107) fragt je
Gerät alle 3 min ab.

**D-104 CSRF-Regel per Pfad-Präfix** (erweitert D-66): Die Prüfung greift für alles, was mit `/api/v1/session`
beginnt (`/session`, `/session/pairing`), und wie bisher für jede Cookie-Anfrage. Bisher galt „Pfad endet auf
`/session`“; damit wäre `/session/pairing` ohne Login-CSRF-Schutz geblieben (im Code geprüft).

**D-105 Nativer Push nur mit passendem Firebase-Projekt, und nur noch als Ergänzung.** FCM-Token und Dienstkonto
gehören zu einem Firebase-Projekt. Die offizielle APK (Projekt des Betreibers) bekommt nur von pev-point Weckrufe.
Selbst-Hoster mit der offiziellen APK haben keinen FCM-Weckruf. Unter Android holt der Hintergrundabgleich (D-107)
neue Erinnerungen trotzdem nach höchstens etwa 3 min; unter iOS bleibt die lokale Planung beim Öffnen/Sync (D-47).
Für pev-point ist Firebase damit optional. Wer FCM selbst will, baut die App mit dem eigenen Firebase-Projekt.

**D-106 Version 0.4.0.** Server, Desktop und App bekommen 0.4.0; API weiter `/api/v1` (additiv), `apiLevel: 2`.
v3-Clients bleiben gegen einen v4-Server lauffähig (Matrix PLAN_V4 §9.1).

**D-107 Android: Hintergrundabgleich ohne Firebase (Alarm + Receiver, kein Vordergrunddienst).** Erinnerungen, die am PC neu angelegt oder
verschoben werden, erreichten ein Handy ohne FCM erst nach dem Öffnen der App (der Web-Sync läuft nur bei sichtbarer
App, die WebView ist im Hintergrund eingefroren). Neu in `mobile/plugins/buddy-push`: `BackgroundScheduler` löst per
exaktem Alarm (`setExactAndAllowWhileIdle`, `USE_EXACT_ALARM`) alle 3 Min. `BackgroundTickReceiver` aus, der
`GET /sync/changes` mit dem Geräte-Token abruft und die Erinnerungen über dieselben Klassen/Ids/Speicher
wie die App plant (`TauriNotificationManager`, FNV-1a-Id wie `native-plan.ts`, Kotlin-Test mit JS-Referenzwerten).
Bewusst **kein Foreground-Service**: Android verlangt dafür eine dauerhafte Benachrichtigung (erst als Dienst gebaut,
auf Benutzerwunsch wieder entfernt). Der Receiver arbeitet mit `goAsync()` und Wake-Lock, HTTP-Timeouts 10 s. Die
App und der Abgleich führen je einen eigenen Cursor; geplante Alarme stehen im gemeinsamen `NOTIFICATION_STORE`, die App
ersetzt beim Öffnen Texte (Diff) statt doppelt zu planen. Token: AES-GCM mit Keystore-Schlüssel, nur Lesezugriff auf den
Server. Start nach Login, Boot und App-Update; `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` wird einmal nach der
Benachrichtigungs-Erlaubnis erfragt, weil Doze sonst das Netz sperrt. Grenze: Latenz = Intervall (FCM bleibt der Weg
für „sofort“). Web-Teil: `src/web/notify/native-background.ts`.

**D-107 – Folgen für v4** (Nachtrag zur Planung, PLAN_V4_ACCOUNTS §2, §7.2, §8, §11.3):
- Adressprüfung: Der Dienst geht am HTTP-Scope von Tauri vorbei (`HttpURLConnection`). `start_background_sync`
  prüft deshalb nach denselben Regeln wie `server_url::normalize` (`https`, `http` nur für
  localhost/127.0.0.1/[::1]/10.0.2.2, keine Pfade). Heute erlaubt `PushPlugin.kt` mit `^https?://…` auch
  `http://` zu jedem Host. Die Adresse kommt nur aus `shell_config` (wirksame Origin, D-97).
- Server wechseln: `server_set` nur abgemeldet; beim Abmelden `stop_background_sync`. Nach `loginWithCode`
  bekommt der Dienst das Token wie nach dem Passwort-Login.
- Widerruf, Löschen, Wiederherstellung → 401 beim Dienst → er löscht seine Kopie. Bei `403 account_disabled`
  löscht die Web-Schicht das App-Token nicht (Sperre ist umkehrbar) und übergibt nach dem Entsperren erneut.
- Unbekanntes `contentFormat` (D-101): Die Web-Schicht stoppt den Dienst. Der Dienst überspringt Datensätze, die
  er nicht parsen kann, statt Alarme falsch zu setzen.
- Server: `/sync/changes` bekommt keine Bremse (D-103). `synced_seq`/`last_seen_at` werden auch von den
  Abfragen des Dienstes gesetzt; `synced_seq` liest keine Server-Logik (geprüft), also unkritisch.
- Betrieb pev-point: etwa 480 Abfragen pro Gerät und Tag; Firebase wird dort optional (D-105).
