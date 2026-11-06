# Display Buddy auf einem eigenen Server (VPS)

Diese Anleitung bringt den Sync-Server von Display Buddy auf einen gemieteten Linux-Server (VPS).
Danach synchronisieren PC und Handy ihre Notizen und Erinnerungen über **eine** Adresse, z. B.
`https://buddy.example.org`. Auf dem Handy läuft Display Buddy als Web-App (PWA) mit Benachrichtigungen.

Sie brauchen dafür keine Programmierkenntnisse. Jeder graue Block ist ein Befehl, den Sie komplett kopieren und
im Terminal einfügen können. Ersetzen Sie nur die Beispielwerte (`buddy.example.org`, `martin`, …).

**Was läuft auf dem Server?**

- **Caddy** nimmt die Verbindungen aus dem Internet an und holt automatisch ein HTTPS-Zertifikat
  (Let's Encrypt). Nur Caddy ist von außen erreichbar (Ports 80 und 443).
- **buddy-server** speichert die Daten (SQLite), liefert die Web-App aus und verschickt Benachrichtigungen.
  Er ist nur über Caddy erreichbar.

Alles läuft in Docker. Die Daten liegen im Docker-Volume `displaybuddy_buddy-data` (Datenbank, tägliche Backups,
der Push-Schlüssel `vapid.pem`).

---

## Inhalt

1. [VPS mieten und einloggen](#1-vps-mieten-und-einloggen)
2. [DNS-Eintrag anlegen](#2-dns-eintrag-anlegen)
3. [Docker installieren](#3-docker-installieren)
4. [Firewall einrichten](#4-firewall-einrichten)
5. [Display Buddy herunterladen und `.env` ausfüllen](#5-display-buddy-herunterladen-und-env-ausfüllen)
6. [Push-Schlüssel erzeugen (`vapid generate`)](#6-push-schlüssel-erzeugen)
7. [Starten](#7-starten)
8. [Benutzer anlegen](#8-benutzer-anlegen)
9. [Handy einrichten](#9-handy-einrichten)
10. [PC verbinden](#10-pc-verbinden)
11. [Backups](#11-backups)
12. [Updates](#12-updates)
13. [Fehlersuche](#13-fehlersuche)
14. [Ausgehende Verbindungen des Servers](#14-ausgehende-verbindungen-des-servers)
15. [Weitere Verwaltungsbefehle](#15-weitere-verwaltungsbefehle)

---

## 1. VPS mieten und einloggen

- Ein kleiner VPS reicht: **1 CPU, 1 GB RAM, 10 GB Speicher**, Betriebssystem **Ubuntu 24.04 LTS**
  (Debian 12/13 geht genauso, siehe Hinweis in Schritt 3).
- Der Anbieter nennt Ihnen die **IP-Adresse** und ein **root-Passwort** oder richtet einen SSH-Schlüssel ein.
- Einloggen vom eigenen PC (Windows: „Terminal“ bzw. „PowerShell“ öffnen):

```sh
ssh root@203.0.113.10
```

(`203.0.113.10` durch die IP Ihres VPS ersetzen.)

**Uhrzeit prüfen** – Display Buddy vergleicht Zeitstempel, die Serveruhr muss stimmen:

```sh
timedatectl
```

Dort muss `System clock synchronized: yes` stehen. Falls nicht:

```sh
sudo timedatectl set-ntp true
```

## 2. DNS-Eintrag anlegen

Beim Anbieter Ihrer Domain (z. B. `example.org`) legen Sie einen Eintrag für die Subdomain `buddy` an:

| Typ | Name | Wert |
|---|---|---|
| `A` | `buddy` | IPv4-Adresse des VPS, z. B. `203.0.113.10` |
| `AAAA` (nur wenn der VPS IPv6 hat) | `buddy` | IPv6-Adresse des VPS |

Es kann bis zu einer Stunde dauern, bis der Eintrag überall bekannt ist. Prüfen (auf dem VPS):

```sh
getent hosts buddy.example.org
```

Es muss die IP des VPS erscheinen. **Erst dann weitermachen** – sonst bekommt Caddy kein Zertifikat.

## 3. Docker installieren

Nach der offiziellen Docker-Anleitung für Ubuntu (docs.docker.com → „Install Docker Engine on Ubuntu“,
Abschnitt „Install using the apt repository“). Die Befehle nacheinander einfügen:

```sh
sudo apt-get update
sudo apt-get install -y ca-certificates curl git
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
```

```sh
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}") stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
```

```sh
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

Test:

```sh
sudo docker run --rm hello-world
docker compose version
```

> **Debian statt Ubuntu:** in den beiden Zeilen mit `download.docker.com/linux/ubuntu` jeweils `ubuntu` durch
> `debian` ersetzen (und `UBUNTU_CODENAME` bleibt leer, das ist in Ordnung).

Alle folgenden Befehle gehen davon aus, dass Sie als `root` eingeloggt sind. Als normaler Benutzer setzen Sie
`sudo` vor jeden `docker`-Befehl.

## 4. Firewall einrichten

Offen bleiben nur SSH (22), HTTP (80, für das Zertifikat und die Umleitung auf HTTPS) und HTTPS (443, auch UDP
für HTTP/3):

```sh
sudo apt-get install -y ufw
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 443/udp
sudo ufw enable
sudo ufw status
```

> **Wichtig:** Zuerst Port 22 erlauben, dann `ufw enable` – sonst sperren Sie sich aus.
>
> Hinweis aus der Docker-Doku („Packet filtering and firewalls“): Ports, die ein Container veröffentlicht,
> umgehen die ufw-Regeln. In dieser Einrichtung veröffentlicht nur Caddy die Ports 80 und 443 – die sollen ohnehin
> offen sein. buddy-server veröffentlicht keinen Port.

Hat Ihr Anbieter zusätzlich eine Firewall im Kundenmenü, öffnen Sie dort dieselben Ports (22/tcp, 80/tcp,
443/tcp, 443/udp). **Ausgehende** Verbindungen müssen erlaubt bleiben (siehe [Abschnitt 14](#14-ausgehende-verbindungen-des-servers)).

## 5. Display Buddy herunterladen und `.env` ausfüllen

```sh
cd ~
git clone https://github.com/cptnred/DisplayBuddy.git
cd ~/DisplayBuddy/deploy
cp .env.example .env
nano .env
```

In `nano` die drei Werte anpassen:

```ini
BUDDY_DOMAIN=buddy.example.org
ACME_EMAIL=ihre-adresse@example.org
BUDDY_VAPID_SUBJECT=mailto:ihre-adresse@example.org
```

- `BUDDY_DOMAIN`: genau die Subdomain aus Schritt 2, **ohne** `https://`.
- `ACME_EMAIL`: dorthin schickt Let's Encrypt Warnungen, falls ein Zertifikat abläuft.
- `BUDDY_VAPID_SUBJECT`: Kontaktadresse für die Push-Dienste von Google/Apple/Mozilla, mit `mailto:` davor.

Speichern: `Strg+O`, `Enter`, beenden: `Strg+X`. Die Datei `.env` enthält nur Einstellungen, keine Passwörter;
sie wird trotzdem nicht ins Git-Repository übernommen.

Prüfen, ob alles lesbar ist (es erscheint die fertige Konfiguration, keine Fehlermeldung):

```sh
docker compose config --quiet && echo "Konfiguration OK"
```

## 6. Push-Schlüssel erzeugen

Der Server braucht einen eigenen Schlüssel (VAPID), um Benachrichtigungen an Handys zu schicken. Er wird **einmal**
erzeugt und im Daten-Volume als `/data/vapid.pem` gespeichert. Der erste Aufruf baut auch das Programm – das dauert
beim ersten Mal 5–15 Minuten.

```sh
cd ~/DisplayBuddy/deploy
docker compose build
docker compose run --rm buddy buddy-server vapid generate
```

Am Ende erscheint der öffentliche Schlüssel (eine lange Zeichenkette). Sie müssen ihn nirgends eintragen – die App
holt ihn sich selbst.

> **Den Schlüssel unbedingt mitsichern** (siehe [Backups](#11-backups)). Geht er verloren, müssen auf allen
> Handys die Benachrichtigungen neu aktiviert werden.
>
> Ein zweiter Aufruf überschreibt den Schlüssel **nicht** (er bricht mit einer Meldung ab). Nur mit `--force`
> würde ein neuer erzeugt – das ist fast nie gewünscht.

## 7. Starten

```sh
cd ~/DisplayBuddy/deploy
docker compose up -d --build
```

Nach etwa einer halben Minute:

```sh
docker compose ps
```

Beide Dienste müssen `running` bzw. `healthy` zeigen. Test von außen (auch im Browser am PC möglich):

```sh
curl -fsS https://buddy.example.org/api/v1/health
```

Antwort: `{"ok":true,"serverTime":"…"}`. Wenn nicht: [Fehlersuche](#13-fehlersuche).

Die Dienste starten nach einem Neustart des VPS automatisch wieder (`restart: unless-stopped`).

## 8. Benutzer anlegen

Ein Benutzerkonto für alle Ihre Geräte. Statt `martin` Ihren Wunschnamen, statt `Europe/Berlin` Ihre Zeitzone
(Standardzone für Erinnerungen ohne eigene Zone):

```sh
cd ~/DisplayBuddy/deploy
docker compose exec -it buddy buddy-server user add martin --time-zone Europe/Berlin
```

Das Passwort wird zweimal abgefragt und beim Tippen **nicht angezeigt**. Es braucht **mindestens 12 Zeichen**.
Am Ende steht `Benutzer martin angelegt.`

> Ist der Server gerade nicht gestartet, geht dasselbe mit
> `docker compose run --rm -it buddy buddy-server user add martin --time-zone Europe/Berlin`.

## 9. Handy einrichten

> **Pro Handy entweder die PWA oder die native App** (siehe `mobile/README.md`) – nicht beides. Beide auf
> demselben Handy funktionieren zwar, jede Erinnerung käme dann aber doppelt.

### 9.1 Öffnen und anmelden

1. Auf dem Handy im Browser `https://buddy.example.org` öffnen – unter Android in **Chrome**, auf dem iPhone/iPad
   in **Safari**.
2. Benutzername und Passwort aus Schritt 8 eingeben, einen Gerätenamen wählen (z. B. „Handy Martin“) und
   anmelden.

### 9.2 Installieren (Symbol auf dem Startbildschirm)

- **Android (Chrome):** Menü **⋮** → **„App installieren“** (bzw. „Zum Startbildschirm hinzufügen“). Erscheint in
  der App der Knopf „App installieren“, geht es auch darüber.
- **iPhone/iPad (Safari):** unten (iPad: oben) auf **Teilen** (Quadrat mit Pfeil) → **„Zum Home-Bildschirm“** →
  „Hinzufügen“.

Danach Display Buddy **über das neue Symbol** öffnen und gegebenenfalls noch einmal anmelden.

> **iPhone/iPad:** Benachrichtigungen gibt es nur für die installierte App (ab iOS 16.4), nicht im Safari-Tab.
> Außerdem löscht Safari Daten nicht installierter Web-Apps nach einigen Tagen ohne Nutzung. Bitte also immer
> installieren.

### 9.3 Benachrichtigungen aktivieren

1. In der App **Einstellungen → Benachrichtigungen** öffnen.
2. Auf **„Benachrichtigungen aktivieren“** tippen und die Rückfrage des Systems mit **„Erlauben“** bestätigen.
3. Auf **„Testbenachrichtigung senden“** tippen. Innerhalb weniger Sekunden muss eine Benachrichtigung erscheinen.

Kommt keine: [Fehlersuche → Keine Benachrichtigung](#keine-benachrichtigung-auf-dem-handy).

> Die Web-App benachrichtigt über das Internet. Ist das Handy offline, kommt die Erinnerung, sobald es wieder
> Netz hat. Wer Erinnerungen auch ganz ohne Netz braucht, nimmt auf diesem Handy die native App.

## 10. PC verbinden

In Display Buddy am PC (ab Version 0.3):

1. **Einstellungen** öffnen → Abschnitt **„Synchronisation“**.
2. **Server-Adresse:** `https://buddy.example.org`
3. **Benutzer** und **Passwort** aus Schritt 8, **Gerätename** z. B. „Büro-PC“.
4. **„Verbinden“** klicken. Beim ersten Verbinden werden die Notizen des PCs mit denen auf dem Server
   zusammengeführt – es geht nichts verloren.

Weitere PCs genauso verbinden. Der PC funktioniert auch ohne Server weiter wie bisher und gleicht nach, sobald er
wieder Verbindung hat.

## 11. Backups

**Automatisch auf dem Server:** buddy-server legt einmal am Tag (UTC) eine Kopie der Datenbank unter
`/data/backups/buddy-JJJJMMTT.db` an und behält die letzten 14. Diese Kopien liegen aber auf demselben Server –
**holen Sie regelmäßig eine Kopie herunter**, inklusive des Push-Schlüssels `vapid.pem`.

### Sicherung auf dem VPS einsammeln

```sh
cd ~/DisplayBuddy/deploy
mkdir -p ~/buddy-backup
docker compose cp buddy:/data/backups ~/buddy-backup/
docker compose cp buddy:/data/vapid.pem ~/buddy-backup/vapid.pem
chmod -R go-rwx ~/buddy-backup
ls -l ~/buddy-backup ~/buddy-backup/backups
```

### Auf den eigenen PC herunterladen

Auf dem **PC** (nicht auf dem VPS) im Terminal/PowerShell:

```sh
scp -r root@203.0.113.10:buddy-backup ./buddy-backup
```

> `vapid.pem` ist ein privater Schlüssel: nicht weitergeben, nicht in Cloud-Ordner ohne Verschlüsselung legen.
> Geht er verloren, müssen alle Handys „Benachrichtigungen aktivieren“ erneut tippen (bzw. sich neu anmelden).

### Wiederherstellen

Beispiel: die Sicherung vom 5. November 2026 zurückspielen.

```sh
cd ~/DisplayBuddy/deploy
docker compose stop buddy
docker compose run --rm --no-deps buddy sh -c 'cp /data/backups/buddy-20261105.db /data/buddy.db && rm -f /data/buddy.db-wal /data/buddy.db-shm'
docker compose start buddy
```

Von einer heruntergeladenen Sicherung (liegt auf dem VPS z. B. unter `~/buddy-backup/backups/`):

```sh
cd ~/DisplayBuddy/deploy
docker compose stop buddy
docker compose run --rm --no-deps -v ~/buddy-backup:/restore:ro buddy sh -c 'cp /restore/backups/buddy-20261105.db /data/buddy.db && cp /restore/vapid.pem /data/vapid.pem && chmod 600 /data/vapid.pem && rm -f /data/buddy.db-wal /data/buddy.db-shm'
docker compose start buddy
```

Geräte gleichen danach automatisch ab. Neuere Änderungen, die nur auf einem PC oder Handy liegen, werden beim
nächsten Sync wieder hochgeladen.

Einzelne ältere Fassungen einer Notiz (Verlierer von Konflikten, 30 Tage aufbewahrt) zeigt
`docker compose exec buddy buddy-server revisions`, zurückholen mit
`docker compose exec buddy buddy-server restore <Nummer>`.

## 12. Updates

Vorher eine [Sicherung](#11-backups) ziehen. Dann:

```sh
cd ~/DisplayBuddy
git pull
cd deploy
docker compose up -d --build
docker image prune -f
```

Die Web-App auf dem Handy merkt das Update beim nächsten Öffnen und zeigt den Hinweis **„Eine neue Version von Display Buddy ist verfügbar.“** – auf
„Aktualisieren“ tippen, dann lädt sie neu. Der PC braucht nur dann ein Update, wenn eine neue Display-Buddy-Version
veröffentlicht wird.

Caddy und die Basis-Images sind mit festen Versionen eingetragen; sie ändern sich nur mit einem `git pull`,
nie von selbst.

## 13. Fehlersuche

Die wichtigsten Befehle (immer im Ordner `~/DisplayBuddy/deploy`):

```sh
docker compose ps
docker compose logs --tail 100 buddy
docker compose logs --tail 100 caddy
docker compose logs -f
```

(`-f` zeigt laufend neue Zeilen, beenden mit `Strg+C`.) Die Logs enthalten keine Notizen, Passwörter oder Schlüssel.

### Die Seite lädt nicht / Zertifikatsfehler

- DNS prüfen: `getent hosts buddy.example.org` muss die IP des VPS zeigen.
- Ports prüfen: `sudo ufw status` und die Firewall im Kundenmenü des Anbieters (80 und 443 offen?).
- In `docker compose logs caddy` nach `obtaining certificate` / `error` suchen. Typische Ursachen: DNS zeigt noch
  woanders hin, Port 80 ist gesperrt, `BUDDY_DOMAIN` in `.env` hat einen Tippfehler oder `https://` davor.
- Nach einer Korrektur: `docker compose up -d`.

### `buddy` startet nicht oder ist `unhealthy`

`docker compose logs --tail 50 buddy` zeigt die Ursache, z. B.:

| Meldung | Lösung |
|---|---|
| `reading VAPID key /data/vapid.pem` | Schritt 6 fehlt: `docker compose run --rm buddy buddy-server vapid generate` |
| `BUDDY_PUBLIC_URL must …` | `BUDDY_DOMAIN` in `.env` ohne `https://` und ohne `/` am Ende eintragen |
| `BUDDY_VAPID_SUBJECT must start with mailto: or https://` | in `.env` `mailto:` vor die Adresse setzen |
| `set BUDDY_DOMAIN in deploy/.env` (beim `docker compose`-Befehl) | `.env` fehlt oder Wert leer – Schritt 5 |
| `Pool overlaps with other one on this address space` | das Netz 172.30.0.0/24 ist schon belegt: in `.env` z. B. `BUDDY_SUBNET=172.31.250.0/24`, `BUDDY_IP_RANGE=172.31.250.128/25` und `CADDY_IP=172.31.250.10` setzen, dann `docker compose up -d` |

### Anmeldung klappt nicht

- Nach 5 falschen Versuchen sperrt der Server die Anmeldung für diesen Namen von dieser IP-Adresse – erst kurz,
  bei weiteren Fehlversuchen bis zu 15 Minuten. Abwarten.
- Passwort vergessen: `docker compose exec -it buddy buddy-server user passwd martin`
  (beendet alle Web-Anmeldungen; mit `--revoke-devices` zusätzlich alle PCs und Apps).

### Keine Benachrichtigung auf dem Handy

- iPhone/iPad: nur in der **installierten** App (Symbol auf dem Home-Bildschirm), iOS 16.4 oder neuer.
- In den Systemeinstellungen des Handys prüfen, ob Benachrichtigungen für Display Buddy bzw. Chrome erlaubt sind
  (und kein „Nicht stören“/Fokus aktiv ist).
- „Testbenachrichtigung senden“ erneut tippen und dabei `docker compose logs -f buddy` beobachten. Fehler beim
  Versand deuten meist auf gesperrte **ausgehende** Verbindungen hin ([Abschnitt 14](#14-ausgehende-verbindungen-des-servers)).
- Wurde `vapid.pem` neu erzeugt, auf jedem Handy „Benachrichtigungen aktivieren“ noch einmal tippen.

### PC zeigt „Abgemeldet – bitte neu verbinden“

Passwort wurde geändert oder das Gerät abgemeldet. In den Einstellungen neu verbinden – lokale Änderungen bleiben
erhalten und werden danach hochgeladen.

### Uhr-Warnung

Weicht die Uhr eines Geräts stark ab, warnt Display Buddy. Auf dem VPS mit `timedatectl` prüfen (Schritt 1), am
PC/Handy die automatische Zeiteinstellung einschalten.

## 14. Ausgehende Verbindungen des Servers

Der VPS muss nach außen über **HTTPS (TCP 443)** und **DNS (Port 53)** erreichen können; dazu NTP (UDP 123) für
die Uhrzeit. Eingehend sind nur 80/443 nötig. Hat Ihr Anbieter eine Firewall für ausgehende Verbindungen, müssen
diese Ziele erlaubt sein:

| Wer | Ziel | Wofür |
|---|---|---|
| Caddy | `acme-v02.api.letsencrypt.org` (Ausweichstelle: `acme.zerossl.com`) | HTTPS-Zertifikat holen und alle 60–90 Tage erneuern |
| buddy-server | `fcm.googleapis.com` | Web Push an Chrome/Android (und Edge/Brave/Samsung Internet auf Android) |
| buddy-server | `web.push.apple.com` (Apple nutzt Adressen unter `*.push.apple.com`) | Web Push an iPhone/iPad und Safari auf dem Mac |
| buddy-server | `updates.push.services.mozilla.com` | Web Push an Firefox |
| buddy-server | `*.notify.windows.com` | Web Push an Edge unter Windows (nur falls jemand die PWA dort nutzt) |
| buddy-server (nur native Android-App, optional) | `fcm.googleapis.com`, `oauth2.googleapis.com` | Aufwecken der nativen App über Firebase Cloud Messaging |
| VPS | `download.docker.com`, Docker Hub (`registry-1.docker.io`, `auth.docker.io`, `production.cloudflare.docker.com`), `github.com`, `registry.npmjs.org`, `index.crates.io`, `static.crates.io`, Debian/Ubuntu-Paketquellen | nur für Installation und Updates (Bauen des Images) |

Genau welche Push-Adresse benutzt wird, bestimmt der Browser des Handys beim Aktivieren der Benachrichtigungen. Am
einfachsten ist es, ausgehendes HTTPS generell zu erlauben – das ist bei fast allen VPS-Anbietern die
Voreinstellung.

## 15. Weitere Verwaltungsbefehle

Alle im Ordner `~/DisplayBuddy/deploy`:

| Zweck | Befehl |
|---|---|
| Geräte anzeigen | `docker compose exec buddy buddy-server device list` |
| Gerät abmelden (verloren/verkauft) | `docker compose exec buddy buddy-server device revoke <Geräte-ID>` |
| Passwort ändern | `docker compose exec -it buddy buddy-server user passwd martin` |
| Öffentlichen Push-Schlüssel anzeigen | `docker compose exec buddy buddy-server vapid public-key` |
| Alte Notiz-Fassungen anzeigen | `docker compose exec buddy buddy-server revisions` |
| Alle Befehle | `docker compose exec buddy buddy-server --help` |
| Stoppen | `docker compose down` (Daten bleiben erhalten) |
| Neu starten | `docker compose restart` |

> `docker compose down -v` würde zusätzlich **alle Daten löschen** (Volumes). Nicht verwenden, außer Sie wollen
> wirklich neu anfangen.

### Optional: native Android-App mit Firebase (Phase N2)

Nur wenn Sie die native Android-App mit Push über Firebase nutzen: Die Dienstkonto-Datei von Firebase in das
Daten-Volume kopieren und in `compose.yaml` die Zeile `BUDDY_FCM_SERVICE_ACCOUNT_FILE` einkommentieren. Die
genaue Anleitung steht in `mobile/README.md`. Diese Datei ist ein Geheimnis – niemals ins Git-Repository legen.
