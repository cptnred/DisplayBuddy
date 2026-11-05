# Manuelle Tests – Display Buddy (Windows 10/11)

Checkliste für den Handtest eines Release-Builds (NSIS-Installer). Jeder Punkt hat
**Schritte** und **Erwartet**. Abhaken mit `[x]`, Abweichungen mit Datum, Windows-Version,
Bildschirm-Setup und Logauszug darunter notieren.

**Legende**

- ⚠️ **nur unter Windows prüfbar**: hängt von Fenster-/OS-Verhalten ab (Transparenz,
  Z-Order, DPI, Tray, Registry, Installer, WebView2 …) und konnte in der Linux-Build-Umgebung
  **nicht** geprüft werden. Das gilt für fast alle Punkte.
- 🧪 **teilweise automatisiert**: die Logik dahinter ist durch Unit-Tests abgedeckt
  (Vitest / `cargo test`). Der Handtest prüft das Zusammenspiel im echten Fenster.

**Bereits geprüft (Linux-Build unter Xvfb, WebKitGTK statt WebView2, 2026-11-05)**

Diese Abläufe wurden mit der echten App (Debug-Build) per Skript durchgespielt. Sie belegen
IPC, Capabilities, CSP, Events und Speicherung – **nicht** das Windows-Fensterverhalten:

- Buddy rendert nach `load_settings`, Standardposition unten rechts (Arbeitsbereich − 24 px)
- Klick auf Buddy und Strg+Alt+N öffnen/schließen das Notizfenster; links neben dem Buddy platziert
- Leerer Zustand → „Erste Notiz anlegen“ → Tippen → `notes/<uuid>.json` (TipTap-JSON) + `index.json`
- Strg+Shift+9 erzeugt Checkliste; Abhaken → durchgestrichen + abgeschwächt, `checked: true` gespeichert
- Strg+N legt weitere Notizen an; Karussell „3 / 3“ mit Seitenkarten; Strg+→ springt von 3 auf 1
- Neustart mit vorhandenen Daten: Notizen, aktive Notiz und Notizfenster-Position korrekt
- Rechtsklick → natives Menü; „Einstellungen“ öffnet das Fenster mit Live-Vorschau;
  Augen/Farbe ändern → Buddy aktualisiert sich sofort, `settings.json` geschrieben
- Tippen und 0,36 s später „Beenden“ → letzte Eingabe ist gespeichert (Flush-Handshake)

Unter Xvfb ohne Window-Manager war das Buddy-Fenster 200 × 200 statt 96 × 96 groß (GTK);
unter Windows prüfen (Punkt 2.x), dass die Fenstergröße der Smiley-Größe entspricht.

**Testumgebung (bitte ausfüllen)**

| | |
|---|---|
| Windows-Version / Build | |
| Monitore (Auflösung, Skalierung, Anordnung) | |
| Taskleistenposition | |
| WebView2-Version (`edge://version` bzw. „Apps & Features“) | |
| Installer-Datei / App-Version | |
| Tester / Datum | |

**Nützliche Pfade**

