# Display Buddy – Projektleitfaden für Claude

Windows-Desktop-App: animierter Buddy (always on top) + Notizfenster mit TipTap-Editor im Endlos-Karussell,
Erinnerungen, Suche, Shortcut-Leiste, Skins (inkl. Lottie).

**Neu im Projekt? Zuerst `docs/HANDOFF.md` lesen** (Stand, Build in der Cloud, Lektionen, offene Punkte).

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
- Cross-Build von Linux (MinGW, siehe D-17): `npm run tauri build -- --target x86_64-pc-windows-gnu`
- Diagnose-EXE mit Konsole: `... --target x86_64-pc-windows-gnu --no-bundle --features console`

## Struktur & Verträge
Siehe `docs/PLAN.md` (verbindliche Schnittstellen), `docs/DECISIONS.md` (Entscheidungen).
- Ein HTML-Einstieg pro Fenster: `buddy.html`, `notes.html`, `settings.html` → `src/windows/<name>/main.tsx`.
- `src/types.ts` und `src/lib/api.ts` sind der Vertrag; nur `api.ts` ruft `invoke()`/`listen()` auf
  (Ausnahme: `getCurrentWindow()` für Drag/Fensteroperationen).
- Daten gehören dem Rust-Backend (`src-tauri/src/storage`). Kein Dateizugriff aus dem Frontend.
- Jeder neue Command: `commands/*.rs`, `generate_handler!` (lib.rs), `COMMANDS` (build.rs), passende
  `capabilities/*.json`, `api.ts` + `api.test.ts`, `plan_commands()` in `src-tauri/tests/contract.rs`.
- Rust: außerhalb von `state.rs` nie `.state()`/`.state::<` – immer `try_app_state`/`try_state`
  (sonst Absturz beim Start unter Windows, siehe HANDOFF §5).

## Konventionen
- UI-Texte Deutsch; Code, Bezeichner, Commits Englisch.
- Animationen nur über `transform`/`opacity`; `prefers-reduced-motion` respektieren.
- Alle interaktiven Elemente mit `aria-label`, per Tastatur bedienbar.
- Kleine, thematische Commits. Keine TODO-Stubs als fertig melden.
