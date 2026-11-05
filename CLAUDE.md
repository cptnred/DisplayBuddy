# Display Buddy – Projektleitfaden für Claude

Windows-Desktop-App: animierter Smiley (always on top) + Notizfenster mit TipTap-Editor im Endlos-Karussell.

## Stack
Tauri 2 (Rust, edition 2024) · React 18.3 + TypeScript (strict) + Vite 8 · CSS Modules · TipTap 3 · Vitest + Testing Library · npm.
Ziel: Windows 10/11 x64 (WebView2), Installer: NSIS.

## Befehle
- `npm install` – Abhängigkeiten
- `npm run tauri dev` – App im Dev-Modus
- `npm test` – Frontend-Tests (Vitest)
- `npm run build` – Typecheck + Vite-Build
- `cd src-tauri && cargo test` – Rust-Tests
- `cd src-tauri && cargo clippy --all-targets -- -D warnings`
- `npm run tauri build` – NSIS-Installer (unter Windows)
- Cross-Build von Linux: `npm run tauri build -- --runner cargo-xwin --target x86_64-pc-windows-msvc`

## Struktur & Verträge
Siehe `docs/PLAN.md` (verbindliche Schnittstellen), `docs/DECISIONS.md` (Entscheidungen).
- Ein HTML-Einstieg pro Fenster: `buddy.html`, `notes.html`, `settings.html` → `src/windows/<name>/main.tsx`.
- `src/types.ts` und `src/lib/api.ts` sind der Vertrag; nur `api.ts` ruft `invoke()`/`listen()` auf
  (Ausnahme: `getCurrentWindow()` für Drag/Fensteroperationen).
- Daten gehören dem Rust-Backend (`src-tauri/src/storage`). Kein Dateizugriff aus dem Frontend.
- Jeder neue Command: in `build.rs` (COMMANDS) **und** in der passenden `capabilities/*.json` eintragen.

## Konventionen
- UI-Texte Deutsch; Code, Bezeichner, Commits Englisch.
- Animationen nur über `transform`/`opacity`; `prefers-reduced-motion` respektieren.
- Alle interaktiven Elemente mit `aria-label`, per Tastatur bedienbar.
- Kleine, thematische Commits. Keine TODO-Stubs als fertig melden.
