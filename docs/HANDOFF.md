# Übergabe an den nächsten Agenten – Display Buddy

Stand: 2026-11-06, Version **0.3.0** (v3), Branch `claude/display-buddy-v3-c9w0c8`. Diese Datei fasst zusammen, was existiert,
wie man baut/testet, was gelernt wurde und was offen ist. Verbindliche Details stehen in
`docs/PLAN.md` (Schnittstellen v1 §1–9, v2 §10–12), Begründungen in `docs/DECISIONS.md` (D-01…D-27),
die Handtest-Checkliste in `docs/MANUAL_TESTS.md`.

## 1. Was die App ist

Windows-10/11-Desktop-App (Tauri 2 + React 18 + TipTap 3). Ein animierter Buddy (Smiley/Katze/Roboter/
Geist oder eigenes Bild/Lottie) schwebt immer im Vordergrund. Klick öffnet ein Notizfenster mit
Rich-Text-Editor und Endlos-Karussell; darunter eine Shortcut-Leiste (Programme & Ordner / Lesezeichen).
Erinnerungen an Notizen lassen den Buddy wackeln (Badge), zeigen einen Windows-Toast und spielen einen Ton.
Tray-Menü, Autostart, Single-Instance, globales Kürzel Strg+Alt+N, Einstellungsfenster mit Live-Vorschau.

**Der Benutzer hat v1 unter Windows installiert und bestätigt: „funktioniert jetzt“** (nach dem Startfix,
siehe §5). v0.2.0 wurde ihm als Installer geliefert, **eine Rückmeldung zu v0.2.0 unter Windows steht aus.**

## 2. Arbeitsweise mit dem Benutzer

- Oberfläche Deutsch; Code, Bezeichner, Commits Englisch. Antworten an den Benutzer auf Deutsch.
- Produktentscheidungen erfragen (er beantwortet Multiple-Choice-Fragen gern), technische Details selbst
  entscheiden und in `docs/DECISIONS.md` begründen.
- Er wünscht Arbeit in Phasen mit Subagenten (je eigener git-Worktree, klar abgegrenzte Ordner) und
  ehrliche Berichte: was getestet ist, was nur kompiliert, was nicht geprüft werden konnte.
- Kleine thematische Commits. Keine TODO-Stubs als „fertig“ melden.
- Lieferung an ihn: `.exe`/`.bundle` direkt kamen nicht an → **als ZIP schicken**.

## 3. Struktur (Kurzfassung)

```
buddy.html notes.html settings.html        ein Vite-Einstieg pro Fenster
src/types.ts, src/lib/api.ts               VERTRAG: Typen + einzige Stelle mit invoke()/listen()
src/lib/                                   carousel.ts, debounce.ts, search.ts, datetime.ts (rein, getestet)
src/windows/buddy/                         BuddyApp, BuddyAvatar, SkinFrame + skins/, dragClick, Alert/Badge
src/windows/notes/                         NotesApp, Carousel, NoteCard, useNotesStore (Autosave),
                                           SearchPanel, Reminder (Glocke/Popover/Banner), TitleBar
src/windows/notes/shortcuts/               ShortcutBar (Tabs, Kacheln, Menü, Lesezeichen-Formular)
src/windows/settings/                      SettingsApp, SkinPicker
src/components/editor/                     TipTap: NoteEditor, Toolbar, extensions
src-tauri/src/
  lib.rs            Builder, Plugins, setup, generate_handler!
  state.rs          AppState + try_app_state (EINZIGE Stelle für Zugriff auf AppState)
  model.rs          serde-Spiegel von types.ts (camelCase)
  storage/          Notizen/Settings: atomares Schreiben, *.corrupt-Quarantäne
  commands/         #[tauri::command]-Hüllen (notes, settings, windows, reminders, shortcuts, skins)
  windows.rs        Platzierung, Monitore/DPI, Notizfenster, Buddy-Menü, Window-Events, DragDrop
  reminders/        reminders.json, Scheduler-Thread, Wiederholungsmathe (schedule.rs), Toast-Text
  shortcuts/        shortcuts.json, Pfad-/URL-Validierung, Shell-Icons (icon.rs, Windows)
  skins/            Import/Validierung (PNG/GIF/WebP/SVG/Lottie), skins/index.json
  shutdown.rs       Windows: WM_QUERYENDSESSION/WM_ENDSESSION → Flush-Handshake
  quit.rs           Flush-Handshake (flush-request → flush_done, 1,5 s Timeout)
  tray.rs, autostart.rs (gequoteter Run-Eintrag), shortcut.rs (globales Kürzel),
  clickthrough.rs (experimentell, Standard aus), crash.rs (Panic-Hook, diagnostics.log, MessageBox)
src-tauri/build.rs                        COMMANDS-Liste (App-Manifest → Permissions pro Command)
src-tauri/capabilities/{buddy,notes,settings}.json   minimale Rechte pro Fenster
src-tauri/tests/contract.rs               Vertragstests (siehe §6)
```

