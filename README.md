# Display Buddy

Ein kleiner, animierter Smiley, der immer im Vordergrund über allen Fenstern schwebt. Ein Klick auf ihn öffnet ein Notizfenster mit einem schlanken Rich-Text-Editor. Die Notizen liegen in einem endlosen Karussell.

Plattform: **Windows 10/11 (x64)**, gebaut mit Tauri 2, React 18, TypeScript und TipTap 3.

## Funktionen

**Buddy**
- Randloses, transparentes, rundes Fenster, immer im Vordergrund, nicht in der Taskleiste
- SVG-Smiley mit Wippen, zufälligem Blinzeln (3–7 s), Hover-Lächeln und Hüpfen beim Klick
- Einstellbar: Gesichtsfarbe, Augen (rund / Striche / Herzen), Mund (Lächeln / breit / neutral), Größe 48–192 px, Deckkraft 30–100 %, Animationsgeschwindigkeit
- „Ruhiger Modus“ schaltet die Animationen ab; die Windows-Einstellung „Animationseffekte“ (`prefers-reduced-motion`) wird ebenfalls beachtet
- Ziehen verschiebt den Buddy, ein kurzer Klick öffnet bzw. schließt die Notizen (Schwelle 4 px)
- Die Position bleibt nach einem Neustart erhalten. Liegt sie auf keinem Monitor mehr (z. B. Zweitmonitor abgesteckt), springt der Buddy nach unten rechts auf den Hauptmonitor.
- Rechtsklick öffnet ein Menü: Neue Notiz, Einstellungen, Beenden
- Experimentell (standardmäßig aus): Klicks auf die transparenten Ecken gehen an das Fenster darunter

**Notizen**
- Notizfenster neben dem Buddy (links oder rechts, je nach Platz), Größe änderbar, immer im Vordergrund, „Anheften“ möglich
- Editor mit Fett, Kursiv, Unterstrichen, Durchgestrichen, Schriftgröße (12–32 px), 8 Textfarben, Aufzählung, Nummerierung, verschachtelbaren Checklisten, Rückgängig/Wiederholen
- Optionaler Titel und 6 Pastell-Hintergrundfarben pro Notiz
- Endloses Karussell mit Seitenkarten. Navigation über Pfeil-Buttons, Mausrad über den Seitenkarten, Klick auf eine Seitenkarte oder die Tastatur.
- Automatisches Speichern 500 ms nach der letzten Änderung, beim Ausblenden und beim Beenden

**Neu in v2**
- **Skins:** Smiley, Katze, Roboter, Geist, dazu eigene Bilder (PNG/SVG/GIF/WebP) und Lottie-Animationen (`.json`, z. B. von LottieFiles) importieren. Auswahl in den Einstellungen.
- **Erinnerungen an Notizen:** Glocke in der Notiz → Datum, Uhrzeit, Wiederholung (einmalig, täglich, werktags, wöchentlich, monatlich). Bei Fälligkeit wackelt der Buddy und zeigt ein Glocken-Badge, dazu kommen eine Windows-Benachrichtigung und ein Ton (beides abschaltbar). Klick auf den Buddy öffnet die Notiz mit „Erledigt“ / „10 Min. später“ / „1 Std. später“. Verpasste Erinnerungen kommen beim nächsten Start.
- **Suche** über alle Notizen mit `Strg+F` oder der Lupe. Groß-/Kleinschreibung und Umlaute werden ignoriert.
- **Shortcut-Leiste** unter den Notizen mit zwei Reitern:
  - „Programme & Ordner“: Dateien, Programme und Ordner aus dem Explorer hineinziehen oder mit „+“ auswählen.
  - „Lesezeichen“: Web-Links, die im Standardbrowser öffnen.
  - Umbenennen, Verschieben und Entfernen per Rechtsklick; die Leiste ist einklappbar.
- **Abmelden/Herunterfahren:** Ausstehende Eingaben werden noch gespeichert („Notizen werden gespeichert …“).

**System**
- Tray-Symbol: Notizen öffnen, Neue Notiz, Buddy ein-/ausblenden, Einstellungen, Mit Windows starten, Beenden
- Ein zweiter Start öffnet nur die Notizen der laufenden Instanz
- Globales Tastenkürzel `Strg+Alt+N` (abschaltbar)

### Tastenkürzel im Notizfenster

| Kürzel | Aktion |
|---|---|
| `Strg+←` / `Strg+→` | Vorherige / nächste Notiz (auch im Editor) |
| `Strg+Shift+←` / `Strg+Shift+→` | Aktive Notiz in der Reihenfolge verschieben |
| `Strg+N` | Neue Notiz |
| `Strg+F` | Notizen durchsuchen |
| `Esc` | Notizfenster ausblenden |
| `Strg+B` / `Strg+I` / `Strg+U` | Fett / Kursiv / Unterstrichen |
| `Strg+Shift+7` / `8` / `9` | Nummerierung / Aufzählung / Checkliste |
| `Tab` / `Shift+Tab` | Listeneintrag einrücken / ausrücken |
| `Strg+Z` / `Strg+Y` | Rückgängig / Wiederholen |

## Installation

