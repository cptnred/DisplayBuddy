# Betriebshandbuch buddy.pev-point.de

Stand: 2026-11-11 (Server 0.4, v4) · Grundlage: `docs/PLAN_V4_ACCOUNTS.md` §11, §9.2, §8.2 und
`docs/DECISIONS.md` D-86, D-94, D-102, D-105, D-107, D-112.

Dieses Handbuch beschreibt, was der **öffentliche Standard-Server** über die normale Einrichtung hinaus braucht.
Installation, Befehle und Fehlersuche stehen in `deploy/README.md`; hier wird darauf verwiesen.

> **Kein Rechtsrat.** Die Abschnitte zu Impressum, Datenschutz und Auftragsverarbeitung sind eine Checkliste aus
> Sicht der Technik: Sie sagen, *welche Fakten* über den Dienst in die Texte gehören. Ob und wie die Pflichten im
> Einzelfall gelten und wie die Texte lauten, klärt der Betreiber selbst (ggf. mit Anwalt oder Datenschutz-Generator).

## Inhalt

1. [Überblick und Zuständigkeiten](#1-überblick-und-zuständigkeiten)
2. [Konfiguration](#2-konfiguration)
3. [Upgrade v3 → v4 an Ort und Stelle](#3-upgrade-v3--v4-an-ort-und-stelle)
4. [Checkliste vor `BUDDY_REGISTRATION=open`](#4-checkliste-vor-buddy_registrationopen)
5. [Backups außerhalb des VPS (restic)](#5-backups-außerhalb-des-vps-restic)
6. [Überwachung](#6-überwachung)
7. [Log-Aufbewahrung: 7 Tage](#7-log-aufbewahrung-7-tage)
8. [Last durch den Android-Hintergrundabgleich](#8-last-durch-den-android-hintergrundabgleich)
9. [Push: VAPID und Firebase](#9-push-vapid-und-firebase)
10. [Kosten](#10-kosten)
11. [Vorgehen bei Missbrauch](#11-vorgehen-bei-missbrauch)
12. [Update-Ablauf](#12-update-ablauf)

---

## 1. Überblick und Zuständigkeiten

buddy.pev-point.de ist der **bestehende v3-Server**, der an Ort und Stelle auf v4 aktualisiert wird (D-112).
Er läuft hinter **Nginx Proxy Manager** (NPM) – Variante B aus `deploy/README.md`, Compose-Datei
`deploy/compose.npm.yaml` (in `.env`: `COMPOSE_FILE=compose.npm.yaml`).

Der Betreiber ist Verantwortlicher im Sinne der DSGVO und besitzt (PLAN_V4 §11.1) – **nichts davon gehört ins
Repository**:

| Was | Wo | Gesichert durch |
|---|---|---|
| Domain `pev-point.de`, DNS-Eintrag `buddy` | Domain-Anbieter | Kundenkonto |
| VPS, Docker, NPM (Zertifikat) | VPS-Anbieter | NPM-Daten-Ordner (optional mitsichern) |
| Datenbank `buddy.db`, tägliche Kopien `backups/` | Docker-Volume `displaybuddy_buddy-data` | [Abschnitt 5](#5-backups-außerhalb-des-vps-restic) |
| VAPID-Schlüssel `vapid.pem` (Web Push) | dasselbe Volume | [Abschnitt 5](#5-backups-außerhalb-des-vps-restic) |
| Konfiguration `.env` | `/root/DisplayBuddy/deploy/.env` | [Abschnitt 5](#5-backups-außerhalb-des-vps-restic) |
| Firebase-Projekt + Dienstkonto (FCM) | **noch keins** (D-112) | – |
| Signierschlüssel der offiziellen APK | Rechner des Betreibers / GitHub-Secret, **nicht** auf dem VPS | eigene Sicherung (`mobile/README.md`) |
| restic-Passwort der Außer-Haus-Sicherung | VPS + Passwort-Manager des Betreibers | Passwort-Manager |

## 2. Konfiguration

Die Werte stehen ausschließlich in `/root/DisplayBuddy/deploy/.env` (die Compose-Dateien bleiben unverändert,
damit `git pull` nie Konflikte hat). Nach jeder Änderung: `docker compose up -d`.

Stand **nach dem Update auf v4** (Registrierung bleibt zu, D-112):

```ini
BUDDY_DOMAIN=buddy.pev-point.de
BUDDY_VAPID_SUBJECT=mailto:…            # wie bisher
COMPOSE_FILE=compose.npm.yaml
PROXY_NETWORK=…                         # wie bisher
PROXY_SUBNET=…                          # wie bisher

# --- v4 (PLAN_V4 §11.2) ---
# Registrierung: bleibt "closed" (Standard), bis Abschnitt 4 erledigt ist. Dann:
#BUDDY_REGISTRATION=open
BUDDY_REGISTRATION_POW_BITS=22
BUDDY_REGISTRATION_DAILY_LIMIT=200
BUDDY_QUOTA_BYTES=52428800              # 50 MB
BUDDY_QUOTA_NOTES=5000
BUDDY_QUOTA_DEVICES=10
# Rechtsseiten: URLs stehen noch nicht fest. Pflicht vor BUDDY_REGISTRATION=open (nur https://).
#BUDDY_IMPRINT_URL=https://…
#BUDDY_PRIVACY_URL=https://…
#BUDDY_TERMS_URL=https://…              # optional: Nutzungshinweise (Abschnitt 4.6)
BUDDY_OPERATOR_NAME=pev-point.de
# Firebase: später entscheiden (Abschnitt 9). Ohne Dienstkonto ist FCM aus; "minimal" ist schon gesetzt,
# damit Google beim späteren Einschalten keine Inhalte sieht (D-102).
BUDDY_FCM_PAYLOAD=minimal
#BUDDY_FCM_SERVICE_ACCOUNT_FILE=/data/fcm-service-account.json
```

Kontingente gelten sofort auch für die **bestehenden** Konten. Nach dem Update mit `user show <name>` prüfen und
eigene Konten bei Bedarf anheben (`user quota <name> --bytes … --notes … --devices …`, `deploy/README.md` §9.3).

Kontrolle von außen (ohne Anmeldung):

```sh
curl -fsS https://buddy.pev-point.de/api/v1/info
```

Erwartet: `"apiLevel":2`, `"registration":"closed"`, `"operator":"pev-point.de"`, `"legal"` mit `null`-Werten,
solange die URLs fehlen.

## 3. Upgrade v3 → v4 an Ort und Stelle

Allgemeiner Ablauf mit Rückweg: `deploy/README.md` §13.1. Für pev-point zusätzlich:

1. **Vorher** eine Außer-Haus-Sicherung laufen lassen (`/usr/local/sbin/buddy-offsite-backup`, [Abschnitt 5](#5-backups-außerhalb-des-vps-restic)),
   falls schon eingerichtet; sonst mindestens die Sicherung aus README §13.1 Schritt 1.
2. `.env` um den v4-Block aus [Abschnitt 2](#2-konfiguration) ergänzen (`BUDDY_REGISTRATION` bleibt
   auskommentiert).
3. `git pull` und `docker compose up -d --build`. Migration `0003_accounts` läuft beim Start, nur additiv:
   bestehende Konten, Geräte, Web-Sitzungen und Push-Abos bleiben gültig. Die PWA-Origin bleibt
   `https://buddy.pev-point.de` → Handys müssen nichts neu installieren; die Web-App meldet das Update selbst.
4. Prüfen: `docker compose ps` (healthy), `/api/v1/info` wie oben, `docker compose logs --tail 50 buddy` ohne
   Fehler, ein PC und ein Handy synchronisieren eine Testnotiz.
5. Wiederherstellungscodes für die bestehenden Konten ausgeben (`user list`, Spalte `recovery` = `no`):
   `docker compose exec buddy buddy-server user recovery <name>` – oder die Nutzer erzeugen ihn am PC (0.4)
   unter „Konto & Handy“ → „Code erzeugen“.
6. Desktop 0.4: `syncServerUrl` = `https://buddy.pev-point.de` ist zugleich der Standard-Server; verbundene PCs
   bleiben verbunden, nichts wird umgeschrieben (PLAN_V4 §6.5).
7. **Registrierung bleibt zu**, bis die Checkliste in Abschnitt 4 erfüllt ist.

## 4. Checkliste vor `BUDDY_REGISTRATION=open`

Erst wenn **alle** Punkte erledigt sind:

- [ ] Impressum online ([4.1](#41-impressum--5-ddg)), URL in `BUDDY_IMPRINT_URL`
- [ ] Datenschutzerklärung online ([4.2](#42-datenschutzerklärung-art-13-dsgvo)), URL in `BUDDY_PRIVACY_URL`
- [ ] optional Nutzungshinweise ([4.6](#46-nutzungshinweise-optional)), URL in `BUDDY_TERMS_URL`
- [ ] AV-Vertrag mit dem VPS-Anbieter und dem Backup-Speicher ([4.3](#43-auftragsverarbeitung-art-28-dsgvo))
- [ ] Verzeichnis der Verarbeitungstätigkeiten angelegt ([4.4](#44-verzeichnis-der-verarbeitungstätigkeiten-art-30-dsgvo))
- [ ] TOMs dokumentiert ([4.5](#45-technische-und-organisatorische-maßnahmen-art-32-dsgvo))
- [ ] Außer-Haus-Backup läuft täglich **und** eine Rücksicherung wurde getestet ([5](#5-backups-außerhalb-des-vps-restic))
- [ ] Überwachung aktiv: Health, Zertifikat, Platte, Backup-Heartbeat ([6](#6-überwachung))
- [ ] Log-Aufbewahrung 7 Tage eingerichtet ([7](#7-log-aufbewahrung-7-tage))
- [ ] Kontingente gesetzt ([2](#2-konfiguration))
- [ ] Ablauf bei Missbrauch und Datenpanne bekannt ([11](#11-vorgehen-bei-missbrauch))

Dann in `.env` `BUDDY_REGISTRATION=open` setzen, `docker compose up -d` und prüfen:

```sh
curl -fsS https://buddy.pev-point.de/api/v1/info
```

→ `"registration":"open"` und alle `legal`-URLs gefüllt. Der Server lehnt Rechtslinks ohne `https://` beim Start ab.
Zwischenschritt möglich: `BUDDY_REGISTRATION=invite` und Einladungscodes für Bekannte (README §9.2).

### 4.1 Impressum (§ 5 DDG)

Seit Mai 2024 regelt das Digitale-Dienste-Gesetz (DDG) die Impressumspflicht (vorher § 5 TMG). Typische Angaben:
Name, ladungsfähige Anschrift, E-Mail-Adresse und ein zweiter schneller Kontaktweg; falls vorhanden
Registereintrag und USt-IdNr. Ob ein kostenloses Angebot „in der Regel gegen Entgelt“ und damit
impressumspflichtig ist, ist Auslegungssache – die App verlinkt das Impressum ohnehin an Registrierung,
Anmeldeseite und Einstellungen. Eine Kontaktadresse für Missbrauchsmeldungen gehört dazu ([11](#11-vorgehen-bei-missbrauch)).

### 4.2 Datenschutzerklärung (Art. 13 DSGVO)

Fakten über den Dienst, die die Erklärung mindestens nennen muss (PLAN_V4 §11.3, ergänzt um Art. 13):

| Punkt | Fakten aus dem Code |
|---|---|
| Verantwortlicher, Kontakt | Betreiber laut Impressum |
| Zweck | Abgleich von Notizen und Erinnerungen zwischen PC, Handy-App und Web-App; Benachrichtigungen; Schutz vor Missbrauch |
| Rechtsgrundlagen (vom Betreiber zu prüfen) | Dienst: Art. 6 Abs. 1 lit. b (Nutzungsvertrag); Sicherheit, Bremsen und Logs: Art. 6 Abs. 1 lit. f |
| Gespeicherte Daten | Benutzername; Passwort nur als Argon2id-Hash; **Notizen und Erinnerungen im Klartext** auf dem Server; Zeitzone; Gerätename, Gerätetyp, Zeitpunkte (angelegt, zuletzt aktiv); Web-Push-Abos (Endpunkt-Adresse des Browser-Herstellers); ggf. FCM-Token; Wiederherstellungs-, Einladungs- und Anmeldecodes nur als SHA-256-Hash; Sitzungs-Cookie der Web-App (technisch notwendig) |
| IP-Adressen | in den Zugriffs-Logs von NPM und in Fehlversuch-Meldungen des Servers (7 Tage, [Abschnitt 7](#7-log-aufbewahrung-7-tage)); kurzzeitig im Arbeitsspeicher für Bremsen (Anmeldung, Registrierung, Pairing; höchstens 1 Tag) |
| **Regelmäßige Hintergrundabfragen** | Die Android-App fragt im Hintergrund etwa alle 3 Minuten beim Server nach neuen Erinnerungen (≈ 480 Abfragen pro Gerät und Tag, D-107); jede Abfrage erscheint mit IP-Adresse und Zeit im Zugriffs-Log |
| Keine Ende-zu-Ende-Verschlüsselung | Der Betreiber könnte Inhalte technisch lesen (D-101, S17). Transport per HTTPS. Logs enthalten keine Inhalte |
| Empfänger / Auftragsverarbeiter | VPS-Anbieter; Anbieter des Backup-Speichers (Daten dort mit restic verschlüsselt); Push-Dienste der Browser-Hersteller (Google, Apple, Mozilla, Microsoft) – Web-Push-Inhalte sind Ende-zu-Ende zum Browser verschlüsselt (RFC 8291), die Dienste sehen Zeitpunkt und Empfänger-Adresse; **nur falls FCM eingeschaltet wird:** Google Firebase (Inhalt dann nur „Erinnerung fällig“, D-102) |
| Drittland | Push-Dienste können Daten in den USA verarbeiten – Grundlage nennen (z. B. Angemessenheitsbeschluss/Data Privacy Framework, vom Betreiber zu prüfen) |
| Speicherdauer | Konto bis zur Löschung; **„Konto löschen“ löscht sofort**; tägliche Sicherungen 14 Tage (auf dem VPS und außer Haus, [5](#5-backups-außerhalb-des-vps-restic)); ältere Fassungen von Notizen 30 Tage; Löschmarker (ohne Inhalt) 180 Tage; abgemeldete Geräte 30 Tage; Logs 7 Tage |
| Rechte | Auskunft und Datenübertragbarkeit: „Daten exportieren“ in den Apps (JSON); Löschung: „Konto löschen“; Berichtigung: Notizen selbst ändern; Widerspruch; Beschwerde bei einer Aufsichtsbehörde |
| Pflicht zur Bereitstellung | Konto freiwillig; Display Buddy am PC funktioniert ohne Konto |
| Kein Tracking | keine Analyse-Dienste, keine Werbung, kein CAPTCHA-Anbieter (Schutz per Rechenaufgabe im eigenen Server) |
| Passwort verloren | Zurücksetzen nur mit Wiederherstellungscode oder angemeldetem Gerät; der Betreiber stellt auf dem öffentlichen Dienst **keine** Codes aus (PLAN_V4 §6.4) |

Anmeldecodes aus dem QR-Code stehen nur im URL-Fragment und im Anfrage-Inhalt, nie in Logs (S7).

### 4.3 Auftragsverarbeitung (Art. 28 DSGVO)

- AV-Vertrag mit dem **VPS-Anbieter** (meist im Kundenmenü abschließbar).
- AV-Vertrag mit dem Anbieter des **Backup-Speichers** (auch wenn die Daten verschlüsselt sind).
- Ein externer Monitoring-Dienst sieht nur `/api/v1/health` und `/api/v1/info` (keine personenbezogenen Daten).
- Falls Firebase eingeschaltet wird: Datenverarbeitungsbedingungen von Firebase/Google ([Abschnitt 9](#9-push-vapid-und-firebase)).

### 4.4 Verzeichnis der Verarbeitungstätigkeiten (Art. 30 DSGVO)

Ein Eintrag „Display Buddy Sync-Dienst“ mit den Angaben aus 4.2 (Zweck, Kategorien betroffener Personen = Nutzer
mit Konto, Datenkategorien, Empfänger, Drittland, Löschfristen) und einem Verweis auf die TOMs (4.5).

### 4.5 Technische und organisatorische Maßnahmen (Art. 32 DSGVO)

Grundlage ist PLAN_V4 §8 (Bedrohung → Gegenmaßnahme). Kurzfassung für die Dokumentation:

- **Transport:** nur HTTPS (NPM, Let's Encrypt, Force SSL, HSTS empfohlen).
- **Zugangsdaten:** Passwörter Argon2id; Tokens, Sitzungen und alle Codes nur als SHA-256-Hash; Zufall aus CSPRNG;
  Liste häufiger Passwörter; Mindestlänge 12.
- **Bremsen:** Anmeldung je (IP, Benutzer) und IP-weit (30 Fehlversuche/h), Registrierung (Rechenaufgabe,
  3/h und 10/Tag je IP, 200/Tag gesamt), Pairing-Codes (10 Fehlversuche/10 min, 3 min gültig, einmalig).
- **Web:** CSRF-Prüfung, strenge Content-Security-Policy, `Referrer-Policy: no-referrer`.
- **Missbrauch/Kapazität:** Kontingente je Konto, Sperren und Löschen per CLI.
- **Server-Härtung:** Container ohne root, Dateisystem schreibgeschützt, alle Linux-Capabilities entzogen,
  `no-new-privileges`, kein veröffentlichter Port (nur über NPM erreichbar); feste Versionen der Basis-Images.
- **Verfügbarkeit/Wiederherstellung:** tägliche Sicherung, Außer-Haus-Kopie verschlüsselt, getestete Rücksicherung.
- **Protokollierung:** Logs ohne Inhalte, Passwörter, Codes, Push-Endpunkte; Aufbewahrung 7 Tage.
- **Organisatorisch:** VPS-Zugang nur per SSH-Schlüssel, Updates mit Ankündigung, Ablauf bei Datenpannen
  (Meldung an die Aufsichtsbehörde binnen 72 Stunden, Art. 33).

### 4.6 Nutzungshinweise (optional)

Über `BUDDY_TERMS_URL` verlinkbar. Inhalte, die zum technischen Stand passen: Verfügbarkeit ohne Zusage („best
effort“), Updates werden angekündigt; Kontingente (50 MB, 5 000 Notizen, 10 Geräte); kein Zurücksetzen von
Passwörtern durch den Betreiber; Sperre/Löschung bei Missbrauch; keine Ende-zu-Ende-Verschlüsselung.

## 5. Backups außerhalb des VPS (restic)

Der Server legt täglich `backups/buddy-JJJJMMTT.db` an und behält 14 (README §12). Diese Kopien liegen auf
demselben VPS – fällt er aus, sind sie weg. Deshalb täglich eine **verschlüsselte** Kopie außer Haus mit
[restic](https://restic.readthedocs.io/) (Befehle nach der restic-Dokumentation: „Preparing a new repository“,
„Backing up“, „Removing backup snapshots“, „Restoring from backup“).

**Was gesichert wird:** die **neueste** Tagessicherung der Datenbank, `vapid.pem`, falls vorhanden
`fcm-service-account.json`, und `.env`.
**Aufbewahrung: 13 Tage** (`--keep-within 13d`). Zusammen mit dem Alter der Tageskopie (höchstens ein Tag) hält
das die Zusage der Datenschutzerklärung ein: Gelöschte Konten sind nach 14 Tagen auch aus allen Sicherungen weg.
Deshalb wird nur die neueste Tageskopie gesichert, nicht alle 14.

### Einrichten (einmalig)

1. Speicher außer Haus besorgen: z. B. ein SFTP-Speicher oder ein S3-kompatibler Objektspeicher bei einem
   anderen Anbieter als dem VPS. SFTP-Zugang per SSH-Schlüssel nach der Anleitung des Anbieters einrichten.
2. restic installieren und Passwort erzeugen:

   ```sh
   apt-get install -y restic
   restic version
   umask 077
   head -c 32 /dev/urandom | base64 > /root/.restic-buddy-password
   cat /root/.restic-buddy-password
   ```

   **Das Passwort zusätzlich im Passwort-Manager ablegen.** Ohne es ist die Sicherung wertlos.
3. Repository anlegen (Beispiel SFTP, Adresse anpassen):

   ```sh
   export RESTIC_REPOSITORY='sftp:backup@storage.example.net:/buddy'
   export RESTIC_PASSWORD_FILE=/root/.restic-buddy-password
   restic init
   ```

4. Skript `/usr/local/sbin/buddy-offsite-backup` anlegen (`nano`, dann `chmod 700`):

   ```sh
   #!/bin/sh
   # Daily off-site backup of buddy.pev-point.de (docs/OPERATIONS.md §5).
   set -eu
   export RESTIC_REPOSITORY='sftp:backup@storage.example.net:/buddy'
   export RESTIC_PASSWORD_FILE=/root/.restic-buddy-password
   STAGE=/root/buddy-offsite
   cd /root/DisplayBuddy/deploy
   rm -rf "$STAGE"
   mkdir -m 700 "$STAGE"
   LATEST=$(docker compose exec -T buddy sh -c 'ls -1 /data/backups/buddy-*.db | tail -n 1')
   docker compose cp "buddy:$LATEST" "$STAGE/buddy.db"
   docker compose cp buddy:/data/vapid.pem "$STAGE/vapid.pem"
   docker compose cp buddy:/data/fcm-service-account.json "$STAGE/" 2>/dev/null || true
   cp .env "$STAGE/env"
   restic backup --quiet --tag buddy "$STAGE"
   restic forget --quiet --tag buddy --keep-within 13d --prune
   rm -rf "$STAGE"
   # Heartbeat for the monitoring (§6); remove the line if not used.
   curl -fsS -m 10 --retry 3 "https://kuma.example.net/api/push/BACKUP-TOKEN?status=up&msg=OK" > /dev/null
   ```

5. Einmal von Hand ausführen und prüfen:

   ```sh
   /usr/local/sbin/buddy-offsite-backup
   restic snapshots
   restic check
   ```

6. Täglich ausführen – Datei `/etc/cron.d/buddy-offsite-backup`:

   ```
   30 3 * * * root /usr/local/sbin/buddy-offsite-backup >> /var/log/buddy-offsite-backup.log 2>&1
   ```

   (Die Tagessicherung des Servers entsteht kurz nach Mitternacht UTC; 03:30 Uhr liegt danach.)

### Rücksicherung testen (nach dem Einrichten, dann vierteljährlich)

```sh
export RESTIC_REPOSITORY='sftp:backup@storage.example.net:/buddy'
export RESTIC_PASSWORD_FILE=/root/.restic-buddy-password
restic restore latest --tag buddy --target /root/restore-test
R=/root/restore-test/root/buddy-offsite
ls -l "$R"
# Datenbank lässt sich öffnen, Konten sind da (läuft in einem Wegwerf-Container, berührt den Dienst nicht):
docker run --rm -i displaybuddy/buddy-server:local sh -c 'cat > /tmp/t.db && BUDDY_DB=/tmp/t.db buddy-server user list' < "$R/buddy.db"
# VAPID-Schlüssel passt zum laufenden Server (beide Zeilen gleich):
docker run --rm -i displaybuddy/buddy-server:local sh -c 'cat > /tmp/k.pem && buddy-server vapid public-key --file /tmp/k.pem' < "$R/vapid.pem"
cd /root/DisplayBuddy/deploy && docker compose exec buddy buddy-server vapid public-key
rm -rf /root/restore-test
```

Datum und Ergebnis des Tests im Verzeichnis der TOMs notieren.

### Ernstfall: neuer VPS

Docker und NPM wie gehabt einrichten, Repository klonen, `.env` aus der Sicherung (`env`) zurücklegen, dann
`docker compose build` und die Dateien wie in README §12 „Wiederherstellen“ über `<` ins Volume schreiben
(`buddy.db`, `vapid.pem`, ggf. `fcm-service-account.json`), `docker compose up -d`. DNS auf die neue IP umstellen.
Geräte gleichen danach selbst ab; Änderungen seit der Sicherung laden sie erneut hoch.

## 6. Überwachung

Empfehlung: **Uptime Kuma** (oder ein vergleichbarer Dienst) **auf einem anderen Rechner** als dem VPS, mit
Benachrichtigung per E-Mail oder Messenger.

| Monitor | Einstellung | Meldet |
|---|---|---|
| Health | Typ „HTTP(s) – Keyword“, `https://buddy.pev-point.de/api/v1/health`, Keyword `"ok":true`, alle 60 s | Server oder Proxy down, Datenbank nicht erreichbar |
| Zertifikat | im Health-Monitor „Certificate Expiry Notification“ einschalten | NPM hat das Let's-Encrypt-Zertifikat nicht erneuert (Warnung Tage vor Ablauf) |
| Registrierungsmodus | Keyword-Monitor auf `/api/v1/info`, Keyword `"registration":"closed"` (nach dem Öffnen `"open"`) | ungewollte Änderung der `.env` |
| Backup | Typ „Push“, Heartbeat 25 h; URL in das Backup-Skript ([5](#5-backups-außerhalb-des-vps-restic)) | Außer-Haus-Sicherung ist ausgefallen |
| Platte | Typ „Push“, Heartbeat 25 h, plus Cron-Skript unten | Platte über 80 % voll |

Plattenplatz – Datei `/etc/cron.d/buddy-disk` (meldet nur „up“, solange unter 80 %; bleibt die Meldung aus, alarmiert
der Monitor):

```
0 * * * * root [ "$(df --output=pcent / | tail -n 1 | tr -dc 0-9)" -lt 80 ] && curl -fsS -m 10 "https://kuma.example.net/api/push/DISK-TOKEN?status=up&msg=OK" > /dev/null
```

Was den Platz verbraucht: `docker system df`, `docker compose exec buddy du -sh /data /data/backups`.

Außerdem regelmäßig (z. B. wöchentlich beim Log-Skript, [7](#7-log-aufbewahrung-7-tage)) einen Blick auf
`docker compose ps` (healthy) und auf die Last ([8](#8-last-durch-den-android-hintergrundabgleich)).

## 7. Log-Aufbewahrung: 7 Tage

IP-Adressen stehen in zwei Logs:

| Log | Inhalt | Rotation von selbst |
|---|---|---|
| NPM-Zugriffs-/Fehler-Logs `…/data/logs/proxy-host-<Nr>_access.log` / `_error.log` | jede Anfrage mit IP, Zeit, Pfad, User-Agent | NPM rotiert wöchentlich und behält 4 (Zugriff) bzw. 10 (Fehler) alte Dateien – also über einen Monat |
| Docker-Log von `buddy` | Fehlversuche bei Anmeldung/Wiederherstellung mit IP, Geräte-IDs, Fehler | nach Größe (5 × 10 MB, `logging` in der Compose-Datei), **nicht** nach Zeit |

Quelle für NPM: `docker/rootfs/etc/logrotate.d/nginx-proxy-manager` und `backend/setup.js` (`setupLogrotation`,
alle 2 Tage `logrotate`) im Repository NginxProxyManager/nginx-proxy-manager (geprüft am 2026-11-11, Commit
`66ab4b2`). Docker: „JSON File logging driver“ (`max-size`, `max-file`); das Log eines Containers wird mit dem
Container gelöscht.

Deshalb ein eigenes Skript `/usr/local/sbin/buddy-log-retention` (`chmod 700`, Pfad und Containername von NPM
anpassen – ermitteln mit `docker ps` und
`docker inspect <npm-container> --format '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{"\n"}}{{end}}'`):

```sh
#!/bin/sh
# Keep logs with IP addresses about 7 days (docs/OPERATIONS.md §7).
set -eu
NPM_CONTAINER=nginx-proxy-manager
NPM_LOGS=/opt/nginx-proxy-manager/data/logs
if [ "${1:-}" = weekly ]; then
  # start a new log file now, so the current one never holds more than a week
  docker exec "$NPM_CONTAINER" logrotate -f /etc/logrotate.d/nginx-proxy-manager
  # recreating the container deletes its old Docker log
  cd /root/DisplayBuddy/deploy && docker compose up -d --force-recreate buddy
fi
# rotated NPM files (*.log.1.gz …) are older than the current week
find "$NPM_LOGS" -type f -name '*.log.*' -delete
```

Datei `/etc/cron.d/buddy-log-retention`:

```
15 4 * * * root /usr/local/sbin/buddy-log-retention
45 4 * * 1 root /usr/local/sbin/buddy-log-retention weekly
```

Täglich verschwinden rotierte NPM-Dateien (NPM rotiert auch selbst zwischendurch), montags beginnt eine neue
Log-Datei und `buddy` wird neu erzeugt (wenige Sekunden Unterbrechung; die Apps wiederholen von selbst). Ergebnis:
Logs sind höchstens etwa 7 Tage alt. Jedes Update (`up -d --build`) erzeugt `buddy` ohnehin neu.

Optional für alle übrigen Container (auch NPM selbst) eine Größenbegrenzung als Docker-Standard in
`/etc/docker/daemon.json`: `{"log-driver": "json-file", "log-opts": {"max-size": "10m", "max-file": "5"}}`, dann
`systemctl restart docker` (gilt nur für neu erzeugte Container).

## 8. Last durch den Android-Hintergrundabgleich

Die native Android-App fragt ohne Firebase etwa **alle 3 Minuten** `GET /api/v1/sync/changes` ab (D-107):
**≈ 480 Anfragen pro Gerät und Tag**, bei 1 000 Geräten im Mittel **≈ 5,6 Anfragen/s**. Fast immer ist die Antwort
leer (gemessen lokal: 107 Byte Inhalt + 438 Byte Kopfzeilen, ein Index-Lookup in SQLite).

Grobe Schätzung des Datenvolumens: Weil zwischen zwei Abfragen 3 Minuten liegen, baut das Handy meist eine neue
TLS-Verbindung auf (einige KB). Mit 5–8 KB pro Abfrage sind das 2–4 MB pro Gerät und Tag, bei 1 000 Geräten etwa
60–120 GB im Monat – beim Inklusiv-Traffic des VPS-Tarifs gegenprüfen. Die NPM-Zugriffs-Logs wachsen entsprechend
(eine Zeile je Abfrage; deshalb [Abschnitt 7](#7-log-aufbewahrung-7-tage)).

**Wichtig:** `/sync/changes` und `/sync/push` haben bewusst **keine** Bremse (D-103, PLAN_V4 §8.2). Keine
Rate-Limits in NPM für diesen Host einrichten – viele Handys teilen sich eine IP (Mobilfunk-NAT), und eine Bremse
würde die Offline-Erinnerungen brechen.

### Anfragen pro Sekunde (NPM-Log)

```sh
LOG=$(grep -l 'buddy.pev-point.de' /opt/nginx-proxy-manager/data/logs/proxy-host-*_access.log | head -n 1)
STUNDE=$(LC_ALL=C date -u -d '1 hour ago' '+%d/%b/%Y:%H')
N=$(grep -F "[$STUNDE" "$LOG" | grep -c '/api/v1/sync/changes')
echo "$N Abfragen in der Stunde $STUNDE UTC = $((N / 3600)) pro Sekunde"
```

(NPM schreibt die Zeit in der Zeitzone seines Containers, meist UTC. Ist das Ergebnis 0, `-u` weglassen.)
Geteilt durch 480 ergibt die Tageszahl ungefähr die Zahl aktiver Android-Geräte.

### Antwortzeit von `/sync/changes` (Server-Log, vorübergehend)

Das NPM-Log enthält keine Antwortzeiten. Der Server protokolliert sie, wenn man für einige Minuten die Stufe
`debug` für `tower_http` einschaltet. In `.env`:

```ini
RUST_LOG=info,sqlx=warn,tower_http=debug
```

`docker compose up -d`, 15 Minuten warten, dann:

```sh
cd /root/DisplayBuddy/deploy
docker compose logs --no-log-prefix --since 15m buddy \
  | sed 's/\x1b\[[0-9;]*m//g' \
  | grep 'uri=/api/v1/sync/changes' | grep 'finished processing' \
  | grep -o 'latency=[0-9]*' | cut -d= -f2 | sort -n \
  | awk '{a[NR]=$1} END {if (NR) print NR " Anfragen, Median " a[int(NR/2)+1] " ms, 95 % " a[int(NR*0.95)+1] " ms"}'
```

Danach die Zeile `RUST_LOG=…` wieder entfernen und `docker compose up -d` – die Debug-Zeilen enthalten Pfade
(ohne Geheimnisse, aber viel Volumen). Richtwerte: Median unter 20 ms, 95 % unter 200 ms. Liegt es darüber oder ist
die CPU dauerhaft hoch (`docker stats --no-stream`), zuerst Plattenzugriffe und Datenbankgröße prüfen, dann einen
größeren VPS-Tarif erwägen.

## 9. Push: VAPID und Firebase

**VAPID (Web Push für die Web-App)** – zuständig ist der Server-Betreiber. Der Schlüssel `vapid.pem` liegt im
Volume, wird mitgesichert ([5](#5-backups-außerhalb-des-vps-restic)) und **nie** neu erzeugt (`vapid generate
--force`), außer er ist kompromittiert: Dann müssen alle Handys „Benachrichtigungen aktivieren“ erneut tippen.
`BUDDY_VAPID_SUBJECT` ist die Kontaktadresse für die Push-Dienste; sie sollte erreichbar bleiben.

**Firebase (FCM) ist für pev-point optional** (D-105) und derzeit **aus** (D-112). Android bekommt neue
Erinnerungen trotzdem über den Hintergrundabgleich nach höchstens etwa 3 Minuten; FCM brächte nur schnellere
Weckrufe. iOS: weiter nur lokale Planung beim Öffnen/Sync (D-47).

FCM später nachrüsten:

1. Firebase-Projekt anlegen und die Android-App (Paketname der offiziellen App) hinzufügen – `mobile/README.md`,
   „Push über Firebase (Android, optional)“, Schritte 1–2 (`google-services.json` als GitHub-Secret).
2. Die **offizielle APK neu bauen** (mit demselben Signierschlüssel, sonst gibt es kein Update) und verteilen.
   Nur Builds mit diesem Firebase-Projekt bekommen Weckrufe von pev-point; Selbst-Hoster-Builds und alte APKs
   nicht (D-105).
3. Dienstkonto-Schlüssel erzeugen (dieselbe Anleitung, Schritt 3) und ins Volume legen:
   `deploy/README.md` §16 „Optional: native Android-App mit Firebase“ (Datei über `<` hineinreichen,
   `BUDDY_FCM_SERVICE_ACCOUNT_FILE=/data/fcm-service-account.json` in `.env`).
4. `BUDDY_FCM_PAYLOAD=minimal` bleibt gesetzt (Google sieht nur „Erinnerung fällig“, D-102).
5. `docker compose up -d`; im Log steht „native push via FCM HTTP v1 enabled“.
6. Ausgehend `fcm.googleapis.com` und `oauth2.googleapis.com` erlauben (README §15).
7. **Datenschutzerklärung und Verzeichnis ergänzen** (Google Firebase als Empfänger, Drittland) und die
   Datenverarbeitungsbedingungen von Firebase akzeptieren; das Dienstkonto in die Außer-Haus-Sicherung aufnehmen
   (das Skript in Abschnitt 5 nimmt es automatisch mit).

## 10. Kosten

| Posten | Kosten |
|---|---|
| VPS, Domain | vorhanden |
| Speicher für die Außer-Haus-Sicherung | wenige Euro im Monat (Datenbank im MB-Bereich) |
| Überwachung | kostenlos (Uptime Kuma selbst betrieben auf einem anderen Rechner, oder ein kostenloser externer Dienst) |
| Firebase Cloud Messaging | kostenlos (falls eingeschaltet) |
| Apple | nichts – kein Apple-Developer-Programm nötig (iOS nur PWA bzw. Selbstbau, D-54) |
| Traffic | abhängig von der Zahl der Android-Geräte ([8](#8-last-durch-den-android-hintergrundabgleich)); im Inklusiv-Volumen prüfen |
| Zeit | Updates, Rücksicherungstest, Anfragen von Nutzern (Auskunft, Missbrauch) |

## 11. Vorgehen bei Missbrauch

Anzeichen: viele neue Konten (`user list`, Spalte `created`), Log-Zeilen `account registered` gehäuft
(`docker compose logs --since 24h buddy | grep -c 'account registered'`), Platte wächst schnell, Beschwerden.

Schritte – vom schnellsten und mildesten zum endgültigen (alle Befehle mit
`docker compose exec buddy buddy-server` davor, README §9.5):

1. **Registrierung bremsen oder schließen:** in `.env` `BUDDY_REGISTRATION=invite` (nur noch mit Code) oder
   `closed`, `docker compose up -d`. Bestehende Konten arbeiten weiter. Alternativ milder:
   `BUDDY_REGISTRATION_POW_BITS=24` (4× mehr Rechenzeit am PC) oder ein kleineres
   `BUDDY_REGISTRATION_DAILY_LIMIT`.
2. **Konto sperren:** `user disable <name>` – sofort wirkt jede Anfrage mit `403 account_disabled`, Daten bleiben
   (umkehrbar mit `user enable <name>`).
3. **Konto löschen:** `user delete <name> --yes` – sofort und endgültig, auch aus den Sicherungen nach 14 Tagen.
   Bei Verdacht auf strafbare Inhalte **vorher** Rechtsrat einholen (Beweissicherung, Meldepflichten), nicht
   vorschnell löschen.
4. **Kontingente** senken (`.env`) oder für einzelne Konten (`user quota`).
5. **IP-Adressen sperren** nur als letztes Mittel und gezielt: in NPM unter „Access Lists“ (Docker umgeht ufw für
   veröffentlichte Ports). Vorsicht bei Mobilfunk-IPs (viele Nutzer hinter einer Adresse).
6. Betroffene Nutzer informieren; Vorgang mit Datum notieren.

**Datenpanne** (z. B. Server kompromittiert, Sicherung abhandengekommen): Zugang sichern, Umfang feststellen,
Meldung an die Aufsichtsbehörde binnen 72 Stunden prüfen (Art. 33), Betroffene informieren (Art. 34), Tokens
ungültig machen (`user passwd <name> --revoke-devices` je Konto), bei Verdacht auf den VAPID-Schlüssel neu erzeugen.

## 12. Update-Ablauf

1. **Ankündigen** (z. B. auf der Projektseite), wenn das Update eine Unterbrechung oder sichtbare Änderung bringt
   (Nutzungshinweise: „Updates mit Ankündigung“).
2. Änderungen lesen: `git -C /root/DisplayBuddy fetch` und `git -C /root/DisplayBuddy log --oneline HEAD..@{u}`;
   neue Variablen stehen in `deploy/.env.example` und `docs/DECISIONS.md`.
3. Außer-Haus-Sicherung jetzt laufen lassen: `/usr/local/sbin/buddy-offsite-backup`. Bei einer neuen
   Datenbank-Migration zusätzlich die Kopie aus README §13.1 Schritt 1 (Migrationen sind nur vorwärts möglich).
4. Aktualisieren:

   ```sh
   cd /root/DisplayBuddy && git pull
   cd deploy && docker compose up -d --build
   docker image prune -f
   ```

5. Prüfen: `docker compose ps` (healthy), `curl -fsS https://buddy.pev-point.de/api/v1/info` (Version,
   Registrierungsmodus wie vorher), `docker compose logs --tail 50 buddy`, eine Testnotiz PC ↔ Handy.
6. Die Web-App zeigt den Nutzern „Eine neue Version von Display Buddy ist verfügbar.“; PC und Android-App
   brauchen nur bei neuen Versionen ein Update (APK mit demselben Signierschlüssel, `mobile/README.md`).
7. Betriebssystem des VPS: Sicherheitsupdates automatisch (`unattended-upgrades`), Docker-Pakete bei Bedarf mit
   `apt-get upgrade` und danach `docker compose up -d`.