## 4. Bauen & Testen (in einer Linux-Cloud-Umgebung)

Benötigt (in der bisherigen Session per apt/rustup installiert, in einer neuen Umgebung neu installieren):
`libwebkit2gtk-4.1-dev build-essential libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
nsis mingw-w64 xvfb xdotool x11-utils imagemagick dbus-x11 wine64`, `rustup target add x86_64-pc-windows-gnu`,
`cargo install --locked tauri-cli`.

```bash
npm install
npm test                                   # Vitest, 402 Tests
npm run build                              # tsc strict + Vite
cd src-tauri && cargo test                 # 109 Unit + 10 Vertragstests
cd src-tauri && cargo clippy --all-targets -- -D warnings
cd src-tauri && cargo clippy --all-targets --target x86_64-pc-windows-gnu -- -D warnings   # Windows-Code prüfen
npm run tauri build -- --target x86_64-pc-windows-gnu                      # NSIS-Installer
npm run tauri build -- --target x86_64-pc-windows-gnu --no-bundle --features console   # Diagnose-EXE mit Konsole
```

- **MSVC/cargo-xwin geht in der Cloud nicht**: der Download von `aka.ms` ist per Proxy-Policy gesperrt
  (nicht umgehen). Deshalb MinGW (`windows-gnu`); der Installer bündelt `WebView2Loader.dll` (D-17).
  „export ordinal too large“ kam von der `cdylib` (zu viele Exporte für MinGW) – seit D-65 nicht mehr im crate-type.
- **Smoke-Test der echten App unter Linux**: `npm run tauri build -- --debug --no-bundle`, dann unter Xvfb
  mit `dbus-run-session` starten, mit `xdotool` bedienen, mit `import -window root` Screenshots machen,
  `XDG_DATA_HOME` auf ein Testverzeichnis setzen. Erstes Rendern unter Software-Rendering dauert einige
  Sekunden. Ohne Window-Manager: Buddy-Fenster ist 200×200 statt 96×96 (GTK-Effekt), Dialoge haben keinen
  Tastaturfokus (per Maus bedienen), Screenshots nicht in den Ordner legen, den ein Dateidialog anzeigt.
- **Wine** taugt nur bis „tauri app built“ in `diagnostics.log` (kein WebView2) – reicht, um Panics in
  Plugin-Initialisierung auszuschließen.

**Unter Windows (Rechner des Benutzers):** Frontend, `src-tauri` und `crates/buddy-core` laufen direkt. Der Server
(`server/`) baut unter Windows nicht (OpenSSL über `web-push` → `ece`): Tests und clippy in WSL (Ubuntu) mit
`CARGO_TARGET_DIR=~/buddy-target`. Einrichtung und Befehle: `README.md` → „Testen unter Windows". Android-Emulator
nur in GitHub Actions (`mobile-android.yml`). `ShortcutBar.test.tsx` ist unter Last gelegentlich wackelig.

## 5. Wichtige Lektionen (nicht wiederholen!)

1. **Startabsturz unter Windows (behoben in 0.1.2):** Tauri erzeugt die Fenster aus `tauri.conf.json`
   *vor* unserem `setup`. Windows liefert dabei synchron `Moved`/`Focused`-Events. Ein `app.state()` in
   einem Event-Handler panikte → wegen `panic = "abort"` und ohne Konsole verschwand der Prozess spurlos.
   **Regel:** außerhalb von `state.rs` nie `.state::<`/`.state()`; immer `state::try_app_state()` bzw.
   `app.try_state()` (Vertragstest erzwingt das). Eigene Modul-States mit `app.manage` in `init` + `try_state`.
   Auch **IPC-Aufrufe** können vor `setup` ankommen: WebView2 pumpt beim Erzeugen des Notizfensters Nachrichten
   (`webview2-com::wait_with_pump`), das Buddy-Fenster lädt in der Zeit schon und ruft `load_settings` auf
   (→ Standardwerte). Deshalb sendet `setup` am Ende einmal `settings-changed`, `reminders-changed`, `skins-changed`.
