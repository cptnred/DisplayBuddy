# Display Buddy – native App für Android und iOS

Die native App zeigt dieselbe Oberfläche wie die Web-App (PWA) und gleicht Notizen und
Erinnerungen mit deinem Display-Buddy-Server ab. Der Unterschied: **Sie plant jede
Erinnerung im Betriebssystem.** Erinnerungen klingeln deshalb **auch ohne Internet und bei
geschlossener App** pünktlich.

> **PWA _oder_ native App – nicht beides auf demselben Gerät.** Beide würden dieselbe
> Erinnerung melden, du bekämst sie doppelt. Wenn du von der PWA auf die App wechselst:
> in der PWA unter „Einstellungen“ abmelden und die PWA vom Home-Bildschirm entfernen.

Inhalt: [Server-Adresse](#server-adresse) · [Android](#android) ·
[Push über Firebase (Android, optional)](#push-über-firebase-android-optional) · [iOS](#ios) ·
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

- **Benachrichtigungen** (Android 13 und neuer): Direkt nach dem Anmelden fragt die App selbst
  nach der Erlaubnis → _Zulassen_ wählen. Ohne diese Erlaubnis plant die App **keine** Erinnerungen.
  Wurde der Dialog weggeklickt: in der App _Einstellungen → Benachrichtigungen aktivieren_. Später änderbar unter
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

## Android lokal unter Windows bauen und per USB installieren

Für schnelle Tests ohne GitHub Actions. Die Versionen entsprechen dem CI-Workflow
(`.github/workflows/mobile-android.yml`). Alle Befehle in **PowerShell**.

### Einmalig einrichten

1. **Windows-Entwicklermodus** einschalten: Einstellungen → System → Für Entwickler → „Entwicklermodus“.
   Tauri legt beim Android-Build symbolische Links an; ohne Entwicklermodus bricht der Build mit
   „symbolic link“-Fehlern ab.
2. **Visual Studio Build Tools** (C++): <https://visualstudio.microsoft.com/visual-cpp-build-tools/> →
   Arbeitslast „Desktopentwicklung mit C++“. Rust braucht sie für Build-Skripte, auch beim Android-Build.
3. **Rust** über <https://rustup.rs> (`rustup-init.exe`, Standardauswahl), danach in einer neuen
   PowerShell die Version des CI-Workflows und die Android-Ziele installieren:

   ```powershell
   rustup toolchain install 1.97.0 --profile minimal --component rustfmt --component clippy
   ```

   ```powershell
   rustup target add --toolchain 1.97.0 aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android
   ```

   Im geklonten Projektordner (siehe unten) einmal `rustup override set 1.97.0` ausführen, damit genau diese
   Version benutzt wird.

4. **Node.js 22 LTS** (neuer geht auch) von <https://nodejs.org> und **Git** von <https://git-scm.com>.
5. **Android Studio** installieren und einmal starten (Standard-Einrichtung). Dann
   *More Actions → SDK Manager*:
   - Reiter **SDK Platforms**: Android API 37 (`android-37.0`) anhaken.
   - Reiter **SDK Tools**, unten „Show Package Details“ anhaken:
     - **Android SDK Build-Tools** → `36.1.0`
     - **NDK (Side by side)** → `27.2.12479018`
     - **Android SDK Command-line Tools (latest)**
     - **Android SDK Platform-Tools**
   - **Apply**.
6. **JDK 17** (z. B. Eclipse Temurin 17, <https://adoptium.net>); der CI-Workflow baut ebenfalls mit 17.
   Eine ältere Java-Version (z. B. 11) darf nicht vor JDK 17 im `Path` stehen.
7. **Umgebungsvariablen** setzen (einmalig, danach PowerShell neu öffnen; den JDK-Pfad ggf. an deine
   Installation anpassen):

   ```powershell
   [Environment]::SetEnvironmentVariable("JAVA_HOME", "C:\Program Files\Eclipse Adoptium\jdk-17.0.16.8-hotspot", "User")
   ```

   ```powershell
   [Environment]::SetEnvironmentVariable("ANDROID_HOME", "$env:LOCALAPPDATA\Android\Sdk", "User")
   ```

   ```powershell
   [Environment]::SetEnvironmentVariable("NDK_HOME", "$env:LOCALAPPDATA\Android\Sdk\ndk\27.2.12479018", "User")
   ```

   ```powershell
   [Environment]::SetEnvironmentVariable("Path", "$([Environment]::GetEnvironmentVariable('Path','User'));$env:LOCALAPPDATA\Android\Sdk\platform-tools", "User")
   ```

   Prüfen (neue PowerShell): `java -version` (muss 17 zeigen), `adb version`, `cargo --version`
   (1.97.0), `node --version`, `echo $env:JAVA_HOME $env:ANDROID_HOME $env:NDK_HOME`.
8. **Handy vorbereiten:** Einstellungen → Über das Telefon → 7× auf „Build-Nummer“ tippen →
   Entwickleroptionen → **USB-Debugging** an. Per USB anschließen, die Abfrage „USB-Debugging zulassen?“
   bestätigen. `adb devices` muss das Gerät als `device` zeigen (nicht `unauthorized`).

### Code holen und Android-Projekt erzeugen (einmalig)

```powershell
git clone --branch claude/display-buddy-v3-c9w0c8 https://github.com/cptnred/DisplayBuddy.git
```

```powershell
cd DisplayBuddy
```

```powershell
rustup override set 1.97.0
```

```powershell
npm ci
```

```powershell
cd mobile
```

```powershell
npx tauri android init
```

`init` legt `mobile\src-tauri\gen\android` an (wird nicht eingecheckt). Danach die Build-Tools-Version
auf `36.1.0` setzen:

```powershell
node scripts\android-build-tools.mjs src-tauri\gen\android
```

Nach einem `git pull`, der `tauri.conf.json` oder Plugins ändert, `gen` löschen, `init` erneut
ausführen und den Build-Tools-Schritt wiederholen.

### Bauen und aufs Handy

Die Server-Adresse wird beim Bauen fest in die App eingetragen (eigene Domain, mit `https://`):

```powershell
$env:BUDDY_PUBLIC_URL = "https://buddy.example.org"
```

Debug-APK nur für 64-Bit-ARM-Handys (fast alle aktuellen) bauen, im Ordner `mobile`:

```powershell
npx tauri android build --debug --apk --target aarch64
```

Der erste Build dauert lange (Rust für Android + Gradle-Downloads). Installieren:

```powershell
adb install -r (Get-ChildItem -Recurse -Filter *.apk src-tauri\gen\android\app\build\outputs\apk | Select-Object -First 1).FullName
```

App auf dem Handy öffnen, anmelden, Erlaubnisse wie oben unter „Erlaubnisse“ geben.

**Später erneut bauen** (neuer Stand oder andere Server-Adresse): `git pull`, bei geänderter
`package-lock.json` `npm ci`, im Ordner `mobile` `$env:BUDDY_PUBLIC_URL` setzen (siehe oben), dann
`npx tauri android build --debug --apk --target aarch64` und `adb install -r …` wie oben. `init` ist nur
nötig, wenn sich `tauri.conf.json` oder die Plugins geändert haben (dann `gen` löschen, `init`, Build-Tools-Schritt).

**Wichtig:**
- **Alte APK trotz neuem Build?** Prüfe den Zeitstempel der APK. Gradle übernimmt eine neu gebaute
  Rust-Bibliothek manchmal nicht (sie wird als Symlink eingebunden). Dann
  `Remove-Item -Recurse -Force src-tauri\gen\android\app\build` (im Ordner `mobile`) und neu bauen.
- **16 KB Speicherseiten:** Android 15+ warnt bei Apps, deren native Bibliotheken nicht für 16-KB-Seiten
  gebaut sind. `build.rs` linkt die Rust-Bibliothek deshalb mit 16-KB-Ausrichtung (NDK 27 tut das nicht von
  allein). Prüfen:
  `& "$env:ANDROID_HOME\ndk\27.2.12479018\toolchains\llvm\prebuilt\windows-x86_64\bin\llvm-readelf.exe" -lW src-tauri\target\aarch64-linux-android\debug\libdisplay_buddy_mobile_lib.so`
  muss bei `LOAD` die Ausrichtung `0x4000` zeigen (nicht `0x1000`).
- War vorher eine APK aus GitHub Actions installiert, ist sie anders signiert: `adb install` meldet
  `INSTALL_FAILED_UPDATE_INCOMPATIBLE`. Dann zuerst in der alten App einmal synchronisieren
  (nichts darf „warten“), danach `adb uninstall de.displaybuddy.mobile` und erneut installieren. Das löscht die
  lokalen Daten der App; nach dem Anmelden kommen sie vom Server zurück.
- Live-Entwicklung mit automatischem Neuladen: `npx tauri android dev` (Handy und Laptop im selben WLAN).
- App-Log ansehen: `adb logcat -s Tauri/Console` (zeigt keine Tokens oder Notizinhalte).
- Firebase-Push lokal (optional): `google-services.json` (siehe unten, nie einchecken) nach `init` einmal
  einbauen, im Ordner `mobile`:

  ```powershell
  $env:GOOGLE_SERVICES_JSON_BASE64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes("C:\Pfad\zu\google-services.json"))
  ```

  ```powershell
  node scripts\android-firebase.mjs src-tauri\gen\android de.displaybuddy.mobile
  ```

## Push über Firebase (Android, optional)

Ohne Push klingeln alle Erinnerungen, die das Handy schon kennt – auch offline. Eine Erinnerung,
die du **am PC anlegst oder verschiebst, während die App geschlossen ist**, kennt das Handy aber
erst nach dem nächsten Öffnen. Mit Push weckt der Server die App in diesem Fall über Firebase
Cloud Messaging (FCM): Es erscheint eine Benachrichtigung „Erinnerung: …“, ein Tipp darauf öffnet
die Notiz, die App gleicht ab und plant neu.

Der Server schickt **nur dann** einen Push, wenn das Handy diese Fassung der Erinnerung noch nicht
selbst geplant hat (oder Benachrichtigungen für die App verweigert sind). Was das Handy schon
kennt, klingelt wie bisher lokal – nichts kommt doppelt.

**Nur Android.** Für iPhones bräuchte Push das kostenpflichtige Apple Developer Program
(APNs-Schlüssel); das ist bewusst nicht umgesetzt. Die iOS-App plant weiter bei jedem Öffnen,
Sync und Fortsetzen lokal.

Du brauchst ein (kostenloses) Google-Konto. Alles Folgende ist einmalig.

### 1. Firebase-Projekt und Android-App anlegen

1. [console.firebase.google.com](https://console.firebase.google.com) → **Projekt hinzufügen**,
   Name z. B. `display-buddy`. Google Analytics wird nicht gebraucht (ausschalten).
2. In der Projektübersicht **Android** (Symbol „Android“) wählen. Als **Android-Paketname** genau
   `de.displaybuddy.mobile` eintragen (steht in `src-tauri/tauri.conf.json` unter `identifier`;
   wenn du ihn geändert hast, deinen Wert). App-Spitzname beliebig, SHA-1 leer lassen.
3. **google-services.json herunterladen.** Die weiteren Schritte des Assistenten („Firebase SDK
   hinzufügen“) überspringen – das erledigt der Build.

### 2. google-services.json als GitHub-Secret hinterlegen

Die Datei gehört **nicht** ins Repository (sie ist in `mobile/.gitignore` ausgeschlossen).

```sh
base64 -w0 google-services.json > google-services.json.base64   # macOS: base64 -i google-services.json
```

GitHub → _Settings → Secrets and variables → Actions → Secrets_ → **`GOOGLE_SERVICES_JSON_BASE64`**
= Inhalt von `google-services.json.base64`. Beim nächsten Lauf von **mobile-android** baut der
Workflow Firebase ein (`mobile/scripts/android-firebase.mjs`: Datei nach `gen/android/app/`,
Google-Services-Gradle-Plugin eintragen). Der Schritt bricht mit einer klaren Meldung ab, wenn die
Datei keine App `de.displaybuddy.mobile` enthält. Ohne Secret baut die App wie bisher, nur ohne Push.

### 3. Dienstkonto-Schlüssel für den Server

Der Server meldet sich mit einem Dienstkonto bei FCM an (FCM HTTP v1, OAuth 2.0).

1. Firebase-Konsole → Zahnrad → **Projekteinstellungen → Dienstkonten** →
   **Neuen privaten Schlüssel generieren** → JSON-Datei speichern. Das ist ein **Geheimnis**
   (wie ein Passwort): nicht ins Repository, nicht per Mail verschicken.
2. Unter _Projekteinstellungen → Cloud Messaging_ muss **„Firebase Cloud Messaging API (V1)“**
   aktiviert sein (bei neuen Projekten Standard).
3. Datei auf den Server in das Daten-Volume kopieren und in `deploy/compose.yaml` die Zeile
   `BUDDY_FCM_SERVICE_ACCOUNT_FILE: /data/fcm-service-account.json` einkommentieren
   (Details in `deploy/README.md`, Abschnitt „Optional: native Android-App mit Firebase“), dann
   `docker compose up -d`. Im Log steht „native push via FCM HTTP v1 enabled“.
4. Ausgehend muss der Server `oauth2.googleapis.com` und `fcm.googleapis.com` erreichen (HTTPS).

### 4. Prüfen

1. Die neue APK installieren, App öffnen, angemeldet sein (die App meldet ihren Push-Token beim
   Start automatisch beim Server an).
2. App ganz schließen (aus der Übersicht wischen), am PC eine Erinnerung in 3 Minuten setzen →
   sie kommt als Push, obwohl das Handy sie vorher nicht kannte. Im Server-Log
   (`docker compose logs buddy`) steht dazu eine Zeile `reminder push` mit `status="sent"`.
3. Kommt nichts: Steht im Log `native push token stored`? Wenn nicht, wurde die APK ohne das
   Secret gebaut oder der Server hat keine Dienstkonto-Datei (die App fragt dann nicht weiter).

Wenn du die App neu installierst oder Daten löschst, vergibt Firebase einen neuen Token; die App
meldet ihn beim nächsten Start. Ungültige Tokens löscht der Server selbst.

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
  das Handy erst nach dem nächsten Öffnen (Sync). Abhilfe: [Push über Firebase](#push-über-firebase-android-optional)
  (nur Android).
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
- **Nativer Push (Android/FCM):** eigenes Mini-Plugin `plugins/buddy-push` (Kotlin, nach der
  Tauri-Anleitung „Mobile Plugin Development“; Befehle `get_token`, `take_launch_data`, Ereignisse
  `token`/`message`/`opened`), registriert in `src-tauri/src/lib.rs`. Die Logik (Token per
  `PUT /devices/current/push` melden, nach einem Push synchronisieren und
  `notifier.replan("sync")`) steckt in `src/web/notify/native-push.ts` und ist mit Vitest getestet;
  Kotlin baut nur in CI. Ohne `google-services.json` antwortet `get_token` mit `NOT_CONFIGURED`
  und die App läuft ohne Push. `node --test mobile/scripts/android-firebase.test.mjs` prüft das
  Einbau-Skript.
