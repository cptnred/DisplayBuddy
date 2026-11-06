# Display Buddy – native App für Android und iOS

Die native App zeigt dieselbe Oberfläche wie die Web-App (PWA) und gleicht Notizen und
Erinnerungen mit deinem Display-Buddy-Server ab. Der Unterschied: **Sie plant jede
Erinnerung im Betriebssystem.** Erinnerungen klingeln deshalb **auch ohne Internet und bei
geschlossener App** pünktlich.

> **PWA _oder_ native App – nicht beides auf demselben Gerät.** Beide würden dieselbe
> Erinnerung melden, du bekämst sie doppelt. Wenn du von der PWA auf die App wechselst:
> in der PWA unter „Einstellungen“ abmelden und die PWA vom Home-Bildschirm entfernen.

Inhalt: [Server-Adresse](#server-adresse) · [Android](#android) · [iOS](#ios) ·
[Benachrichtigungen prüfen](#benachrichtigungen-prüfen) · [Grenzen](#grenzen) ·
[Für Entwickler](#für-entwickler)

---

## Server-Adresse

Die App kennt genau einen Server. Seine Adresse wird **beim Bauen** festgelegt und ist danach
nicht änderbar (Sicherheit: die App darf nur mit diesem Server sprechen):

- in GitHub: _Settings → Secrets and variables → Actions → Variables_ → neue Variable
  **`BUDDY_PUBLIC_URL`** = `https://buddy.<deine-domain>` (ohne Pfad, ohne `/` am Ende);
- auf dem eigenen Rechner: `export BUDDY_PUBLIC_URL=https://buddy.<deine-domain>` vor dem Bauen.

Ohne die Variable baut die App mit dem Platzhalter `https://buddy.example.org` (CI) bzw. zeigt
beim Start „Diese App wurde ohne Server-Adresse gebaut“. Erlaubt ist nur `https://`
(`http://` nur für `localhost` und den Android-Emulator `10.0.2.2`).

---

## Android

### 1. Signierschlüssel anlegen (einmalig)

Eine APK lässt sich nur installieren, wenn sie signiert ist. Lege auf deinem Rechner einen
eigenen Schlüssel an (`keytool` gehört zu jedem Java/JDK, z. B. Android Studio):

```sh
keytool -genkey -v -keystore display-buddy.jks -keyalg RSA -keysize 2048 -validity 10000 -alias buddy
base64 -w0 display-buddy.jks > display-buddy.jks.base64   # macOS: base64 -i display-buddy.jks
```

**Den Schlüssel und das Passwort gut aufheben** (z. B. Passwort-Manager). Ohne denselben
Schlüssel lässt sich ein späteres Update nicht über die alte App installieren.

In GitHub unter _Settings → Secrets and variables → Actions → Secrets_ anlegen:

| Secret | Inhalt |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | Inhalt von `display-buddy.jks.base64` |
| `ANDROID_KEYSTORE_PASSWORD` | Passwort des Keystores |
| `ANDROID_KEY_ALIAS` | `buddy` (der Alias von oben) |
| `ANDROID_KEY_PASSWORD` | Passwort des Schlüssels (meist dasselbe) |

Die Datei `display-buddy.jks` gehört **nie** ins Repository.

### 2. APK bauen lassen

GitHub → _Actions_ → **mobile-android** → _Run workflow_ (oder automatisch bei jedem Push, der
`mobile/` oder die Web-Oberfläche ändert). Nach etwa 20–30 Minuten liegt im Lauf unter
_Artifacts_ **display-buddy-android** mit `display-buddy.apk`. Ohne die Secrets entsteht nur
`display-buddy-unsigned.apk`, die sich **nicht** installieren lässt.

### 3. Installieren

1. Die ZIP-Datei des Artefakts auf dem Handy herunterladen und entpacken (oder per USB kopieren).
2. `display-buddy.apk` antippen. Android fragt beim ersten Mal, ob der Browser bzw. Dateimanager
   „Apps aus unbekannten Quellen installieren“ darf → erlauben → _Installieren_.
3. Updates: neue APK genauso installieren, die Daten bleiben erhalten (gleicher Schlüssel!).

### 4. Erlaubnisse

- **Benachrichtigungen** (Android 13 und neuer): Nach dem Anmelden auf _Benachrichtigungen
  aktivieren_ tippen und im Dialog _Zulassen_ wählen. Später änderbar unter
  _Einstellungen → Apps → Display Buddy → Benachrichtigungen_. Dort gibt es den Kanal
  **„Erinnerungen“** (hohe Wichtigkeit, mit Ton) – nicht stummschalten.
- **Exakte Alarme** („Alarme & Erinnerungen“):
  - Android 13 und neuer: automatisch erteilt (die App meldet sich als Erinnerungs-App,
    Berechtigung `USE_EXACT_ALARM`). Nichts zu tun.
  - Android 12/12L: _Einstellungen → Apps → Display Buddy → Alarme & Erinnerungen_ → **erlauben**.
    Ohne diese Erlaubnis klingelt eine Erinnerung ungenau (bis zu einigen Minuten später).
- **Energiesparmodus-Ausnahme** (wichtig bei Samsung, Xiaomi, Huawei, OnePlus u. a.):
  _Einstellungen → Apps → Display Buddy → Akku_ → **„Nicht eingeschränkt“** (je nach Hersteller
  „Keine Einschränkungen“ / „Hintergrundaktivität zulassen“ / Autostart erlauben). Manche
  Hersteller löschen sonst geplante Alarme, wenn die App länger nicht benutzt wurde.
  Herstellerspezifische Anleitungen: [dontkillmyapp.com](https://dontkillmyapp.com).
- Nach einem Neustart des Handys werden die geplanten Erinnerungen automatisch wiederhergestellt.

---

## iOS

iPhone-Apps lassen sich nur mit **macOS und Xcode** bauen und installieren. Es gibt zwei Wege:

| | Kostenloses Apple-Konto | Apple Developer Program (99 USD/Jahr) |
|---|---|---|
| Installation | per Kabel direkt aus Xcode auf dein iPhone | TestFlight (oder Ad-hoc) |
| Gültigkeit | **7 Tage**, danach in Xcode erneut auf ▶ drücken | 90 Tage (TestFlight) / 1 Jahr |
| CI-Build in GitHub | nur Kontroll-Build ohne Signatur | signiertes IPA mit Secrets möglich |

Aktuell ist der Weg mit **kostenlosem Konto auf deinem eigenen Mac** vorgesehen.

### Einmalig auf dem Mac einrichten

1. **Xcode** aus dem App Store installieren, einmal starten, Lizenz bestätigen.
2. Werkzeuge (Terminal):
   ```sh
   xcode-select --install                       # falls noch nicht vorhanden
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
   rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios
   brew install node xcodegen                   # Homebrew: https://brew.sh
   ```
3. In Xcode unter _Settings → Accounts_ deine Apple-ID hinzufügen (erzeugt das „Personal Team“).
4. Repository holen und Abhängigkeiten installieren:
   ```sh
   git clone <repo-url> DisplayBuddy && cd DisplayBuddy
   npm ci
   cd mobile
   npx tauri ios init
   npx tauri icon ../public-web/icons/icon.svg
   ```

### Bauen und auf das iPhone bringen

1. iPhone per Kabel anschließen, entsperren, „Diesem Computer vertrauen“. Auf dem iPhone
   _Einstellungen → Datenschutz & Sicherheit → Entwicklermodus_ einschalten (iOS 16+).
2. Im Ordner `mobile`:
   ```sh
   export BUDDY_PUBLIC_URL=https://buddy.<deine-domain>
   npx tauri ios build --open
   ```
   Xcode öffnet das Projekt. Links das Projekt wählen → das Target mit der Endung `_iOS` →
   _Signing & Capabilities_ → **Team: dein Name (Personal Team)**. Ist die Bundle-ID
   `de.displaybuddy.mobile` schon vergeben, eine eigene wählen (z. B. `de.<name>.buddy`).
3. Oben dein iPhone als Ziel wählen und **▶ (Run)** drücken.
4. Beim ersten Start auf dem iPhone: _Einstellungen → Allgemein → VPN & Geräteverwaltung_ →
   deinem Entwicklerzertifikat **vertrauen**.
5. **Alle 7 Tage** läuft die Signatur ab (die App startet dann nicht mehr). Einfach am Mac
   Schritt 2–3 wiederholen; die Daten in der App bleiben erhalten.

Erlaubnis: Nach dem Anmelden _Benachrichtigungen aktivieren_ → _Erlauben_. Später unter
_Einstellungen → Mitteilungen → Display Buddy_.

### Mit Apple Developer Program (optional, später)

Dann kann GitHub ein signiertes IPA bauen (Workflow **mobile-ios**, Job „signed“). Secrets nach
der Tauri-Anleitung „iOS Code Signing“: `IOS_CERTIFICATE` (p12, base64),
`IOS_CERTIFICATE_PASSWORD`, `IOS_MOBILE_PROVISION` (base64), `APPLE_DEVELOPMENT_TEAM`.
Verteilung über TestFlight (App Store Connect). Ohne diese Secrets baut der Workflow nur zur
Kontrolle ohne Signatur.

---

## Benachrichtigungen prüfen

_Einstellungen → Benachrichtigungen → Testbenachrichtigung_ plant eine Erinnerung **in 2 Minuten**
und prüft, ob das System sie angenommen hat. Der Text nennt die geplante Uhrzeit. Bleibt die App
geöffnet, misst sie die Abweichung und meldet danach „Zeitplanung stimmt“ bzw. „Zeitplanung weicht
ab“ mit der Abweichung in Sekunden. Bitte einmal auf jedem Gerät testen – unter iOS auch nach
einem Wechsel der Zeitzone (_Einstellungen → Allgemein → Datum & Uhrzeit_, z. B. Berlin und New York).

Flugmodus-Test: Erinnerung in 5 Minuten setzen, warten bis „synchronisiert“, Flugmodus an, App
schließen → die Erinnerung kommt trotzdem. „Erledigt“ in der Benachrichtigung wirkt sofort auf
dem Handy und wird beim nächsten Online-Sein übertragen.

---

## Grenzen

- Geplant werden immer die **60 nächsten** Erinnerungen (iOS erlaubt 64). Weitere werden beim
  nächsten Öffnen bzw. Sync nachgeplant.
- Eine **neue** Erinnerung, die am PC angelegt wird, während die App lange geschlossen ist, kennt
  das Handy erst nach dem nächsten Öffnen (Sync). Abhilfe bringt später der native Push (Android).
- iOS: Tippst du „Erledigt“/„10 Min. später“, während die App ganz beendet war, kann die Aktion
  verloren gehen. Die Erinnerung steht dann oben in der App mit denselben Knöpfen.
- Die Anzeige rechnet in der Zeitzone des Handys, die Erinnerung selbst in ihrer eigenen Zone
  („03:00 (09:00 Berlin)“). Auf Reisen plant die App beim Öffnen neu.

---

## Für Entwickler

```sh
npm run build:mobile                     # Oberfläche → mobile/dist (ohne Service Worker)
cd mobile/src-tauri && cargo test        # Rust-Teil (Host), BUDDY_PUBLIC_URL optional
cd mobile && npx tauri android dev       # braucht Android SDK/NDK (nicht in der Cloud-Umgebung)
cd mobile && npx tauri ios dev --open    # nur auf macOS
```

- Tauri-Befehle immer **im Ordner `mobile/`** ausführen (im Repo-Wurzelordner findet die CLI das
  Desktop-Projekt `src-tauri/`).
- `mobile/src-tauri/gen/` (Android-/Xcode-Projekt) wird nicht eingecheckt, sondern mit
  `tauri android init` / `tauri ios init` erzeugt (CI und Mac). Manifest-Berechtigungen für
  exakte Alarme ergänzt `build.rs` beim Bauen automatisch.
- Daten liegen in IndexedDB des WebViews (Origin `https://tauri.localhost` bzw.
  `tauri://localhost`). Abmelden löscht sie; das Token liegt im Schlüsselbund (iOS) bzw.
  Keystore-verschlüsselt (Android).
- **Plugin-Patch:** `mobile/patches/tauri-plugin-notification` ist eine Kopie der offiziellen
  Version 2.8.0 mit vier Korrekturen (Commit-Text „patch the notification plugin“): UTC-Datum unter
  iOS, kein Absturz bei Benachrichtigungen aus einem früheren App-Start (iOS), Datum mit
  Millisekunden an die nativen Parser, Aktionen beim Kaltstart (Android). Bei einem Update des
  Plugins prüfen, ob die Fehler upstream behoben sind, und den Patch dann entfernen.
- **Nativer Push (später, nur Android/FCM):** als weiteres Plugin in `src-tauri/src/lib.rs`
  registrieren, Token per `PUT /devices/current/push` melden; nach einem Push synchronisieren und
  `notifier.replan("sync")` – der Server schickt nur Pushes für Erinnerungen jenseits von
  `deviceState.scheduledSeq`. Dafür sind ein Firebase-Projekt und `google-services.json`
  (nie einchecken) nötig.