2. Release-Builds zeigen Startfehler jetzt als MessageBox und schreiben
   `%LOCALAPPDATA%\de.displaybuddy.desktop\diagnostics.log`. Bei „startet nicht“: Diagnose-EXE schicken.
3. **CSP ist streng** (`script-src 'self'`, kein eval, `style-src 'unsafe-inline'` wegen TipTap-Styles,
   `img-src 'self' data:`). Lottie deshalb nur `lottie-web/build/player/lottie_light` (kein eval, kein Worker).
4. **TipTap 3:** TaskItem-NodeView setzt kein `data-type` auf `<li>` → CSS über `ul[data-type="taskList"] > li`.
   FontSize ist offiziell in `@tiptap/extension-text-style`; Underline/ListKeymap stecken in StarterKit.
5. **Esc-Konvention:** Popover/Menüs/Formulare tragen `data-local-escape`; das Notizfenster ignoriert Esc,
   dessen Ziel darin liegt (sonst schließt Esc das ganze Fenster).
6. **Native Dateiablage** ist aktiv (Shortcut-Leiste) → kein HTML5-Drag&Drop von Dateien im WebView;
   Umsortieren ist zeigerbasiert (D-24). Titelleiste: nur ein Drag-Mechanismus (`[data-drag-region]`).
7. **Neuer Command = 4 Stellen:** Funktion in `commands/*.rs`, `generate_handler!` in `lib.rs`,
   `COMMANDS` in `build.rs`, Permission in der passenden `capabilities/*.json` – plus Wrapper in `api.ts`,
   Eintrag in `src/lib/api.test.ts` und `plan_commands()` in `tests/contract.rs`. Der Least-Privilege-Test
   (`src/lib/capabilities.test.ts`) schlägt fehl, wenn ein Fenster eine Permission hat, die es nicht nutzt.
8. Neue Settings-Felder: `types.ts` (Interface + `DEFAULT_SETTINGS`) **und** `model.rs` (Struct + Default +
   Test-JSON), Schlüsselanzahl im Vertragstest anpassen. Laden ist pro Schlüssel tolerant.
9. Autosave: pro Notiz serialisierter Debouncer (500 ms), Reihenfolge-Speicherungen serialisiert;
   `onChange` ist an die Notiz-ID gebunden. Regressionstests in `useNotesStore.races.test.ts`.

## 6. Qualitätsstand

- Frontend 402 Tests, Rust 109 + 10 Vertragstests, clippy (Linux + windows-gnu) ohne Warnungen, `cargo fmt` sauber.
- Vertragstests prüfen: Commands in build.rs = lib.rs = PLAN, Argumentnamen, Capabilities nur bekannte
  Commands, Settings-Defaults Rust = TS, Struct-Schlüssel = TS-Interfaces, kein direkter `.state()`-Zugriff.
- Unter Linux mit der echten App durchgespielt (v2): Suche, Erinnerung setzen/fällig/Badge/Banner/Erledigt,
  verpasste Erinnerung beim Start, Lesezeichen anlegen, Skin-Wechsel, Bild- und Lottie-Import.

## 7. Offen / ungetestet unter Windows (Priorität für die nächste Runde)

Siehe `docs/MANUAL_TESTS.md` §21–25 (v2) und die ⚠️-Punkte davor. Insbesondere:
- Speichern beim Abmelden/Herunterfahren (`shutdown.rs`), Toast + Ton, `MessageBeep`.
- Drag & Drop aus dem Explorer, Shell-Icons (`shortcuts/icon.rs`), Öffnen von Programmen/Ordnern/URLs,
  native Dateidialoge.
- Lottie-CPU-Last, Click-Through (experimentell), DPI/Mehrmonitor, RAM-Ziel < 80 MB (nie gemessen).
- Autostart-Eintrag (wird nach `enable()` mit Anführungszeichen neu geschrieben).

## 7a. v3 (0.3.0) – Stand

Umgesetzt nach `docs/PLAN_V3_SYNC.md`, Entscheidungen D-28…D-80:
- `crates/buddy-core` (Modelle, zeitzonenfähige Erinnerungsmathe, LWW, Uhr) + gemeinsame Testvektoren
  (`tests/fixtures/*.json`, Generator `gen_schedule_vectors.py`), TypeScript-Spiegel in `src/lib/`.
