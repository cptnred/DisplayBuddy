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

**D-28 Eigener Server, Desktop bleibt local-first.** `buddy-server` (axum + SQLite) synchronisiert Notizen, plant Erinnerungen und sendet Push. Die Desktop-App funktioniert ohne Server unverändert; Sync ist optional und standardmäßig aus.

**D-29 Last-Writer-Wins pro Dokument** (Notiz, Erinnerung, Reihenfolge) nach `updatedAt`, Gleichstand → größeres `updatedBy`. Löschen ist ein Tombstone, der an LWW teilnimmt. Entscheidend ist der **Zeitstempel der Bearbeitung auf dem Gerät** (PC und Handy, siehe D-41); der Server stempelt nie um und klemmt nur Zeitstempel, die mehr als 2 min in der Zukunft liegen. Verlierer-Fassungen (überschrieben oder beim Hochladen abgelehnt) 30 Tage in `note_revisions`. TipTaps offizieller Weg für Zusammenführen wäre Collaboration/Yjs (CRDT) – bewusst nicht gewählt (Benutzerentscheidung; das Speicherformat müsste von TipTap-JSON auf Yjs-Dokumente umgestellt werden).

**D-30 Fällig-Werden ändert `updatedAt` nicht.** Nur Benutzeraktionen (setzen, erledigen, verschieben, entfernen) zählen als Bearbeitung. Sonst könnte ein PC, der offline nachfeuert, eine am Handy erledigte Erinnerung wieder „fällig“ machen.

**D-31 Push nur vom Server über selbst gehostetes ntfy** (`auth-default-access: deny-all`, `upstream-base-url: https://ntfy.sh` für iOS; an ntfy.sh gehen laut ntfy-Doku nur Nachrichten-ID und Topic-Hash). Die Desktop-App spricht nie mit ntfy → keine doppelten Nachrichten. Genau eine Nachricht pro Vorkommen `(noteId, at)` über `push_log`.

**D-32 Der Server plant Erinnerungen selbst** statt ntfys „Scheduled delivery“ zu nutzen: Wiederholungen, Erledigt/Verschieben und Sync-Zustand liegen ohnehin auf dem Server; ntfy stellt nur sofort zu.

**D-33 Aktionsknöpfe mit signierten Einmal-Tokens** (HMAC, 24 h, an `(noteId, at)` gebunden) statt eines Bearer-Tokens in der Nachricht, weil ntfy Nachrichten samt Aktionen im Cache speichert.

**D-34 Web-App als installierbare, offline-first PWA** (Nachtrag 2026-11-06, Benutzerwunsch): eigener Vite-Einstieg (`web.html` → `src/web/`), dieselben TipTap-Extensions wie am Desktop (TipTap-Doku: Schema-Parität). Installierbar laut MDN (Manifest mit name/short_name, Icons 192+512, start_url, display standalone; HTTPS). Service Worker über vite-plugin-pwa/Workbox `generateSW` nur für die App-Hülle, `registerType: 'prompt'`, `injectRegister: null` (kein Inline-Skript, CSP bleibt streng). Daten in IndexedDB über `idb` mit Outbox; die Oberfläche liest nur lokal.

**D-35 Gemeinsames Crate `crates/buddy-core` ohne Cargo-Workspace.** Path-Dependency aus `src-tauri` und `server`; Tauri-Build, `target/` und MinGW-Cross-Build bleiben unverändert. `model.rs` re-exportiert die verschobenen Typen.

**D-36 Desktop-HTTP über `tauri_plugin_http::reqwest`, nur Rust-seitig** (offizieller Tauri-Weg laut Doku „HTTP Client“; Fortsetzung von D-07, keine JS-Permissions). TLS-Backend muss mit `x86_64-pc-windows-gnu` bauen.

**D-37 Geräte-Token im Windows-Anmeldeinformationsspeicher** (`keyring-core` + Windows-Store-Crate, wie im keyring-rs-README für Anwendungen empfohlen), nie in `settings.json`.

**D-38 Web-Login nach OWASP:** Argon2id (mind. 19 MiB, t=2, p=1), Cookie `__Host-buddy_session; Secure; HttpOnly; SameSite=Strict; Path=/`, serverseitige Sessions; CSRF über `Sec-Fetch-Site` mit Origin-Fallback plus Custom-Header `X-Buddy-Request`.

**D-39 Wiederholungsmathe auf dem Server in der IANA-Zeitzone des Kontos** (`chrono-tz`); `schedule.rs` ist bereits generisch über `TimeZone`. Der Desktop meldet seine Zone beim Verbinden.

**D-40 Betrieb: VPS + Docker Compose + Caddy** (automatisches HTTPS laut Caddy-Doku), zwei Subdomains (`buddy.<domain>`, `ntfy.<domain>`), nur Caddy veröffentlicht Ports.

**D-41 Gerätezeitstempel mit Uhr-Korrektur** (Nachtrag, Benutzerwunsch). `updatedAt` setzt das Gerät, auf dem bearbeitet wird – sofort beim lokalen Speichern, auch offline – als korrigierte Gerätezeit: Gerätezeit + Median der letzten 5 gemessenen Abweichungen zur Serveruhr (`serverTime` jeder Antwort, RTT/2 abgezogen, nur RTT < 5 s). Offline gilt der letzte bekannte Wert. Eine späte Offline-Änderung behält ihren frühen Zeitstempel und verliert deshalb korrekt gegen eine inzwischen neuere Änderung. Hybrid Logical Clocks wären robuster gegen falsche Uhren, sind aber für einen Benutzer mit NTP-synchronisierten Geräten unnötig komplex.

**D-42 LWW, Uhr-Korrektur und Erinnerungsmathe doppelt (Rust + TypeScript) mit gemeinsamen Testvektoren** (`crates/buddy-core/tests/fixtures/*.json`, von `cargo test` und Vitest gelesen). Die Web-App muss offline entscheiden und rechnen können (z. B. „Erledigt“ bei einer Wiederholung); WebAssembly aus `buddy-core` wäre die Alternative, vergrößert aber Build und CSP-Anforderungen (`wasm-unsafe-eval`).

**D-43 Ein Schreibweg: `/sync/push`.** Keine CRUD-Endpunkte mit Serverzeit, damit PC und Web-App denselben Regeln folgen und Offline-Änderungen nicht anders behandelt werden als Online-Änderungen. `/sync/push` ist idempotent (Wiederholung nach Verbindungsabbruch ist sicher).

**D-44 Sync der Web-App ohne Background Sync.** Laut browser-compat-data gibt es `SyncManager` nur in Chromium (nicht Safari, nicht Firefox). Ausgelöst wird deshalb beim Start, bei `online`, bei `visibilitychange`, alle 60 s sichtbar und nach Änderungen; `navigator.onLine` nur als Hinweis (MDN: unzuverlässig). Background Sync höchstens als optionale Ergänzung. Parallele Läufe mehrerer Tabs verhindert die Web Locks API (Safari ≥ 15.4), Änderungen verteilt `BroadcastChannel`.

**D-45 iOS: Installation empfohlen, Speicher-Persistenz anfragen.** Safari löscht per Skript angelegte Daten nach 7 Tagen ohne Interaktion (MDN); Web-Apps auf dem Home-Bildschirm sind laut WebKit ausgenommen. Die App zeigt unter iOS deshalb deutlich den Installationshinweis und ruft nach dem Login `navigator.storage.persist()` auf. Gefährdet sind ohnehin nur nicht synchronisierte Änderungen.
