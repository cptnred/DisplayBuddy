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