- `server/` (axum + SQLite): Auth (Bearer/Cookie, CSRF, Login-Bremse), Sync, Scheduler, Web Push, FCM (Android).
- `deploy/`: Docker Compose + Caddy + Anleitung. Desktop-Sync in `src-tauri/src/sync/`.
- `src/web/`: PWA (IndexedDB, Outbox, Sync-Engine, UI, Service Worker). `mobile/`: Tauri-2-Mobile-Hülle mit lokaler
  Planung; `mobile/patches/tauri-plugin-notification` (D-76), eigenes Plugin `mobile/plugins/buddy-push` (FCM).
- CI: `.github/workflows/mobile-android.yml` (Checks, APK, Emulator-Szenarien 28/29), `mobile-ios.yml`
  (Rust für iOS, unsignierter Simulator-Build).
- Lektionen v3: Der generierte Android-Gradle-Build ruft `npm run tauri` – `mobile/package.json` ist dafür Pflicht.
  Desktop-Crate ohne `cdylib` (MinGW-Export-Limit, D-65). Plattenkontingent der Cloud ist knapp: `target/`-Ordner
  nach Gebrauch löschen. `dl.google.com` und `deb.debian.org` sind in der Cloud gesperrt (Android nur in CI,
  Docker-`apt-get` nur außerhalb).
- `tauri-plugin-notification` 2.8.0 ist auf Android fehlerhaft (`show` speichert nicht, `sourceJson` nie gesetzt
  → leere Pending-Liste, keine Wiederherstellung nach Neustart); gepatcht in `mobile/patches/` (D-76 Punkt 5/6).
  Bei Problemen im Emulator-Job druckt `mobile/e2e/emulator.mjs` App-Zustand, Plan, Alarme und Logcat.
- Server-Betrieb beim Benutzer: hinter Nginx Proxy Manager (`deploy/compose.npm.yaml`, Variante B).
- Handtests: `docs/MANUAL_TESTS.md` §26–31.

## 8. ToDo-Liste (vom Benutzer bestätigt)

- [x] **v3: Notiz-Sync, installierbare Offline-Web-App mit eigenem Web Push, native Android/iOS-Hülle
  (Erinnerungen auch ohne Internet), Erinnerungen mit eigener Zeitzone** – Plan `docs/PLAN_V3_SYNC.md`,
  Agenten-Prompts `docs/AGENT_PROMPT_V3.md`, Entscheidungen D-28…D-50. ntfy entfällt.
- [ ] **v4: Konten mit Registrierung am Desktop, Handy-Anmeldung per QR-Code, Standard-Server
  buddy.pev-point.de** – geplant: Plan `docs/PLAN_V4_ACCOUNTS.md`, Agenten-Prompts `docs/AGENT_PROMPT_V4.md`,
  Entscheidungs-Vorschläge D-85…D-106 (Benutzerantworten vom 2026-11-07).
- [ ] **Windows-CI-Build mit GitHub Actions** (`windows-latest`, MSVC-Toolchain, `npm run tauri build`):
  Installer als Release-Artefakt, optional mit Code-Signing. Ersetzt den MinGW-Cross-Build aus der
  Linux-Cloud (D-17) und macht die zusätzliche `WebView2Loader.dll` im Installer überflüssig.
  Idealerweise läuft dort auch `npm test`, `cargo test` und `cargo clippy --all-targets -- -D warnings`
  bei jedem Push.

## 9. Bekannte Einschränkungen / Ideen für v3

- Monatliche Erinnerung am 29.–31. rutscht dauerhaft auf den Monatsletzten (Modell hat kein `anchorDay`, D-27).
- Toast-Klick öffnet die Notiz nicht (Plugin bietet unter Windows keine Aktionen); Öffnen über den Buddy.
- „Heute/Morgen“-Beschriftung aktualisiert sich nicht von selbst um Mitternacht.
- Shortcut-Leiste: kein Auto-Scroll beim Ziehen, kein „Rückgängig“ beim Entfernen.
- Installer unsigniert, mit MinGW gebaut → für eine Veröffentlichung: Build unter Windows mit MSVC
  (z. B. GitHub Actions `windows-latest`, `npm run tauri build`) und Code-Signing. Das wäre ein sinnvoller
  nächster Schritt, jetzt wo das Repo auf GitHub liegt.
- Weitere Ideen des Benutzers/aus v1: Sync, Export (Markdown/PDF), Drag&Drop-Umsortieren der Notizen,
  Auto-Update.
