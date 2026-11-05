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