1. `Display Buddy_0.1.0_x64-setup.exe` ausführen. Die Installation läuft nur für den aktuellen Benutzer, Administratorrechte sind nicht nötig.
2. Fehlt die WebView2-Laufzeit (unter Windows 11 und aktuellem Windows 10 ist sie vorinstalliert), lädt der Installer sie automatisch nach.
3. Der Installer ist **nicht signiert**. Windows SmartScreen kann deshalb warnen („Weitere Informationen“ → „Trotzdem ausführen“).

## Speicherort der Daten

| Was | Pfad |
|---|---|
| Einstellungen | `%APPDATA%\de.displaybuddy.desktop\settings.json` |
| Notiz-Reihenfolge | `%APPDATA%\de.displaybuddy.desktop\notes\index.json` |
| Notizen | `%APPDATA%\de.displaybuddy.desktop\notes\<uuid>.json` (TipTap-JSON) |
| Erinnerungen | `%APPDATA%\de.displaybuddy.desktop\reminders.json` |
| Shortcut-Leiste | `%APPDATA%\de.displaybuddy.desktop\shortcuts.json` |
| Eigene Skins | `%APPDATA%\de.displaybuddy.desktop\skins\` |
| Log | `%LOCALAPPDATA%\de.displaybuddy.desktop\logs\` |
| Startdiagnose | `%LOCALAPPDATA%\de.displaybuddy.desktop\diagnostics.log` |

Jede Datei wird atomar geschrieben (erst `*.tmp`, dann umbenennen). Eine beschädigte Datei wird in `*.corrupt` umbenannt und protokolliert, die App läuft weiter. Bei der Deinstallation bleiben die Daten erhalten, außer man setzt das Häkchen „Anwendungsdaten löschen“.

## Entwicklung

Voraussetzungen: Node.js 22+, Rust (stable), unter Windows die [Tauri-Voraussetzungen](https://tauri.app/start/prerequisites/) (MSVC Build Tools, WebView2).

```bash
npm install
```

```bash
npm run tauri dev
```

| Befehl | Zweck |
|---|---|
| `npm test` | Frontend-Tests (Vitest + Testing Library) |
| `npm run build` | Typprüfung + Vite-Build |
| `cd src-tauri && cargo test` | Rust-Tests (Speicher, Logik, Vertragstests) |
| `cd src-tauri && cargo clippy --all-targets -- -D warnings` | Lint |
| `npm run tauri build` | NSIS-Installer (unter Windows, MSVC) |

Cross-Build von Linux (so wurde v1 gebaut, siehe `docs/DECISIONS.md` D-17):

```bash
sudo apt install mingw-w64 nsis
```

```bash
rustup target add x86_64-pc-windows-gnu
```

```bash
npm run tauri build -- --target x86_64-pc-windows-gnu
```

Wichtige Dokumente:
- `docs/PLAN.md`: Schnittstellen (Typen, Rust-Commands, Events, Fenster)
- `docs/DECISIONS.md`: technische Entscheidungen
- `docs/MANUAL_TESTS.md`: Checkliste für den Handtest unter Windows
- `CLAUDE.md`: Kurzleitfaden für die Arbeit mit Claude Code

Projektstruktur (Kurzform):

```
buddy.html / notes.html / settings.html   ein Einstieg pro Fenster
src/windows/{buddy,notes,settings}/       Fenster-Apps
src/components/editor/                    TipTap-Editor + Toolbar
src/lib/carousel.ts                       Karussell-Logik (rein, getestet)
src/lib/api.ts                            typisierte invoke()/Event-Wrapper
src-tauri/src/                            Speicher, Commands, Fenster, Tray, Autostart, Beenden
```

## Bekannte Einschränkungen (v1)

- **Nicht unter Windows getestet.** v1 wurde unter Linux entwickelt und für Windows cross-kompiliert. Alles, was vom Fenster- und Systemverhalten abhängt, muss nach `docs/MANUAL_TESTS.md` von Hand geprüft werden: Transparenz, Z-Reihenfolge, DPI, Tray, Autostart, Installer.
- Das Speichern beim **Abmelden/Herunterfahren** (v2) ist nur kompiliert und noch nicht unter Windows erprobt (`docs/MANUAL_TESTS.md` §21).
- Dateien lassen sich nicht in den Editor-Text ziehen: Die native Dateiablage ist für die Shortcut-Leiste reserviert (D-24).
- Monatliche Erinnerungen am 29.–31. rutschen nach einem kürzeren Monat dauerhaft auf dessen letzten Tag (D-27).
- **Exklusive Vollbild-Anwendungen** (manche Spiele) liegen über allen „immer im Vordergrund“-Fenstern. Der Buddy ist dort nicht sichtbar.
- Das Ziel „Leerlauf unter 80 MB RAM“ ist nicht gemessen und mit zwei dauerhaft geladenen WebView2-Fenstern (Buddy + Notizen) eher knapp. Die Messung steht in `docs/MANUAL_TESTS.md`.
- Der Installer ist unsigniert und wurde mit der MinGW-Toolchain gebaut. Für eine Veröffentlichung besser unter Windows mit MSVC bauen und signieren.
- Click-Through der Ecken ist experimentell und standardmäßig aus.