| Was | Pfad |
|---|---|
| Daten | `%APPDATA%\de.displaybuddy.desktop\` (`settings.json`, `notes\index.json`, `notes\<uuid>.json`) |
| Logs | `%LOCALAPPDATA%\de.displaybuddy.desktop\logs\` (Datei `Display Buddy.log`, max. 1 MB, 3 rotierte Dateien) |
| Programm | `%LOCALAPPDATA%\Display Buddy\display-buddy.exe` (currentUser-Installation) |
| Autostart | `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`, Wert `Display Buddy` |
| WebView2-Daten | `%LOCALAPPDATA%\de.displaybuddy.desktop\EBWebView\` |

Tipp: Pfade in Win+R oder in die Explorer-Adresszeile einfügen.

---

## 1. Installation (NSIS)

- [ ] **1.1 Installation ohne Admin-Rechte** ⚠️ nur unter Windows prüfbar
  - Schritte: Mit einem Standardbenutzer den Installer `Display Buddy_0.1.0_x64-setup.exe` starten.
  - Erwartet: Keine UAC-Abfrage (installMode `currentUser`). Installer-Sprache Deutsch
    (keine Sprachauswahl). Installiert nach `%LOCALAPPDATA%\Display Buddy\`. Startmenü-Eintrag
    „Display Buddy“; Desktop-Verknüpfung nur, wenn auf der letzten Seite angehakt.
- [ ] **1.2 WebView2 fehlt (Bootstrapper)** ⚠️ nur unter Windows prüfbar
  - Schritte: Auf einer frischen VM ohne WebView2-Runtime (z. B. Windows 10 LTSC/N, Runtime
    deinstalliert) mit Internetverbindung installieren.
  - Erwartet: Installer zeigt „Herunterladen des WebView2 Bootstrappers…“, installiert die
    Runtime still (`/silent`) und danach die App. App startet anschließend normal.
- [ ] **1.3 WebView2 fehlt, kein Internet** ⚠️ nur unter Windows prüfbar
  - Erwartet: Installer bricht mit verständlicher Fehlermeldung ab (Download fehlgeschlagen),
    es bleibt keine halbe Installation zurück.
- [ ] **1.4 WebView2 vorhanden** ⚠️ nur unter Windows prüfbar
  - Erwartet: Kein Download; Installation dauert nur wenige Sekunden.
- [ ] **1.5 Update-Installation über bestehende Version** ⚠️ nur unter Windows prüfbar
  - Schritte: App läuft, Notizen vorhanden; Installer derselben/neueren Version starten.
  - Erwartet: Installer fragt, ob die laufende App beendet werden soll (oder beendet sie);
    Notizen, Einstellungen und Autostart-Eintrag bleiben erhalten.
- [ ] **1.6 SmartScreen / Signatur** ⚠️ nur unter Windows prüfbar
  - Erwartet (unsigniert): SmartScreen-Warnung „Der Computer wurde durch Windows geschützt“ –
    dokumentieren, dass das bei unsignierten Builds normal ist.

## 2. Erster Start

Vorher `%APPDATA%\de.displaybuddy.desktop\` löschen bzw. umbenennen.

- [ ] **2.1 Buddy erscheint unten rechts** ⚠️ nur unter Windows prüfbar 🧪
  - Erwartet: Smiley (96 × 96 logische px) unten rechts im **Arbeitsbereich** des primären
    Monitors, 24 px Abstand zu rechtem Rand und Taskleiste; nie hinter der Taskleiste.
  - Kein kurzes Aufblitzen an falscher Position (Fenster wird erst nach dem Positionieren gezeigt).
- [ ] **2.2 Optik** ⚠️ nur unter Windows prüfbar
  - Erwartet: Hintergrund komplett transparent, Gesicht rund, **kein** Rahmen, **kein**
    Schatten, keine Titelleiste, keine weißen/schwarzen Ecken (auch nicht bei hellem und
    dunklem Desktop-Hintergrund, auch nicht direkt nach dem Start).
- [ ] **2.3 Immer im Vordergrund** ⚠️ nur unter Windows prüfbar
  - Schritte: Explorer, Browser maximiert darüberziehen, andere Fenster anklicken.
  - Erwartet: Buddy bleibt über normalen Fenstern sichtbar.
- [ ] **2.4 Nicht in der Taskleiste / Alt+Tab** ⚠️ nur unter Windows prüfbar
  - Erwartet: Kein Taskleisten-Button für Buddy oder Notizen; nur das Tray-Symbol
    „Display Buddy“ (ggf. im Überlauf-Bereich ^). Einstellungsfenster dagegen **hat**
    einen Taskleisten-Button.
- [ ] **2.5 Buddy stiehlt keinen Fokus** ⚠️ nur unter Windows prüfbar
  - Schritte: In Notepad tippen, App starten.
  - Erwartet: Cursor/Fokus bleibt in Notepad (`focus: false`).
- [ ] **2.6 Daten angelegt** ⚠️ nur unter Windows prüfbar
  - Erwartet: Ordner `%APPDATA%\de.displaybuddy.desktop\` existiert spätestens nach der ersten
    Änderung; `notes\` erst nach der ersten Notiz. Die automatisch berechnete Startposition wird
    **nicht** gespeichert (`buddyPosition` fehlt/ist `null`), solange der Buddy nicht bewegt wurde.

## 3. Ziehen vs. Klicken

- [ ] **3.1 Einfacher Klick** ⚠️ nur unter Windows prüfbar 🧪
  - Erwartet: Klick (linke Taste) öffnet die Notizen neben dem Buddy; zweiter Klick schließt sie.
    Bei jedem Klick ein kurzer „Hüpfer“.
- [ ] **3.2 Ziehen** ⚠️ nur unter Windows prüfbar 🧪
  - Schritte: Maustaste drücken, > 4 px bewegen, loslassen.
  - Erwartet: Buddy folgt der Maus flüssig; beim Loslassen öffnet/schließt sich das
    Notizfenster **nicht**.
- [ ] **3.3 Zittriger Klick** ⚠️ nur unter Windows prüfbar 🧪
  - Schritte: Klicken und dabei die Maus 1–3 px bewegen (Touchpad, Stift, Touch).
  - Erwartet: Zählt als Klick (Notizen öffnen sich), Buddy bewegt sich nicht.
- [ ] **3.4 Kein Fehlauslösen** ⚠️ nur unter Windows prüfbar
  - Schritte: Schnell 10× hintereinander klicken; Doppelklick; Rechtsklick; mittlere Taste.
  - Erwartet: Notizen toggeln bei jedem Klick genau einmal, nie „hängendes“ Ziehen; Doppelklick
    maximiert nichts; Rechtsklick öffnet nur das Kontextmenü; mittlere Taste tut nichts.
- [ ] **3.5 Ziehen über Monitorgrenzen** ⚠️ nur unter Windows prüfbar
  - Schritte: Buddy auf einen zweiten Monitor mit anderer Skalierung ziehen und zurück.
  - Erwartet: Buddy wechselt den Monitor ohne Springen; Größe passt sich der Skalierung an
    (gleiche *physische* Größe in cm, z. B. 96 px bei 100 % → 144 px bei 150 %), keine
    abgeschnittenen Ränder, kein Flackern danach.
- [ ] **3.6 Notizen offen beim Ziehen** ⚠️ nur unter Windows prüfbar
  - Erwartet: Notizfenster bleibt an seiner Stelle (es wird erst beim nächsten Öffnen neu
    neben dem Buddy platziert).
- [ ] **3.7 Klick nach Fokusverlust-Ausblenden** ⚠️ nur unter Windows prüfbar
  - Schritte: Einstellung „Notizen bei Fokusverlust ausblenden“ an, nicht angeheftet; Notizen
    öffnen; auf den Buddy klicken.
  - Erwartet: Notizen schließen sich (genau einmal) und öffnen sich **nicht** sofort wieder.

## 4. Position merken / Monitore

- [ ] **4.1 Position nach Neustart** ⚠️ nur unter Windows prüfbar 🧪
  - Schritte: Buddy an eine beliebige Stelle ziehen, > 0,5 s warten, über Tray beenden,
    neu starten.
  - Erwartet: Buddy erscheint exakt an derselben Stelle (`buddyPosition` in `settings.json`,
    physische Pixel).
- [ ] **4.2 Position direkt vor dem Beenden** ⚠️ nur unter Windows prüfbar
  - Schritte: Buddy ziehen und sofort (< 300 ms) per Tastatur/Tray beenden.
  - Erwartet: Auch diese letzte Position wird wiederhergestellt.
- [ ] **4.3 Zweiter Monitor abgesteckt** ⚠️ nur unter Windows prüfbar 🧪
  - Schritte: Buddy auf Monitor 2 ziehen, App beenden, Monitor 2 abstecken (bzw. in den
    Anzeigeeinstellungen trennen), App starten.
  - Erwartet: Buddy erscheint unten rechts auf dem primären Monitor (nicht unsichtbar
    außerhalb). Nach erneutem Anstecken bleibt er dort, bis er bewegt wird.
- [ ] **4.4 Buddy halb außerhalb** ⚠️ nur unter Windows prüfbar 🧪
  - Schritte: Buddy so weit an den Rand ziehen, dass < 50 % sichtbar sind; Neustart.
  - Erwartet: Liegt der Mittelpunkt noch auf einem Monitor → gleiche Position; sonst Reset
    unten rechts.
- [ ] **4.5 Auflösung/Skalierung geändert** ⚠️ nur unter Windows prüfbar
  - Schritte: Buddy rechts unten, App beenden, Auflösung verkleinern, starten.
  - Erwartet: Buddy ist sichtbar (ggf. Reset unten rechts).
- [ ] **4.6 Minimiert-Koordinaten** ⚠️ nur unter Windows prüfbar
  - Schritte: Win+D (Desktop anzeigen), dann App über Tray beenden, neu starten.
  - Erwartet: Buddy erscheint an der alten Position, nicht bei (-32000, -32000) / unten rechts.

## 5. Mehrere Monitore & DPI (100 % / 150 %)

Setup: Monitor A 100 %, Monitor B 150 % (Einstellungen → Anzeige → Skalierung). Wenn möglich
auch 125 % und 175 % sowie unterschiedliche Anordnungen (B links von A → negative Koordinaten,
B oberhalb).

- [ ] **5.1 Buddy-Größe** ⚠️ nur unter Windows prüfbar
  - Erwartet: Auf beiden Monitoren gleich groß *wirkend*, scharf (nicht verschwommen skaliert).
    Einstellung „Größe“ 48 / 96 / 192 auf beiden Monitoren prüfen; beim Ändern bleibt der
    **Mittelpunkt** des Smileys stehen.
- [ ] **5.2 Notizen links vom Buddy** ⚠️ nur unter Windows prüfbar 🧪
  - Schritte: Buddy unten rechts, klicken.
  - Erwartet: Notizen erscheinen **links** neben dem Buddy, 12 px (logisch) Abstand,
    Unterkanten bündig, vollständig im Arbeitsbereich.
- [ ] **5.3 Notizen rechts vom Buddy** ⚠️ nur unter Windows prüfbar 🧪
  - Schritte: Buddy an den linken Bildschirmrand ziehen, klicken.
  - Erwartet: Notizen erscheinen **rechts** neben dem Buddy.
- [ ] **5.4 Nahe Bildschirmrändern** ⚠️ nur unter Windows prüfbar 🧪
  - Schritte: Buddy oben links, oben rechts, ganz oben mittig, auf einem kleinen Monitor
    (z. B. 1366 × 768 @ 150 %) und mit sehr großem Notizfenster testen.
  - Erwartet: Notizfenster ragt nie über den Arbeitsbereich hinaus und nie unter die
    Taskleiste; passt es auf keine Seite, wird es in den Arbeitsbereich geschoben (darf dann
    den Buddy überdecken).
- [ ] **5.5 Notizen auf Monitor mit anderer Skalierung** ⚠️ nur unter Windows prüfbar
  - Schritte: Notizen auf Monitor A (100 %) öffnen und schließen; Buddy auf Monitor B (150 %)
    ziehen; Notizen öffnen. Danach umgekehrt.
  - Erwartet: Notizen erscheinen auf dem Monitor des Buddys, korrekt neben ihm, vollständig im
    Arbeitsbereich, in sinnvoller Größe (logisch gleich groß). Die Position wird aus der logischen
    Größe × Skalierung des Zielmonitors berechnet (Fix nach Review); Abweichungen mit
    Screenshot melden.
- [ ] **5.6 Taskleiste an anderen Seiten** ⚠️ nur unter Windows prüfbar
  - Schritte: (Windows 10: Taskleiste links/oben/rechts; Windows 11: nur unten, ggf. automatisch
    ausblenden) – erster Start (Daten gelöscht) und Notizen öffnen.
  - Erwartet: Buddy-Standardposition und Notizen respektieren den Arbeitsbereich (nie hinter der
    Taskleiste). Bei „Taskleiste automatisch ausblenden“ liegt der Buddy 24 px über dem Rand.
- [ ] **5.7 Notizfenster-Größe gemerkt** ⚠️ nur unter Windows prüfbar
  - Schritte: Notizfenster am Rand größer ziehen, schließen, App neu starten, öffnen.
  - Erwartet: Gleiche (logische) Größe; Mindestgröße 320 × 360 lässt sich nicht unterschreiten.

## 6. Vollbild-Anwendungen

- [ ] **6.1 Video im Browser-Vollbild (F11 / YouTube-Vollbild)** ⚠️ nur unter Windows prüfbar
  - Erwartet: Das ist „randloses Fenster-Vollbild“ → der Buddy (always on top) bleibt
    **sichtbar** über dem Video. Das ist das erwartete Verhalten von always-on-top; über das
    Tray „Buddy ein-/ausblenden“ kann er versteckt werden. Dokumentieren, ob das stört.
- [ ] **6.2 Spiel im exklusiven Vollbild** ⚠️ nur unter Windows prüfbar
  - Erwartet: Bei echtem exklusivem Vollbild (DirectX exclusive) ist der Buddy **nicht**
    sichtbar (Windows zeigt keine anderen Fenster). Beim Alt+Tab zurück zum Desktop ist der
    Buddy wieder da, an alter Position, keine Abstürze. Bei „randlos/Fenster-Vollbild“ im Spiel
    ist er sichtbar (wie 6.1).
- [ ] **6.3 PowerPoint-Präsentation (F5)** ⚠️ nur unter Windows prüfbar
  - Erwartet: Buddy ist in der Regel über der Präsentation sichtbar (PowerPoint nutzt kein
    exklusives Vollbild). Notieren. Bei Präsentationen über Beamer (Erweitern): Buddy bleibt auf
    seinem Monitor.
- [ ] **6.4 Klicks im Vollbild** ⚠️ nur unter Windows prüfbar
  - Erwartet: Klick auf den Buddy im Vollbild-Video öffnet die Notizen (ebenfalls always on top);
    danach lässt sich das Video normal weiterbedienen.

## 7. Durchklicken der transparenten Ecken

> Experimentell und standardmäßig **aus**. Vor diesen Tests in den Einstellungen
> „Klicks auf die transparenten Ecken des Buddys durchlassen (experimentell)“ einschalten.
> Zusätzlich prüfen: kein Flackern/Verschwinden des Buddys beim Überfahren der Ecken
> (tao schaltet dafür `WS_EX_TRANSPARENT | WS_EX_LAYERED` um).

- [ ] **7.1 Ecken klicken durch** ⚠️ nur unter Windows prüfbar 🧪
  - Schritte: Buddy über ein Desktop-Symbol / einen Link legen, so dass das Ziel in einer
    **Ecke** des quadratischen Fensters (außerhalb des Kreises) liegt; dort klicken.
  - Erwartet: Der Klick erreicht das Element darunter (Symbol wird markiert / Link geöffnet).
    Hinweis: Durchklickbar ist alles außerhalb des dem Fenster einbeschriebenen Kreises; der
    schmale transparente Ring zwischen Gesicht (≈ 84 %) und Fensterkreis fängt Klicks noch ab.
- [ ] **7.2 Gesicht bleibt klickbar** ⚠️ nur unter Windows prüfbar
  - Erwartet: Klick/Ziehen/Rechtsklick auf dem Gesicht funktionieren weiter, auch direkt nach
    einem Klick in die Ecke (Umschaltung alle ~30 ms).
- [ ] **7.3 Hover nur auf dem Gesicht** ⚠️ nur unter Windows prüfbar
  - Erwartet: Maus in der Ecke → keine Hover-Animation.

## 8. Animationen

- [ ] **8.1 Hover** ⚠️ nur unter Windows prüfbar
  - Erwartet: Maus über dem Gesicht → leichte Vergrößerung/Reaktion; wird nicht abgeschnitten.
- [ ] **8.2 Blinzeln** ⚠️ nur unter Windows prüfbar 🧪
  - Erwartet: Zufällig alle 3–7 s ein kurzes Blinzeln; nicht synchron/mechanisch.
- [ ] **8.3 Hüpfen beim Klick** ⚠️ nur unter Windows prüfbar
  - Erwartet: Kurzer Hüpfer, nicht abgeschnitten, kein Ruckeln. Animationsgeschwindigkeit
    0,5× / 2× in den Einstellungen wirkt sichtbar.
- [ ] **8.4 Ruhiger Modus** ⚠️ nur unter Windows prüfbar 🧪
  - Schritte: Einstellungen → „Ruhiger Modus (keine Animationen)“ an.
  - Erwartet: Kein Blinzeln, kein Hüpfen, keine Hover-Bewegung. Klick funktioniert weiter.
- [ ] **8.5 Windows „Animationseffekte“ aus** ⚠️ nur unter Windows prüfbar 🧪
  - Schritte: Windows 11: Einstellungen → Barrierefreiheit → Visuelle Effekte →
    „Animationseffekte“ aus (Windows 10: Erleichterte Bedienung → Anzeige → „Animationen in
    Windows anzeigen“ aus). App neu starten **und** ohne Neustart umschalten.
  - Erwartet: WebView2 meldet `prefers-reduced-motion: reduce` → Smiley animiert nicht
    (auch wenn „Ruhiger Modus“ aus ist), Karussell wechselt ohne Gleitanimation.
- [ ] **8.6 Idle-Last durch Animationen** ⚠️ nur unter Windows prüfbar
  - siehe 17.1 – Animationen dürfen die CPU im Leerlauf nicht dauerhaft belasten.

## 9. Kontextmenü (Rechtsklick auf Buddy)

- [ ] **9.1 Menü** ⚠️ nur unter Windows prüfbar
  - Erwartet: Natives Windows-Menü an der Mausposition (nicht abgeschnitten) mit
    „Neue Notiz“, „Einstellungen“, „Beenden“. Kein Browser-Kontextmenü („Zurück“, „Untersuchen“).
- [ ] **9.2 „Neue Notiz“** ⚠️ nur unter Windows prüfbar
  - Erwartet: Notizfenster öffnet sich mit einer neuen, leeren Notiz; Cursor im Editor.
- [ ] **9.3 „Einstellungen“** ⚠️ nur unter Windows prüfbar
  - Erwartet: Einstellungsfenster öffnet sich zentriert; erneuter Aufruf fokussiert das
    bestehende Fenster (kein zweites).
- [ ] **9.4 „Beenden“** ⚠️ nur unter Windows prüfbar
  - Erwartet: App beendet sich vollständig (Tray-Symbol weg, kein Prozess im Task-Manager).
- [ ] **9.5 Menü schließen** ⚠️ nur unter Windows prüfbar
  - Erwartet: Esc oder Klick daneben schließt das Menü ohne Aktion.

## 10. Editor

Alle Kürzel auf **deutscher Tastatur** prüfen.

- [ ] **10.1 Fett / Kursiv / Unterstrichen / Durchgestrichen** ⚠️ nur unter Windows prüfbar 🧪
  - Schritte: Text markieren; Strg+B, Strg+I, Strg+U, Strg+Umschalt+S; zusätzlich Toolbar-Buttons.
  - Erwartet: Formatierung umschaltbar; Button zeigt aktiven Zustand; Strg+B öffnet **keine**
    Browser-Lesezeichen, Strg+I keine Browser-Funktion.
- [ ] **10.2 Schriftgröße** ⚠️ nur unter Windows prüfbar 🧪
  - Erwartet: Auswahl 12/14/16/18/24/32 px und „Standard“ wirkt auf Markierung; Auswahl zeigt die
    Größe an der Cursorposition.
- [ ] **10.3 Textfarbe** ⚠️ nur unter Windows prüfbar 🧪
  - Erwartet: Palette mit 8 Farben + „Farbe entfernen“; Esc schließt nur die Palette (nicht das
    Notizfenster); Klick daneben schließt sie; Markierung bleibt erhalten.
- [ ] **10.4 Nummerierung – Strg+Umschalt+7** ⚠️ nur unter Windows prüfbar 🧪
  - Hinweis: Auf deutscher Tastatur ist Umschalt+7 = „/“. Erwartet: Nummerierte Liste wird
    umgeschaltet, es wird **kein** „/“ eingefügt.
- [ ] **10.5 Aufzählung – Strg+Umschalt+8** ⚠️ nur unter Windows prüfbar 🧪
  - Hinweis: Umschalt+8 = „(“. Erwartet: Aufzählung, kein „(“.
- [ ] **10.6 Checkliste – Strg+Umschalt+9** ⚠️ nur unter Windows prüfbar 🧪
  - Hinweis: Umschalt+9 = „)“. Erwartet: Checkliste, kein „)“.
- [ ] **10.7 AltGr-Zeichen** ⚠️ nur unter Windows prüfbar
  - Schritte: AltGr+Q (@), AltGr+E (€), AltGr+7/8/9/0 ({[]}), AltGr+ß (\), Umlaute, ß.
  - Erwartet: Zeichen werden normal eingefügt (AltGr = Strg+Alt löst keine Kürzel aus, auch
    nicht Strg+Alt+N).
- [ ] **10.8 Checkliste verschachteln mit Tab** ⚠️ nur unter Windows prüfbar 🧪
  - Schritte: Checkliste mit 3 Punkten; im 2. Punkt Tab, im 3. zweimal Tab; Umschalt+Tab.
  - Erwartet: Einrückung/Ausrückung je Ebene; Tab im ersten Punkt bleibt im Editor (Fokus springt
    nicht in die Toolbar); außerhalb von Listen springt Tab zum nächsten Bedienelement.
    Abhaken per Klick auf die Checkbox: erledigte Punkte durchgestrichen und blasser.
- [ ] **10.9 Rückgängig / Wiederholen** ⚠️ nur unter Windows prüfbar 🧪
  - Erwartet: Strg+Z, Strg+Y, Strg+Umschalt+Z und Toolbar-Buttons; Buttons deaktiviert, wenn
    nichts rückgängig zu machen ist. Undo-Verlauf gilt pro Notiz (nach Notizwechsel neu).
- [ ] **10.10 Einfügen aus Word/Browser** ⚠️ nur unter Windows prüfbar
  - Erwartet: Fett/Kursiv/Listen bleiben, nicht unterstützte Elemente (Überschriften, Bilder,
    Tabellen, Links) werden zu normalem Text; keine Abstürze, keine externen Bilder geladen (CSP).
- [ ] **10.11 Titel** ⚠️ nur unter Windows prüfbar
  - Erwartet: Eigenes Titelfeld über dem Editor; leerer Titel → Seitenkarten zeigen „Ohne Titel“.
    Enter im Titel springt nicht zu einer neuen Notiz.
- [ ] **10.12 Notizfarbe** ⚠️ nur unter Windows prüfbar
  - Erwartet: 6 Pastellfarben (Gelb, Rosa, Blau, Grün, Lila, Orange) – Karte färbt sich sofort,
    wird gespeichert.
- [ ] **10.13 Rechtschreibprüfung / Browser-Kontextmenü im Editor** ⚠️ nur unter Windows prüfbar
  - Notieren, ob Rechtsklick im Editor ein Menü zeigt (Kopieren/Einfügen) und ob es sinnvoll ist.

## 11. Karussell

- [ ] **11.1 0 Notizen** ⚠️ nur unter Windows prüfbar 🧪
  - Erwartet: Leerzustand „Noch keine Notizen“ mit Button „Erste Notiz anlegen“; Indikator
    „0 / 0“; keine Pfeile; „Löschen“ deaktiviert.
- [ ] **11.2 1 Notiz** ⚠️ nur unter Windows prüfbar 🧪
  - Erwartet: Nur die aktive Karte, „1 / 1“, keine Pfeile, keine Seitenkarten; Strg+←/→ tut nichts.
- [ ] **11.3 2 Notizen** ⚠️ nur unter Windows prüfbar 🧪
  - Erwartet: Die andere Notiz erscheint **genau einmal** (rechts, „Nächste Notiz“), nie doppelt
    links und rechts; Weiterblättern wechselt sauber hin und her.
- [ ] **11.4 3 Notizen** ⚠️ nur unter Windows prüfbar 🧪
  - Erwartet: Links und rechts je eine Seitenkarte; Endlos-Wechsel ohne Sprung/„Durchfliegen“.
- [ ] **11.5 10 Notizen** ⚠️ nur unter Windows prüfbar 🧪
  - Erwartet: Coverflow mit je einer Seitenkarte sichtbar; flüssiges Blättern (≥ 30 fps gefühlt),
    „x / 10“ stimmt.
- [ ] **11.6 Wraparound** ⚠️ nur unter Windows prüfbar 🧪
  - Erwartet: Von 10/10 vorwärts → 1/10; von 1/10 rückwärts → 10/10; Karten fliegen dabei nicht
    quer über den Stapel (blenden ein).
- [ ] **11.7 Mausrad / Touchpad** ⚠️ nur unter Windows prüfbar 🧪
  - Schritte: Mausrad über einer Seitenkarte; horizontales Wischen auf dem Touchpad.
  - Erwartet: Ein Schritt pro Rastung (gedrosselt, kein Durchrasen bei Präzisions-Touchpads);
    Mausrad über der aktiven Karte scrollt den Notizinhalt, blättert nicht.
- [ ] **11.8 Klick / Enter auf Seitenkarte** ⚠️ nur unter Windows prüfbar 🧪
  - Erwartet: Seitenkarte wird aktiv.
- [ ] **11.9 Strg+← / Strg+→ im Editor** ⚠️ nur unter Windows prüfbar 🧪
  - Schritte: Cursor mitten im Text, Strg+→.
  - Erwartet: Wechselt zur nächsten Notiz (nicht wortweise springen); Fokus im Editor der neuen
    Notiz. Gleiches im Titelfeld.
- [ ] **11.10 Umsortieren Strg+Umschalt+← / →** ⚠️ nur unter Windows prüfbar 🧪
  - Erwartet: Aktive Notiz tauscht mit Nachbarin (auch über die Enden), bleibt aktiv; Reihenfolge
    nach Neustart erhalten (`notes\index.json`). Keine Textmarkierung entsteht.
- [ ] **11.11 Löschen mit Bestätigung** ⚠️ nur unter Windows prüfbar 🧪
  - Erwartet: „Löschen“ → Dialog „Notiz wirklich löschen?“; Abbrechen/Esc → nichts passiert
    (Esc schließt nur den Dialog, nicht das Fenster); Bestätigen → Notiz weg, nächste Notiz aktiv,
    Datei `notes\<uuid>.json` gelöscht. Fokus landet sinnvoll (nicht im Nichts).
- [ ] **11.12 Neue Notiz Strg+N** ⚠️ nur unter Windows prüfbar 🧪
  - Erwartet: Neue Notiz direkt **nach** der aktiven, wird aktiv, Fokus im Editor; öffnet kein
    neues WebView-Fenster.
- [ ] **11.13 Aktive Notiz nach Neustart** ⚠️ nur unter Windows prüfbar
  - Erwartet: Nach Neustart ist die zuletzt aktive Notiz wieder aktiv.

## 12. Autosave & Datensicherheit

- [ ] **12.1 Autosave** ⚠️ nur unter Windows prüfbar 🧪
  - Schritte: Text tippen, ~0,5 s warten; `notes\<uuid>.json` im Editor (z. B. Notepad++) neu laden.
  - Erwartet: Inhalt und `updatedAt` aktualisiert; nur eine Datei pro Notiz; keine `.tmp`-Reste.
- [ ] **12.2 Prozess hart beenden** ⚠️ nur unter Windows prüfbar 🧪
  - Schritte: Tippen, **> 0,5 s** warten, Task-Manager → „Display Buddy“ → Task beenden
    (alle zugehörigen Prozesse, auch `msedgewebview2.exe`), neu starten.
  - Erwartet: Der getippte Inhalt ist vollständig vorhanden; keine beschädigte Datei
    (atomares Schreiben). Wiederholen mit `taskkill /F /IM display-buddy.exe`.
- [ ] **12.3 Schnelles Wechseln beim Tippen** ⚠️ nur unter Windows prüfbar 🧪
  - Schritte: In Notiz A tippen und sofort (< 0,5 s) mit Strg+→ zu B, dort tippen, sofort zurück,
    mehrfach. Dann App beenden und neu starten.
  - Erwartet: Jede Notiz enthält genau ihren Text; nichts landet in der falschen Notiz, nichts
    fehlt, kein älterer Stand überschreibt einen neueren.
- [ ] **12.4 Beenden über Tray während des Tippens** ⚠️ nur unter Windows prüfbar 🧪
  - Schritte: Tippen und **innerhalb von 0,5 s** Tray → „Beenden“ (bzw. Kontextmenü „Beenden“).
  - Erwartet: Nach Neustart ist auch der zuletzt getippte Text da (Flush-Handshake; App wartet
    max. 1,5 s).
- [ ] **12.5 Schließen/Esc während des Tippens** ⚠️ nur unter Windows prüfbar 🧪
  - Erwartet: Tippen → sofort Esc → Prozess per Task-Manager beenden → Text ist da.
- [ ] **12.6 Neustart mit Daten** ⚠️ nur unter Windows prüfbar
  - Schritte: 10 Notizen mit Formatierung, Checklisten (verschachtelt, teils abgehakt), Farben,
    Schriftgrößen anlegen; neu starten.
  - Erwartet: Alles identisch, Reihenfolge und aktive Notiz erhalten.
- [ ] **12.7 Abmelden / Herunterfahren** ⚠️ nur unter Windows prüfbar
  - Schritte: Tippen, ~1 s warten, Windows abmelden bzw. neu starten.
  - Erwartet: Inhalt nach erneuter Anmeldung vorhanden; Windows wartet nicht auf die App
    („Diese App verhindert das Herunterfahren“ darf höchstens kurz erscheinen).
- [ ] **12.8 Schreibgeschützter/voller Datenträger** ⚠️ nur unter Windows prüfbar
  - Schritte (optional): `notes\<uuid>.json` schreibgeschützt setzen, tippen.
  - Erwartet: App stürzt nicht ab; Fehler im Log; nach Aufheben des Schreibschutzes wird wieder
    gespeichert.

## 13. Tray

- [ ] **13.1 Symbol & Tooltip** ⚠️ nur unter Windows prüfbar
  - Erwartet: App-Symbol scharf (auch bei 150 %), Tooltip „Display Buddy“.
- [ ] **13.2 Linksklick** ⚠️ nur unter Windows prüfbar
  - Erwartet: Notizen ein/aus (wie Buddy-Klick); mit „bei Fokusverlust ausblenden“ kein
    sofortiges Wiederöffnen.
- [ ] **13.3 Rechtsklick-Menü** ⚠️ nur unter Windows prüfbar
  - Erwartet in dieser Reihenfolge: „Notizen öffnen“, „Neue Notiz“, „Buddy ein-/ausblenden“,
    „Einstellungen“, Trenner, „Mit Windows starten“ (Häkchen), Trenner, „Beenden“.
    Jeder Eintrag tut, was er sagt. „Buddy ein-/ausblenden“ versteckt/zeigt nur den Smiley
    (Notizen per Tray weiterhin erreichbar).
- [ ] **13.4 Explorer-Neustart** ⚠️ nur unter Windows prüfbar
  - Schritte: Task-Manager → „Windows-Explorer“ → Neu starten.
  - Erwartet: Tray-Symbol erscheint wieder (sonst als Befund notieren).

## 14. Autostart

- [ ] **14.1 Einschalten** ⚠️ nur unter Windows prüfbar
  - Schritte: Tray → „Mit Windows starten“ anhaken (oder in den Einstellungen).
  - Erwartet: `regedit` → `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` enthält Wert
    „Display Buddy“ = `"C:\Users\<name>\AppData\Local\Display Buddy\display-buddy.exe" --autostart`
    (Pfad **in Anführungszeichen**).
    Häkchen in Tray **und** Einstellungsfenster synchron (auch wenn Einstellungen gerade offen
    sind).
  - **Besonders prüfen:** `tauri-plugin-autostart` 2.7 / `auto-launch` 0.6 schreibt den Pfad
    ohne Anführungszeichen; die App überschreibt den HKCU-Wert direkt danach (und bei jedem
    Start) mit gequotetem Pfad (`src-tauri/src/autostart.rs`). Registry-Wert notieren und in
    14.2 verifizieren, dass der Autostart wirklich startet.
  - Läuft die App **als Administrator** (erhöht), schreibt das Plugin (Modus „Dynamic“) nach
    `HKLM\…\Run` statt `HKCU`. Einmal erhöht testen und notieren (der Uninstaller entfernt nur
    den HKCU-Wert, s. 19.3).
- [ ] **14.2 Neustart** ⚠️ nur unter Windows prüfbar
  - Erwartet: Nach Windows-Neustart/Anmeldung erscheint der Buddy ohne Notizfenster; Log enthält
    „started by autostart“.
- [ ] **14.3 Ausschalten** ⚠️ nur unter Windows prüfbar
  - Erwartet: Registry-Wert entfernt; kein Start nach Neustart.
- [ ] **14.4 Extern deaktiviert** ⚠️ nur unter Windows prüfbar
  - Schritte: Task-Manager → Autostart → „Display Buddy“ deaktivieren bzw. Registry-Wert löschen;
    App neu starten.
  - Erwartet: Häkchen spiegelt den tatsächlichen Zustand (OS ist maßgeblich). Notieren, wie sich
    „im Task-Manager deaktiviert“ (StartupApproved) auswirkt.

## 15. Einzelinstanz & globales Kürzel

- [ ] **15.1 Zweiter Start** ⚠️ nur unter Windows prüfbar
  - Schritte: App läuft; im Startmenü erneut „Display Buddy“ starten.
  - Erwartet: Kein zweiter Buddy/Tray-Symbol; das Notizfenster der laufenden Instanz öffnet sich
    und bekommt den Fokus (auch wenn es schon offen war).
- [ ] **15.2 Strg+Alt+N** ⚠️ nur unter Windows prüfbar
  - Erwartet: Aus jeder Anwendung toggelt Strg+Alt+N das Notizfenster. Einstellungen →
    Kürzel aus → Strg+Alt+N tut nichts mehr (und steht anderen Apps wieder zur Verfügung);
    wieder an → funktioniert ohne Neustart. Einstellung bleibt nach Neustart.
- [ ] **15.3 Kürzel belegt** ⚠️ nur unter Windows prüfbar
  - Schritte: Andere App belegt Strg+Alt+N zuerst, dann Display Buddy starten.
  - Erwartet: Kein Absturz; Warnung im Log.

## 16. Einstellungsfenster

- [ ] **16.1 Live-Vorschau** ⚠️ nur unter Windows prüfbar 🧪
  - Erwartet: Gesichtsfarbe (Vorgaben + „Eigene Gesichtsfarbe“), Augen, Mund, Größe,
    Deckkraft, Animationsgeschwindigkeit, Ruhiger Modus ändern sofort die Vorschau **und** den
    echten Buddy (Farbwähler: nach kurzer Verzögerung).
- [ ] **16.2 Persistenz** ⚠️ nur unter Windows prüfbar 🧪
  - Erwartet: Nach Schließen und Neustart sind alle Werte erhalten (`settings.json`).
- [ ] **16.3 Fenster** ⚠️ nur unter Windows prüfbar
  - Erwartet: Normales Fenster mit Rahmen, 520 × 640, zentriert, in Taskleiste, nicht always on
    top, Mindestgröße 420 × 480; Schließen beendet **nicht** die App.
- [ ] **16.4 Deckkraft 30 %** ⚠️ nur unter Windows prüfbar
  - Erwartet: Buddy halbtransparent, Ecken weiterhin voll transparent, klickbar.
- [ ] **16.5 Fokusverlust-Option** ⚠️ nur unter Windows prüfbar
  - Erwartet: „Notizen bei Fokusverlust ausblenden (außer angeheftet)“ an → Klick auf den Desktop
    blendet die Notizen aus; mit „Anheften“ bleiben sie offen. Aus (Standard) → bleiben offen.

## 17. Robustheit & Speicherorte

- [ ] **17.1 Beschädigte Notizdatei** ⚠️ nur unter Windows prüfbar 🧪
  - Schritte: App beenden; `notes\<uuid>.json` in Notepad öffnen, z. B. die letzte `}` löschen,
    speichern; App starten.
  - Erwartet: App startet normal; die Notiz fehlt im Karussell; Datei wurde zu
    `<uuid>.json.corrupt` umbenannt (bei Wiederholung `<uuid>.json.<unixzeit>.corrupt`);
    Warnung im Log; `index.json` ohne diese ID. Andere Notizen unverändert.
- [ ] **17.2 Beschädigte settings.json** ⚠️ nur unter Windows prüfbar 🧪
  - Erwartet: Start mit Standardeinstellungen (Buddy unten rechts), `settings.json.corrupt`
    angelegt. Einzelner falscher Wert (z. B. `"size": "riesig"`) → nur dieser Wert auf Standard,
    Rest bleibt.
- [ ] **17.3 Beschädigte index.json** ⚠️ nur unter Windows prüfbar 🧪
  - Erwartet: Alle Notizen erscheinen wieder (nach Erstellungsdatum sortiert), Index wird neu
    geschrieben, `index.json.corrupt` vorhanden.
- [ ] **17.4 Fremde Dateien im notes-Ordner** ⚠️ nur unter Windows prüfbar 🧪
  - Schritte: `test.json`, `Kopie von <uuid>.json`, Unterordner anlegen.
  - Erwartet: Werden ignoriert; kein Absturz.
- [ ] **17.5 Datenordner** ⚠️ nur unter Windows prüfbar
  - Erwartet: Daten ausschließlich unter `%APPDATA%\de.displaybuddy.desktop\` (Roaming), Dateien
    lesbar formatiertes UTF-8-JSON (Umlaute/Emoji im Klartext).
- [ ] **17.6 Logdatei** ⚠️ nur unter Windows prüfbar
  - Erwartet: `%LOCALAPPDATA%\de.displaybuddy.desktop\logs\Display Buddy.log` existiert, enthält
    „data dir: …“ beim Start; Level Info (kein Debug-Spam im Release); rotiert ab 1 MB.

## 18. Leistung

- [ ] **18.1 Leerlauf-CPU < 1 %** ⚠️ nur unter Windows prüfbar
  - Messung: App starten, Notizen geschlossen, 60 s nicht anfassen. Task-Manager → „Details“
    (nicht „Prozesse“, dort werden Gruppen zusammengefasst) → Spalten „CPU“ und
    „Arbeitsspeicher (privater Arbeitssatz)“. Relevant sind `display-buddy.exe` **und alle**
    `msedgewebview2.exe`-Prozesse, deren Befehlszeile `--webview-exe-name=display-buddy.exe`
    bzw. `de.displaybuddy.desktop` enthält (Spalte „Befehlszeile“ einblenden). Alternativ im
    Ressourcenmonitor oder mit Process Explorer (Prozessbaum unter `display-buddy.exe`).
    Für eine stabile Zahl: Leistungsmonitor (`perfmon`) → Prozess → „% Prozessorzeit“ über
    60 s mitteln (Summe aller Prozesse, geteilt durch Kernanzahl).
  - Erwartet: Summe < 1 % CPU im Mittel (kurze Spitzen beim Blinzeln ok). Auch mit Ruhigem Modus
    und mit offenem Notizfenster messen.
- [ ] **18.2 RAM < 80 MB** ⚠️ nur unter Windows prüfbar
  - Messung: wie 18.1, „Arbeitsspeicher (privater Arbeitssatz)“ von `display-buddy.exe` und allen
    zugehörigen `msedgewebview2.exe` addieren – einmal nur Buddy (Notizen nie geöffnet),
    einmal nach Öffnen der Notizen mit 10 Notizen, einmal mit offenem Einstellungsfenster.
  - Erwartet: Zielwert < 80 MB gesamt im Leerlauf. Werte aller drei Messungen notieren
    (WebView2 teilt sich Browser-/GPU-Prozesse; ein Wert knapp darüber ist als Befund zu melden,
    nicht als Blocker).
- [ ] **18.3 Startzeit < 1,5 s** ⚠️ nur unter Windows prüfbar
  - Messung: Nach einem Warmstart (App einmal gestartet und beendet) per Startmenü starten und mit
    Stoppuhr/Bildschirmaufnahme (60 fps) bis zur Sichtbarkeit des Buddys messen; zusätzlich
    Zeitstempel im Log („data dir“) vs. Prozessstart (Task-Manager → Details → Spalte
    „Startzeit“ ist nur minutengenau, daher Video bevorzugen). Kaltstart nach Neustart separat
    notieren.
  - Erwartet: Warmstart < 1,5 s bis der Buddy sichtbar ist.
- [ ] **18.4 Langzeit** ⚠️ nur unter Windows prüfbar
  - Erwartet: Nach 8 h Laufzeit (inkl. Standby/Ruhezustand) kein Speicherzuwachs > 20 MB,
    Buddy reagiert, Animationen laufen weiter.

## 19. Deinstallation

- [ ] **19.1 Deinstallieren ohne Datenlöschung** ⚠️ nur unter Windows prüfbar
  - Schritte: App läuft; Einstellungen → Apps → „Display Buddy“ → Deinstallieren. Checkbox
    „Lösche die Anwendungsdaten“ **nicht** anhaken.
  - Erwartet (Verhalten des Tauri-NSIS-Uninstallers): fragt, ob die laufende App beendet werden
    soll; entfernt `display-buddy.exe`, Uninstaller, Programmordner, Startmenü- und
    Desktop-Verknüpfung, „Apps & Features“-Eintrag **und** den Autostart-Wert
    `HKCU\…\Run\Display Buddy`. **Daten bleiben erhalten**:
    `%APPDATA%\de.displaybuddy.desktop\` (Notizen, Einstellungen) und
    `%LOCALAPPDATA%\de.displaybuddy.desktop\` (Logs, WebView2-Cache). Eine Neuinstallation zeigt
    die alten Notizen wieder.
- [ ] **19.2 Deinstallieren mit Datenlöschung** ⚠️ nur unter Windows prüfbar
  - Schritte: wie 19.1, Checkbox „Lösche die Anwendungsdaten“ **anhaken**.
  - Erwartet: Zusätzlich werden `%APPDATA%\de.displaybuddy.desktop\` und
    `%LOCALAPPDATA%\de.displaybuddy.desktop\` vollständig gelöscht.
- [ ] **19.3 Reste** ⚠️ nur unter Windows prüfbar
  - Erwartet: Kein Tray-Symbol, kein Prozess, kein Autostart nach Neustart. Notieren, ob unter
    `HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run` ein Wert
    „Display Buddy“ zurückbleibt (wird vom Autostart-Plugin gesetzt, vom Uninstaller nicht
    entfernt – harmlos, aber als Rest dokumentieren). War Autostart einmal erhöht aktiviert
    (s. 14.1), bleibt ein Wert unter `HKLM\…\Run` zurück → als Befund melden.

## 20. Barrierefreiheit

- [ ] **20.1 Notizfenster nur mit Tastatur** ⚠️ nur unter Windows prüfbar
  - Schritte: Strg+Alt+N, dann nur Tab / Umschalt+Tab / Enter / Leertaste / Esc.
  - Erwartet: Alle Bedienelemente (Neue Notiz, Löschen, Anheften, Schließen, Titel,
    Notizfarben, Toolbar inkl. Farbpalette und Schriftgröße, Seitenkarten, Pfeile) erreichbar,
    sichtbarer Fokusrahmen, logische Reihenfolge, keine Fokusfalle (außer im Editor-Listen-Tab,
    s. 10.8 – dort Strg+Tab bzw. erst aus der Liste heraus). Esc schließt das Fenster.
- [ ] **20.2 Buddy per Tastatur** ⚠️ nur unter Windows prüfbar
  - Hinweis: Das Buddy-Fenster nimmt bewusst keinen Fokus (`focus: false`); Tastaturnutzer
    öffnen die Notizen über Strg+Alt+N oder das Tray (Win+B → Pfeiltasten → Enter / Kontextmenü-
    Taste). Prüfen, dass das zuverlässig klappt.
- [ ] **20.3 Einstellungen per Tastatur** ⚠️ nur unter Windows prüfbar
  - Erwartet: Alle Felder per Tab erreichbar; Radiogruppen mit Pfeiltasten; Regler mit Pfeiltasten
    in sinnvollen Schritten.
- [ ] **20.4 Sprachausgabe (Narrator, Strg+Win+Enter) – Stichprobe** ⚠️ nur unter Windows prüfbar
  - Erwartet: Toolbar-Buttons werden mit deutschem Namen und Zustand angesagt („Fett,
    Umschalter, nicht gedrückt“); Seitenkarten als „Vorherige Notiz: <Titel>, Schaltfläche“;
    Indikator „3 / 7“ wird beim Blättern angesagt; Löschen-Dialog wird als Dialog mit Titel
    angesagt; Checklisten-Checkboxen mit Zustand. Buddy (falls per Narrator-Scan erreichbar):
    „Display Buddy – Notizen öffnen oder schließen, Schaltfläche“.
- [ ] **20.5 Kontrast / Hoher Kontrast** ⚠️ nur unter Windows prüfbar
  - Schritte: Windows-Kontrastdesign einschalten.
  - Erwartet: Texte und Fokusrahmen bleiben lesbar; nichts wird unsichtbar (Befund notieren).
- [ ] **20.6 Textskalierung** ⚠️ nur unter Windows prüfbar
  - Schritte: Barrierefreiheit → Textgröße 150 %.
  - Erwartet: Notizfenster bleibt bedienbar (ggf. scrollen), nichts überlappt unlesbar.

---

## Anhang: In der Linux-Umgebung automatisiert geprüft

Diese Punkte sind durch Tests abgedeckt und müssen unter Windows nur stichprobenartig im
Zusammenspiel geprüft werden:

- Drag-/Klick-Erkennung (Schwelle 4 px), Karussell-Mathematik (0/1/2/3/10 Notizen, Wraparound,
  Umsortieren, Löschen, Einfügen), Mausrad-Drosselung.
- Autosave pro Notiz (500 ms, Reihenfolge, Flush bei Wechsel/Ausblenden/Beenden).
- Editor-Kürzel inkl. Strg+Umschalt+7 auf deutscher Tastatur (`key: "/"`), Tab-Verschachtelung,
  Durchreichen von Strg+←/→.
- Speicher: atomares Schreiben, `.corrupt`-Behandlung, Index-Reparatur, UUID-Prüfung,
  Roundtrip einer realistischen TipTap-Notiz (Farben, Schriftgrößen, verschachtelte Checklisten).
- Einstellungen: Merge-Patch, Wertebereiche, tolerantes Laden, Standardwerte = `src/types.ts`.
- Platzierungsmathematik (Notizen links/rechts, Ränder, negative Koordinaten), Standardposition,
  Monitorprüfung, Ecken-Durchklick-Geometrie.
- Vertrag Frontend ↔ Backend: Command-/Argument-/Eventnamen (`api.ts`), `build.rs`,
  `generate_handler!`, Capabilities je Fenster.
