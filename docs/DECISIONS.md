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
