# Display Buddy auf einem eigenen Server (VPS)

Diese Anleitung bringt den Sync-Server von Display Buddy auf einen gemieteten Linux-Server (VPS).
Danach synchronisieren PC und Handy ihre Notizen und Erinnerungen über **eine** Adresse, z. B.
`https://buddy.example.org`. Auf dem Handy läuft Display Buddy als Web-App (PWA) mit Benachrichtigungen.
Ab Version 0.4 kann der Server mehrere Konten haben, und Handys melden sich per QR-Code vom PC an.

> **Eigener Server oder Standard-Server?** Ohne eigenen Server können Sie den Standard-Server des Projekts
> (`buddy.pev-point.de`) nutzen – dann brauchen Sie diese Anleitung nicht ([Abschnitt 10](#10-pc-verbinden)).
> Ein eigener Server lohnt sich, wenn Ihre Notizen nur auf Ihrem Server liegen sollen.
>
> **Sie betreiben schon einen Server mit Version 0.3?** Dann direkt zu
> [Upgrade auf 0.4](#131-upgrade-von-version-03-v3-auf-04-v4).

Sie brauchen dafür keine Programmierkenntnisse. Jeder graue Block ist ein Befehl, den Sie komplett kopieren und
im Terminal einfügen können. Ersetzen Sie nur die Beispielwerte (`buddy.example.org`, `martin`, …).

**Was läuft auf dem Server?**

- **buddy-server** speichert die Daten (SQLite), liefert die Web-App aus und verschickt Benachrichtigungen.
  Er ist nur über einen vorgeschalteten Webserver (Reverse-Proxy) erreichbar.
- Der **Reverse-Proxy** nimmt die Verbindungen aus dem Internet an und sorgt für HTTPS (Let's Encrypt).
  Das ist entweder der mitgelieferte **Caddy** (Variante A) oder ein bei Ihnen schon vorhandener Proxy wie
  **Nginx Proxy Manager** (Variante B).

Alles läuft in Docker. Die Daten liegen im Docker-Volume `displaybuddy_buddy-data` (Datenbank, tägliche Backups,
der Push-Schlüssel `vapid.pem`).

## Welche Variante passt zu Ihnen?

| | Variante A – frischer VPS | Variante B – vorhandener Reverse-Proxy |
|---|---|---|
| Wann? | Auf dem Server läuft noch nichts auf Port 80/443 | Port 80/443 ist schon belegt (Nginx Proxy Manager, Traefik, Caddy …) |
| HTTPS/Zertifikat | mitgelieferter Caddy, automatisch | Ihr vorhandener Proxy |
| Compose-Datei | `compose.yaml` (Standard) | `compose.npm.yaml` (in `.env` eingetragen) |
| Schritte | 1 – 16 | 2, 3 (falls Docker fehlt), 5 – 16; statt Schritt 4 und 7 → [Variante B](#variante-b-hinter-nginx-proxy-manager) |

Prüfen, ob Port 80/443 belegt ist:

```sh
sudo ss -ltnp | grep -E ':(80|443) '
```

Erscheint hier eine Zeile, nehmen Sie **Variante B**. Alle `docker compose`-Befehle in dieser Anleitung sind in
beiden Varianten identisch.

---

## Inhalt

1. [VPS mieten und einloggen](#1-vps-mieten-und-einloggen)
2. [DNS-Eintrag anlegen](#2-dns-eintrag-anlegen)
3. [Docker installieren](#3-docker-installieren)
4. [Firewall einrichten](#4-firewall-einrichten) (nur Variante A)
5. [Display Buddy herunterladen und `.env` ausfüllen](#5-display-buddy-herunterladen-und-env-ausfüllen)
6. [Push-Schlüssel erzeugen (`vapid generate`)](#6-push-schlüssel-erzeugen)
7. [Starten](#7-starten) · [Variante B: hinter Nginx Proxy Manager](#variante-b-hinter-nginx-proxy-manager)
8. [Benutzer anlegen](#8-benutzer-anlegen)
9. [Konten verwalten](#9-konten-verwalten): Registrierung, Einladungscodes, Kontingente, Impressum/Datenschutz,
   Admin-Befehle, Passwort vergessen
10. [PC verbinden](#10-pc-verbinden) (Standard-Server oder eigener Server)
11. [Handy einrichten](#11-handy-einrichten) (QR-Code, Passwort als Alternative)
12. [Backups](#12-backups)
13. [Updates](#13-updates) · [Upgrade 0.3 → 0.4](#131-upgrade-von-version-03-v3-auf-04-v4)
14. [Fehlersuche](#14-fehlersuche)
15. [Ausgehende Verbindungen des Servers](#15-ausgehende-verbindungen-des-servers)
16. [Weitere Verwaltungsbefehle](#16-weitere-verwaltungsbefehle)

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

> **Nur Variante A.** In Variante B ist die Firewall bereits eingerichtet (Ports 80/443 gehören Ihrem Proxy);
> überspringen Sie diesen Schritt.

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
443/tcp, 443/udp). **Ausgehende** Verbindungen müssen erlaubt bleiben (siehe [Abschnitt 15](#15-ausgehende-verbindungen-des-servers)).

## 5. Display Buddy herunterladen und `.env` ausfüllen

```sh
cd ~
git clone https://github.com/cptnred/DisplayBuddy.git displaybuddy-src
cd ~/displaybuddy-src/deploy
cp .env.example .env
nano .env
```

> Enthält der Ordner `~/displaybuddy-src` danach keine Ordner `server/` und `crates/`, liegt der Server-Code noch
> nicht im Hauptzweig. Dann stattdessen den Entwicklungszweig klonen:
> `git clone --branch claude/display-buddy-v3-c9w0c8 https://github.com/cptnred/DisplayBuddy.git displaybuddy-src`

In `nano` die drei Werte anpassen:

```ini
BUDDY_DOMAIN=buddy.example.org
ACME_EMAIL=ihre-adresse@example.org
BUDDY_VAPID_SUBJECT=mailto:ihre-adresse@example.org
```

**Nur Variante B** – zusätzlich diese Zeilen am Ende der `.env` eintragen (im Beispiel sind sie auskommentiert,
das `#` entfernen):

```ini
COMPOSE_FILE=compose.npm.yaml
PROXY_NETWORK=proxy
PROXY_SUBNET=172.18.0.0/16
```

- `COMPOSE_FILE` sorgt dafür, dass `docker compose` die Datei für vorhandene Proxys nutzt – ohne eigenen Caddy
  und ohne veröffentlichte Ports.
- `PROXY_NETWORK` ist der Name des Docker-Netzes, in dem Ihr Proxy läuft. Ermitteln:
  `docker inspect <Proxy-Containername> --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}'`
  (Containername mit `docker ps` ablesen, z. B. `nginx-proxy-manager`).
- `PROXY_SUBNET` ist das Subnetz dieses Netzes: `docker network inspect proxy --format '{{range .IPAM.Config}}{{.Subnet}}{{end}}'`
  (`proxy` ggf. durch den Netznamen ersetzen). Nur Verbindungen aus diesem Netz gelten als vertrauenswürdiger
  Proxy; dadurch zählt die Anmelde-Bremse die echte Besucher-IP.
  Strenger: Hat Ihr Proxy-Container eine feste IP, tragen Sie nur diese ein (z. B. `172.18.0.5/32`); sonst gilt
  jeder Container in diesem Netz als vertrauenswürdig.
- `ACME_EMAIL` wird in Variante B nicht verwendet (das Zertifikat holt Ihr Proxy), muss aber nicht entfernt werden.

- `BUDDY_DOMAIN`: genau die Subdomain aus Schritt 2, **ohne** `https://`.
- `ACME_EMAIL`: dorthin schickt Let's Encrypt Warnungen, falls ein Zertifikat abläuft.
- `BUDDY_VAPID_SUBJECT`: Kontaktadresse für die Push-Dienste von Google/Apple/Mozilla, mit `mailto:` davor.

Die Einstellungen für Konten (Registrierung, Kontingente, Rechtslinks; ab Version 0.4) stehen auskommentiert
am Ende der Datei. Für den Anfang brauchen Sie keine davon – ohne Eintrag ist die Registrierung aus und es gibt
keine Kontingente ([Abschnitt 9](#9-konten-verwalten)).

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
cd ~/displaybuddy-src/deploy
docker compose build
docker compose run --rm buddy buddy-server vapid generate
```

Am Ende erscheint der öffentliche Schlüssel (eine lange Zeichenkette). Sie müssen ihn nirgends eintragen – die App
holt ihn sich selbst.

> **Den Schlüssel unbedingt mitsichern** (siehe [Backups](#12-backups)). Geht er verloren, müssen auf allen
> Handys die Benachrichtigungen neu aktiviert werden.
>
> Ein zweiter Aufruf überschreibt den Schlüssel **nicht** (er bricht mit einer Meldung ab). Nur mit `--force`
> würde ein neuer erzeugt – das ist fast nie gewünscht.

## 7. Starten

```sh
cd ~/displaybuddy-src/deploy
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

Antwort: `{"ok":true,"serverTime":"…"}`. Wenn nicht: [Fehlersuche](#14-fehlersuche).

Die Dienste starten nach einem Neustart des VPS automatisch wieder (`restart: unless-stopped`).

> **Variante B:** `docker compose ps` zeigt nur `buddy` (healthy), keinen Caddy. Der Test von außen klappt erst
> nach dem nächsten Abschnitt. Vorab testen Sie lokal:
> `docker compose exec buddy curl -fsS http://127.0.0.1:8080/api/v1/health`

### Variante B: hinter Nginx Proxy Manager

Ihr Proxy leitet `https://buddy.example.org` an den Container `displaybuddy-buddy-1` (Port 8080) weiter. Das
Docker-Netz muss dazu dasselbe sein wie das des Proxys (`PROXY_NETWORK`, Schritt 5).

1. Nginx-Proxy-Manager-Oberfläche öffnen → **Hosts → Proxy Hosts → Add Proxy Host**.
2. Reiter **Details**:
   - **Domain Names:** `buddy.example.org`
   - **Scheme:** `http`
   - **Forward Hostname / IP:** `displaybuddy-buddy-1`
   - **Forward Port:** `8080`
   - **Block Common Exploits** an, **Websockets Support** nicht nötig.
   - **Cache Assets** **aus** lassen: sonst speichert NPM JavaScript-Dateien (auch `sw.js`) 30 Tage zwischen und
     die Web-App bekommt keine Updates mehr.
3. Reiter **SSL**: **Request a new SSL Certificate**, **Force SSL** und **HTTP/2 Support** einschalten,
   Nutzungsbedingungen akzeptieren, **Save**.
4. Reiter **Advanced** leer lassen. Insbesondere keine eigenen `add_header`-Zeilen für Cache-Control oder
   Content-Security-Policy eintragen – die setzt buddy-server selbst, sonst gehen PWA-Updates kaputt.
5. Test von außen:

```sh
curl -fsS https://buddy.example.org/api/v1/health
```

Antwort: `{"ok":true,"serverTime":"…"}`.

Anderer Proxy (Traefik, eigener Caddy/nginx)? Das Prinzip ist dasselbe: Proxy und `buddy` im selben Docker-Netz,
Weiterleitung an `http://displaybuddy-buddy-1:8080`, `X-Forwarded-For` setzen (machen alle gängigen Proxys
von selbst), HTTPS am Proxy beenden. Optional kann der Proxy `Strict-Transport-Security: max-age=31536000`
hinzufügen.

## 8. Benutzer anlegen

Ein Benutzerkonto für alle Ihre Geräte. Statt `martin` Ihren Wunschnamen, statt `Europe/Berlin` Ihre Zeitzone
(Standardzone für Erinnerungen ohne eigene Zone):

```sh
cd ~/displaybuddy-src/deploy
docker compose exec -it buddy buddy-server user add martin --time-zone Europe/Berlin
```

Das Passwort wird zweimal abgefragt und beim Tippen **nicht angezeigt**. Es braucht **mindestens 12 Zeichen**.
Am Ende steht `Benutzer martin angelegt. Wiederherstellungscode (nur jetzt sichtbar):` und darunter ein Code aus
sechs Vierergruppen.

> **Den Wiederherstellungscode aufheben** (Passwort-Manager oder ausgedruckt). Mit ihm setzen Sie am PC ein neues
> Passwort, falls Sie Ihres vergessen („Passwort vergessen?“). Er wird nur dieses eine Mal angezeigt.

> Ist der Server gerade nicht gestartet, geht dasselbe mit
> `docker compose run --rm -it buddy buddy-server user add martin --time-zone Europe/Berlin`.

Weitere Konten für Familie oder Freunde legen Sie genauso an – oder Sie lassen die Personen ihr Konto selbst in der
Display-Buddy-App am PC anlegen ([Abschnitt 9](#9-konten-verwalten)).

## 9. Konten verwalten

Ab Version 0.4 kann ein Server **mehrere Konten** haben. Jedes Konto sieht nur seine eigenen Notizen und
Erinnerungen. Verwaltet wird alles mit Befehlen auf dem Server (es gibt keine Admin-Webseite).

Die Einstellungen stehen in `~/displaybuddy-src/deploy/.env`. Nach jeder Änderung dort:

```sh
cd ~/displaybuddy-src/deploy
docker compose up -d
```

`docker compose up -d` startet `buddy` mit den neuen Werten neu (wenige Sekunden). Ein falscher Wert verhindert den
Start; `docker compose logs --tail 20 buddy` nennt dann die Variable ([Fehlersuche](#14-fehlersuche)).

### 9.1 Wer darf Konten anlegen?

| `BUDDY_REGISTRATION=` | Bedeutung |
|---|---|
| `closed` (Standard) | Niemand kann sich selbst registrieren. Konten legen nur Sie mit `user add` an. |
| `invite` | Wer einen **Einladungscode** von Ihnen hat, legt sein Konto selbst in der App am PC an. |
| `open` | Jeder, der die Adresse kennt, kann ein Konto anlegen. |

Registrieren geht nur in der **Display-Buddy-App am PC** (Einstellungen → „Konto & Handy“ → „Konto anlegen“),
nicht am Handy. Handys kommen danach per QR-Code dazu ([Abschnitt 11](#11-handy-einrichten)).

Beispiel Einladungen einschalten – in `.env` die Zeile ergänzen bzw. das `#` entfernen:

```ini
BUDDY_REGISTRATION=invite
```

Dann `docker compose up -d` und prüfen:

```sh
curl -fsS https://buddy.example.org/api/v1/info
```

In der Antwort steht `"registration":"invite"`.

> **`open` nur mit Bedacht.** Dann betreiben Sie einen Dienst für fremde Menschen: Sie brauchen in der Regel ein
> Impressum und eine Datenschutzerklärung ([9.4](#94-impressum-und-datenschutz)) und sollten Kontingente setzen
> ([9.3](#93-kontingente)). Der Server bremst Massen-Registrierungen ab (eine kleine Rechenaufgabe für den PC,
> höchstens 3 Konten pro Stunde und 10 pro Tag je IP-Adresse, insgesamt
> `BUDDY_REGISTRATION_DAILY_LIMIT` = 200 pro Tag) – verhindern kann er sie nicht. Für Familie und Freunde ist
> `invite` die bessere Wahl.

Feineinstellungen (meist nicht nötig):

| Variable | Standard | Bedeutung |
|---|---|---|
| `BUDDY_REGISTRATION_POW_BITS` | `22` | Schwierigkeit der Rechenaufgabe (1–32). Jede Stufe mehr verdoppelt die Rechenzeit am PC (22 ≈ unter einer Sekunde). |
| `BUDDY_REGISTRATION_DAILY_LIMIT` | `200` | Registrierungen pro Tag insgesamt |

### 9.2 Einladungscodes

Nur sinnvoll mit `BUDDY_REGISTRATION=invite`. Einen Code erzeugen (hier 7 Tage gültig, mit einer Notiz für Sie):

```sh
cd ~/displaybuddy-src/deploy
docker compose exec buddy buddy-server invite create --expires 7d --label "für Anna"
```

Es erscheint `Einladungscode (nur jetzt sichtbar):` und der Code. Geben Sie ihn der Person; sie trägt ihn beim
„Konto anlegen“ am PC ins Feld **„Einladungscode“** ein. Jeder Code gilt für **ein** Konto.

- Gültigkeit: `--expires 7d` (Tage), `--expires 24h` (Stunden) oder `--expires 30m` (Minuten). Ohne `--expires`
  läuft der Code nicht ab.
- Alle Einladungen anzeigen (wer welchen Code benutzt hat):

  ```sh
  docker compose exec buddy buddy-server invite list
  ```

  Die erste Spalte `id` ist **nicht** der Code, nur eine Kennung zum Löschen.
- Eine unbenutzte Einladung zurückziehen (`<id>` aus `invite list`, 12 Zeichen):

  ```sh
  docker compose exec buddy buddy-server invite revoke <id>
  ```

### 9.3 Kontingente

Kontingente begrenzen, wie viel ein Konto speichern darf. **Standard: unbegrenzt.** Für alle Konten zugleich in
`.env`:

```ini
BUDDY_QUOTA_BYTES=52428800
BUDDY_QUOTA_NOTES=5000
BUDDY_QUOTA_DEVICES=10
```

(52428800 Byte = 50 MB; gezählt werden Notizen, Erinnerungen und die aufbewahrten älteren Fassungen.) Eine Zeile
weglassen bzw. leer lassen = unbegrenzt.

Einzelne Konten abweichend einstellen und nachsehen:

```sh
docker compose exec buddy buddy-server user quota anna --bytes 104857600 --devices 20
docker compose exec buddy buddy-server user show anna
```

- `--bytes`, `--notes`, `--devices` einzeln oder zusammen; `default` statt einer Zahl setzt das Konto auf den
  Wert aus `.env` zurück, z. B. `user quota anna --notes default`.
- `0` heißt wirklich null (nichts erlaubt). Ein Konto ohne Grenze bei gesetztem Server-Standard: eine sehr große
  Zahl eintragen.
- `user show` zeigt Verbrauch und Grenze, z. B. `bytes: 1048576 / 104857600`.

Ist das Kontingent voll, bleiben alle Daten erhalten; nur **neue** Inhalte werden nicht mehr hochgeladen. Die App
sagt „Der Speicher deines Kontos ist voll. …“. Löschen und Kürzen geht immer. Bei zu vielen Geräten meldet die
Anmeldung „Zu viele Geräte. Bitte zuerst ein altes Gerät abmelden.“

### 9.4 Impressum und Datenschutz

Lassen Sie Fremde Konten anlegen, verlinken die Apps Ihre Rechtsseiten (bei „Konto anlegen“, auf der
Anmeldeseite und in den Einstellungen). Eintragen in `.env` – nur `https://`-Adressen, sonst startet der Server
nicht:

```ini
BUDDY_IMPRINT_URL=https://example.org/impressum
BUDDY_PRIVACY_URL=https://example.org/datenschutz
BUDDY_TERMS_URL=https://example.org/nutzungsbedingungen
BUDDY_OPERATOR_NAME=example.org
```

`BUDDY_TERMS_URL` (Nutzungsbedingungen) und `BUDDY_OPERATOR_NAME` (Ihr Name bzw. Ihre Domain) sind optional. Was
in Impressum und Datenschutzerklärung gehört, listet `docs/OPERATIONS.md` (Checkliste, **kein Rechtsrat**).

### 9.5 Admin-Befehle

Alle im Ordner `~/displaybuddy-src/deploy`, jeweils mit `docker compose exec buddy buddy-server` davor
(z. B. `docker compose exec buddy buddy-server user list`). Befehle, die ein Passwort abfragen, brauchen
`docker compose exec -it buddy buddy-server` (mit `-it`):

| Zweck | Befehl |
|---|---|
| Alle Konten anzeigen (Geräte, Wiederherstellungscode vorhanden, gesperrt) | `user list` |
| Ein Konto im Detail (Zeitzone, Verbrauch, Kontingente) | `user show anna` |
| Konto anlegen (mit `-it`, fragt das Passwort ab; gibt einen Wiederherstellungscode aus) | `user add anna --time-zone Europe/Berlin` |
| Konto sperren – alle Geräte bekommen sofort „Das Konto ist gesperrt.“ | `user disable anna` |
| Sperre aufheben | `user enable anna` |
| Konto **mit allen Daten sofort löschen** | `user delete anna --yes` |
| Kontingente setzen ([9.3](#93-kontingente)) | `user quota anna --bytes 104857600 --notes 10000 --devices 20` |
| Neuen Wiederherstellungscode ausgeben (der alte gilt dann nicht mehr) | `user recovery anna` |
| Passwort setzen (mit `-it`); beendet die Web-Anmeldungen | `user passwd anna` |
| … und zusätzlich alle PCs und Apps abmelden (mit `-it`) | `user passwd anna --revoke-devices` |
| Einladung erzeugen / anzeigen / zurückziehen ([9.2](#92-einladungscodes)) | `invite create --expires 7d --label "für Anna"` · `invite list` · `invite revoke <id>` |
| Geräte aller Konten anzeigen / eins abmelden | `device list` · `device revoke <Geräte-ID>` |
| Hilfe zu einem Befehl | `user --help`, `invite create --help` |

> `user delete` fragt nicht nach – ohne `--yes` bricht es nur mit einem Hinweis ab. Gelöschte Konten stecken noch
> bis zu 14 Tage in den täglichen Sicherungen; einzelne Konten lassen sich daraus **nicht** zurückholen.

### 9.6 Passwort vergessen

Das können die Nutzer meist selbst:

- **Am PC mit dem Wiederherstellungscode:** Anmelden → „Passwort vergessen?“ → Benutzername, Code, neues
  Passwort. Danach sind alle anderen Geräte abgemeldet und es gibt einen neuen Code.
- **Auf einem Gerät, das noch angemeldet ist** (PC oder Handy-App, seit mindestens 24 Stunden): „Passwort ändern“
  → „Ich kenne mein aktuelles Passwort nicht“.

Geht beides nicht, helfen Sie als Admin – **nur, wenn Sie sicher wissen, wer fragt**:

```sh
docker compose exec buddy buddy-server user recovery anna
```

Der neue Code erscheint einmal; die Person setzt damit am PC über „Passwort vergessen?“ selbst ein neues Passwort.
Alternativ setzen Sie es direkt mit `user passwd anna` (Tabelle oben).

## 10. PC verbinden

In Display Buddy am PC (ab Version 0.4):

1. **Einstellungen** öffnen → Abschnitt **„Konto & Handy“**.
2. Dort steht **„Server: buddy.pev-point.de“** – das ist der **Standard-Server** des Projekts. Für Ihren eigenen
   Server auf **„Eigenen Server verwenden …“** klicken und als **Server-Adresse** `https://buddy.example.org`
   eintragen.
3. **„Anmelden“** wählen: Benutzername und Passwort aus Schritt 8, **Gerätename** z. B. „Büro-PC“.
   Wer noch kein Konto hat und Sie die Registrierung erlaubt haben ([9.1](#91-wer-darf-konten-anlegen)), wählt
   stattdessen **„Konto anlegen“**.
4. Beim ersten Verbinden werden die Notizen des PCs mit denen auf dem Server zusammengeführt – es geht nichts
   verloren.

**Standard-Server oder eigener Server?**

| | Standard-Server `buddy.pev-point.de` | Eigener Server (diese Anleitung) |
|---|---|---|
| Einrichtung | keine – „Konto anlegen“ in der App | VPS, Docker, diese Anleitung |
| Wer betreibt ihn / sieht die Daten? | das Display-Buddy-Projekt | nur Sie |
| Konten | Registrierung, sobald der Betreiber sie öffnet; Kontingente | wie Sie es in [Abschnitt 9](#9-konten-verwalten) einstellen |

**„Standard-Server verwenden“** stellt zurück. Ist der PC gerade mit einem anderen Server verbunden, zuerst
„Trennen (nur dieser PC)“ – die Notizen bleiben auf dem PC.

> **Display Buddy 0.3 am PC:** Abschnitt heißt dort **„Synchronisation“**; Server-Adresse, Benutzer, Passwort und
> Gerätename eintragen und **„Verbinden“** klicken. Konto anlegen und „Handy verbinden“ gibt es erst ab 0.4.

Weitere PCs genauso verbinden. Der PC funktioniert auch ohne Server weiter wie bisher und gleicht nach, sobald er
wieder Verbindung hat.

## 11. Handy einrichten

> **Pro Handy entweder die Web-App (PWA) oder die native App** (siehe `mobile/README.md`) – nicht beides. Beide auf
> demselben Handy funktionieren zwar, jede Erinnerung käme dann aber doppelt.

Das Handy meldet sich am einfachsten per **QR-Code vom PC** an – kein Abtippen von Adresse, Name und Passwort.
Dazu muss der PC schon verbunden sein ([Abschnitt 10](#10-pc-verbinden)).

### 11.1 Web-App installieren

1. Auf dem Handy im Browser `https://buddy.example.org` öffnen – unter Android in **Chrome**, auf dem iPhone/iPad
   in **Safari**.
2. Installieren (Symbol auf dem Startbildschirm):
   - **Android (Chrome):** Menü **⋮** → **„App installieren“** (bzw. „Zum Startbildschirm hinzufügen“). Erscheint
     in der App der Knopf „App installieren“, geht es auch darüber.
   - **iPhone/iPad (Safari):** unten (iPad: oben) auf **Teilen** (Quadrat mit Pfeil) → **„Zum Home-Bildschirm“** →
     „Hinzufügen“.
3. Display Buddy ab jetzt **über das neue Symbol** öffnen.

> **iPhone/iPad:** Benachrichtigungen gibt es nur für die installierte App (ab iOS 16.4), nicht im Safari-Tab.
> Außerdem löscht Safari Daten nicht installierter Web-Apps nach einigen Tagen ohne Nutzung. Bitte also immer
> installieren.

### 11.2 Anmelden per QR-Code

1. **Am PC:** Einstellungen → „Konto & Handy“ → **„Handy verbinden“**. Ein QR-Code erscheint, darunter ein Code
   zum Abtippen (`XXXX-XXXX-XXXX`). Beides gilt **3 Minuten** und nur einmal.
2. **Am Handy** in der installierten App auf der Anmeldeseite **„QR-Code scannen“** tippen, den Kamera-Zugriff
   erlauben und den QR-Code am PC scannen.
   - Kein Kamera-Zugriff oder die Kamera startet nicht: **„Code eingeben“** wählen und den Code vom PC abtippen.
   - Alternativ mit der **Kamera-App** des Handys scannen: Es öffnet sich die Seite „Dieses Gerät anmelden“ im
     Browser → **„Hier anmelden“**. Das meldet den Browser an – die installierte App ist dann nicht unbedingt
     mit angemeldet (auf dem iPhone öffnet die Kamera immer Safari). Deshalb besser in der installierten App
     scannen oder dort den Code eingeben; die Seite zeigt ihn dafür auch an.
3. Der PC zeigt **„✓ ‚…‘ ist jetzt angemeldet.“** Waren Sie das nicht, sofort **„Das war ich nicht – abmelden“**
   klicken.

**Mit Passwort anmelden** geht weiterhin: auf der Anmeldeseite „Mit Passwort anmelden“ → Benutzername, Passwort,
Gerätename. Das ist auch der Weg, wenn der PC noch Version 0.3 hat.

> **Native Android-App:** Sie ist beim Bauen auf einen Server eingestellt (Standard: buddy.pev-point.de). Für Ihren
> Server auf der Anmeldeseite bei „Server: … · ändern“ `https://buddy.example.org` eintragen – oder einfach den
> QR-Code Ihres PCs scannen: Die App fragt dann „Anderer Server“ und zeigt Ihre Adresse; nur bestätigen, wenn es
> wirklich Ihr Server ist. Details: `mobile/README.md`.

### 11.3 Benachrichtigungen aktivieren

1. In der App **Einstellungen → Benachrichtigungen** öffnen.
2. Auf **„Benachrichtigungen aktivieren“** tippen und die Rückfrage des Systems mit **„Erlauben“** bestätigen.
3. Auf **„Testbenachrichtigung senden“** tippen. Innerhalb weniger Sekunden muss eine Benachrichtigung erscheinen.

Kommt keine: [Fehlersuche → Keine Benachrichtigung](#keine-benachrichtigung-auf-dem-handy).

> Die Web-App benachrichtigt über das Internet. Ist das Handy offline, kommt die Erinnerung, sobald es wieder
> Netz hat. Wer Erinnerungen auch ganz ohne Netz braucht, nimmt auf diesem Handy die native App.

## 12. Backups

**Automatisch auf dem Server:** buddy-server legt einmal am Tag (UTC) eine Kopie der Datenbank unter
`/data/backups/buddy-JJJJMMTT.db` an und behält die letzten 14. Diese Kopien liegen aber auf demselben Server –
**holen Sie regelmäßig eine Kopie herunter**, inklusive des Push-Schlüssels `vapid.pem` (und, falls vorhanden,
`fcm-service-account.json`). Eine automatische, verschlüsselte Sicherung außer Haus mit restic beschreibt
`docs/OPERATIONS.md`.

### Sicherung auf dem VPS einsammeln

```sh
cd ~/displaybuddy-src/deploy
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
>
> Die Sicherungen enthalten die Notizen **aller** Konten im Klartext. Heben Sie heruntergeladene Kopien nicht
> länger als nötig auf – gelöschte Konten sollen nach 14 Tagen auch aus den Sicherungen verschwunden sein.

### Wiederherstellen

Beispiel: die Sicherung vom 5. November 2026 zurückspielen.

```sh
cd ~/displaybuddy-src/deploy
docker compose stop buddy
docker compose run --rm --no-deps buddy sh -c 'cp /data/backups/buddy-20261105.db /data/buddy.db && rm -f /data/buddy.db-wal /data/buddy.db-shm'
docker compose start buddy
```

Von einer heruntergeladenen Sicherung (liegt auf dem VPS z. B. unter `~/buddy-backup/backups/`):

```sh
cd ~/displaybuddy-src/deploy
docker compose stop buddy
docker compose run --rm --no-deps -T buddy sh -c 'umask 077 && cat > /data/buddy.db && rm -f /data/buddy.db-wal /data/buddy.db-shm' < ~/buddy-backup/backups/buddy-20261105.db
docker compose run --rm --no-deps -T buddy sh -c 'umask 077 && cat > /data/vapid.pem' < ~/buddy-backup/vapid.pem
docker compose start buddy
```

(Die Dateien werden über `<` hineingereicht, weil der Container nicht als `root` läuft und Ihre geschützten
Sicherungsdateien nicht selbst lesen darf.)

Geräte gleichen danach automatisch ab. Neuere Änderungen, die nur auf einem PC oder Handy liegen, werden beim
nächsten Sync wieder hochgeladen.

Einzelne ältere Fassungen einer Notiz (Verlierer von Konflikten, 30 Tage aufbewahrt) zeigt
`docker compose exec buddy buddy-server revisions`, zurückholen mit
`docker compose exec buddy buddy-server restore <Nummer>`.

## 13. Updates

Vorher eine [Sicherung](#12-backups) ziehen. Dann (Schritt für Schritt für buddy.pev-point.de: `docs/UPDATE.md`):

```sh
cd ~/displaybuddy-src
git pull
cd deploy
docker compose up -d --build
docker image prune -f
```

Die Web-App auf dem Handy merkt das Update beim nächsten Öffnen und zeigt den Hinweis **„Eine neue Version von
Display Buddy ist verfügbar.“** – auf „Aktualisieren“ tippen, dann lädt sie neu. Der PC braucht nur dann ein
Update, wenn eine neue Display-Buddy-Version veröffentlicht wird.

Caddy (nur Variante A) und die Basis-Images sind mit festen Versionen eingetragen; sie ändern sich nur mit einem
`git pull`, nie von selbst.

### 13.1 Upgrade von Version 0.3 (v3) auf 0.4 (v4)

**Was sich für Sie ändert: zunächst nichts.** Die Registrierung bleibt **aus** (`closed`), alle Konten, Geräte und
Anmeldungen bleiben gültig, die Adresse der Web-App bleibt gleich. PCs und Handys mit der alten Version
synchronisieren weiter wie bisher.

**Was neu ist** (alles optional):

- Konten in der PC-App anlegen – nur wenn Sie es erlauben ([9.1](#91-wer-darf-konten-anlegen)), auch per
  [Einladungscode](#92-einladungscodes).
- Handy per **QR-Code** anmelden ([11.2](#112-anmelden-per-qr-code)); Passwort-Anmeldung bleibt.
- **Wiederherstellungscode** gegen vergessene Passwörter; Passwort ändern, Daten exportieren, Konto löschen und
  Geräte abmelden direkt in den Apps.
- [Kontingente](#93-kontingente), [Rechtslinks](#94-impressum-und-datenschutz) und neue
  [Admin-Befehle](#95-admin-befehle).
- `https://buddy.example.org/api/v1/info` zeigt Version und Registrierungsmodus (ohne Anmeldung, für die Apps).

**So geht's:**

1. Frische Sicherung direkt vor dem Update (für den Fall, dass Sie zurück auf 0.3 müssen):

   ```sh
   cd ~/displaybuddy-src/deploy
   docker compose stop buddy
   docker compose run --rm --no-deps buddy sh -c 'mkdir -p /data/vor-v4 && cp -a /data/buddy.db* /data/vor-v4/'
   git -C ~/displaybuddy-src rev-parse HEAD > ~/displaybuddy-vor-v4.txt
   ```

   Die letzte Zeile merkt sich den bisherigen Programmstand.

2. Update wie oben: `cd ~/displaybuddy-src && git pull && cd deploy && docker compose up -d --build`.
   Beim ersten Start ergänzt der Server die Datenbank automatisch (Migration `0003_accounts`); vorhandene Daten
   werden dabei nicht verändert.
3. Prüfen:

   ```sh
   docker compose ps
   curl -fsS https://buddy.example.org/api/v1/info
   docker compose exec buddy buddy-server user list
   ```

   `buddy` ist `healthy`, die Antwort enthält `"apiLevel":2` und `"registration":"closed"`, Ihre Konten sind da.
4. **Wiederherstellungscode nachholen.** Konten aus der Zeit vor 0.4 haben noch keinen (`user list`, Spalte
   `recovery` = `no`). Entweder am PC mit Display Buddy 0.4 unter „Konto & Handy“ → „Code erzeugen“ oder hier:

   ```sh
   docker compose exec buddy buddy-server user recovery martin
   ```

5. Danach nach Wunsch: Registrierung oder Einladungen einschalten, Kontingente setzen ([Abschnitt 9](#9-konten-verwalten)).
   Ein PC mit Display Buddy 0.4 braucht nichts Neues: Er bleibt mit Ihrem Server verbunden und zeigt
   „Eigener Server: …“.

**Zurück auf 0.3?** Ein 0.3-Server startet mit der ergänzten Datenbank nicht mehr. Deshalb zuerst die Sicherung
aus Schritt 1 zurückspielen, dann den alten Programmstand bauen:

```sh
cd ~/displaybuddy-src/deploy
docker compose stop buddy
docker compose run --rm --no-deps buddy sh -c 'rm -f /data/buddy.db-wal /data/buddy.db-shm && cp -a /data/vor-v4/. /data/'
git -C ~/displaybuddy-src checkout "$(cat ~/displaybuddy-vor-v4.txt)"
docker compose up -d --build
```

Konten und Einstellungen aus der Zeit nach dem Update gehen dabei verloren; Notizen, die Geräte seitdem geändert
haben, laden diese beim nächsten Sync erneut hoch. Später wieder auf den aktuellen Stand: `git -C ~/displaybuddy-src
checkout -` und die Update-Schritte. Läuft 0.4 einige Tage stabil, können
Sie die Kopie löschen: `docker compose exec buddy rm -r /data/vor-v4`.

## 14. Fehlersuche

Die wichtigsten Befehle (immer im Ordner `~/displaybuddy-src/deploy`):

```sh
docker compose ps
docker compose logs --tail 100 buddy
docker compose logs --tail 100 caddy   # nur Variante A
docker compose logs -f
```

(`-f` zeigt laufend neue Zeilen, beenden mit `Strg+C`.) Die Logs enthalten keine Notizen, Passwörter, Codes oder
Schlüssel. Docker behält je Dienst höchstens 5 × 10 MB Log und löscht Älteres selbst.

### Die Seite lädt nicht / Zertifikatsfehler

- DNS prüfen: `getent hosts buddy.example.org` muss die IP des VPS zeigen.
- Ports prüfen: `sudo ufw status` und die Firewall im Kundenmenü des Anbieters (80 und 443 offen?).
- In `docker compose logs caddy` (Variante B: in den Logs bzw. im SSL-Reiter Ihres Proxys) nach `obtaining certificate` / `error` suchen. Typische Ursachen: DNS zeigt noch
  woanders hin, Port 80 ist gesperrt, `BUDDY_DOMAIN` in `.env` hat einen Tippfehler oder `https://` davor.
- Nach einer Korrektur: `docker compose up -d`.

### `buddy` startet nicht oder ist `unhealthy`

`docker compose logs --tail 50 buddy` zeigt die Ursache, z. B.:

| Meldung | Lösung |
|---|---|
| `reading VAPID key /data/vapid.pem` | Schritt 6 fehlt: `docker compose run --rm buddy buddy-server vapid generate` |
| `BUDDY_PUBLIC_URL must …` | `BUDDY_DOMAIN` in `.env` ohne `https://` und ohne `/` am Ende eintragen |
| `BUDDY_VAPID_SUBJECT must start with mailto: or https://` | in `.env` `mailto:` vor die Adresse setzen |
| `BUDDY_REGISTRATION must be open, invite or closed` | in `.env` genau `open`, `invite` oder `closed` (klein geschrieben) |
| `BUDDY_QUOTA_BYTES must be a whole number from 1 to …` (ebenso `_NOTES`, `_DEVICES`, `BUDDY_REGISTRATION_…`) | nur Ziffern, ohne Einheit („50MB“ geht nicht: `52428800`); für „unbegrenzt“ die Zeile weglassen |
| `BUDDY_IMPRINT_URL must be an https:// URL` (ebenso `PRIVACY`, `TERMS`) | vollständige Adresse mit `https://` eintragen oder die Zeile weglassen |
| `BUDDY_FCM_PAYLOAD must be minimal or full` | in `.env` `minimal` oder `full` |
| `set BUDDY_DOMAIN in deploy/.env` (beim `docker compose`-Befehl) | `.env` fehlt oder Wert leer – Schritt 5 |
| `Pool overlaps with other one on this address space` (Variante A) | das Netz 172.30.0.0/24 ist schon belegt: in `.env` z. B. `BUDDY_SUBNET=172.31.250.0/24`, `BUDDY_IP_RANGE=172.31.250.128/25` und `CADDY_IP=172.31.250.10` setzen, dann `docker compose up -d` |
| `network proxy declared as external, but could not be found` (Variante B) | `PROXY_NETWORK` in `.env` stimmt nicht: Netznamen mit `docker network ls` nachsehen und eintragen |
| NPM zeigt **502 Bad Gateway** (Variante B) | Proxy-Host muss auf `displaybuddy-buddy-1`, Port `8080`, Scheme `http` zeigen, und der Proxy muss im Netz `PROXY_NETWORK` hängen. Test: `docker exec <Proxy-Container> curl -fsS http://displaybuddy-buddy-1:8080/api/v1/health` |
| Anmelde-Sperre trifft alle Geräte gleichzeitig (Variante B) | `PROXY_SUBNET` in `.env` stimmt nicht mit dem Subnetz des Proxy-Netzes überein: `docker network inspect <Netz> --format '{{range .IPAM.Config}}{{.Subnet}}{{end}}'`, dann `docker compose up -d` |

### Anmeldung klappt nicht

- Nach 5 falschen Versuchen sperrt der Server die Anmeldung für diesen Namen von dieser IP-Adresse – erst kurz,
  bei weiteren Fehlversuchen bis zu 15 Minuten. Nach 30 Fehlversuchen in einer Stunde (egal mit welchem Namen)
  ist die IP-Adresse 15 Minuten gesperrt. Abwarten.
- **QR-Code / Anmeldecode:** „Der Code ist ungültig, abgelaufen oder wurde schon benutzt.“ – am PC
  „Neuen Code“ holen (gilt 3 Minuten). Nach 10 falschen Codes in 10 Minuten sperrt der Server diese IP-Adresse
  15 Minuten lang.
- „Das Konto ist gesperrt.“ – `docker compose exec buddy buddy-server user enable <name>`.
- „Zu viele Geräte.“ – altes Gerät abmelden (in der App unter „Geräte“ oder mit `device revoke`) oder
  das [Kontingent](#93-kontingente) anheben.
- „Dieser Server ist zu alt für diese Funktion“ – der Server läuft noch mit 0.3: [Upgrade](#131-upgrade-von-version-03-v3-auf-04-v4).
- „Auf diesem Server kann man sich nicht selbst registrieren.“ – gewollt bei `BUDDY_REGISTRATION=closed`
  ([9.1](#91-wer-darf-konten-anlegen)).
- Passwort vergessen: [9.6](#96-passwort-vergessen).

### Keine Benachrichtigung auf dem Handy

- iPhone/iPad: nur in der **installierten** App (Symbol auf dem Home-Bildschirm), iOS 16.4 oder neuer.
- In den Systemeinstellungen des Handys prüfen, ob Benachrichtigungen für Display Buddy bzw. Chrome erlaubt sind
  (und kein „Nicht stören“/Fokus aktiv ist).
- „Testbenachrichtigung senden“ erneut tippen und dabei `docker compose logs -f buddy` beobachten. Fehler beim
  Versand deuten meist auf gesperrte **ausgehende** Verbindungen hin ([Abschnitt 15](#15-ausgehende-verbindungen-des-servers)).
- Wurde `vapid.pem` neu erzeugt, auf jedem Handy „Benachrichtigungen aktivieren“ noch einmal tippen.

### PC zeigt „Abgemeldet – bitte neu verbinden“

Passwort wurde geändert oder das Gerät abgemeldet. In den Einstellungen neu verbinden – lokale Änderungen bleiben
erhalten und werden danach hochgeladen.

### Uhr-Warnung

Weicht die Uhr eines Geräts stark ab, warnt Display Buddy. Auf dem VPS mit `timedatectl` prüfen (Schritt 1), am
PC/Handy die automatische Zeiteinstellung einschalten.

## 15. Ausgehende Verbindungen des Servers

Der VPS muss nach außen über **HTTPS (TCP 443)** und **DNS (Port 53)** erreichen können; dazu NTP (UDP 123) für
die Uhrzeit. Eingehend sind nur 80/443 nötig. Hat Ihr Anbieter eine Firewall für ausgehende Verbindungen, müssen
diese Ziele erlaubt sein:

| Wer | Ziel | Wofür |
|---|---|---|
| Caddy (Variante A) bzw. Ihr Proxy (Variante B) | `acme-v02.api.letsencrypt.org` (Ausweichstelle: `acme.zerossl.com`) | HTTPS-Zertifikat holen und alle 60–90 Tage erneuern |
| buddy-server | `fcm.googleapis.com` | Web Push an Chrome/Android (und Edge/Brave/Samsung Internet auf Android) |
| buddy-server | `web.push.apple.com` (Apple nutzt Adressen unter `*.push.apple.com`) | Web Push an iPhone/iPad und Safari auf dem Mac |
| buddy-server | `updates.push.services.mozilla.com` | Web Push an Firefox |
| buddy-server | `*.notify.windows.com` | Web Push an Edge unter Windows (nur falls jemand die PWA dort nutzt) |
| buddy-server (nur native Android-App, optional) | `fcm.googleapis.com`, `oauth2.googleapis.com` | Aufwecken der nativen App über Firebase Cloud Messaging |
| VPS | `download.docker.com`, Docker Hub (`registry-1.docker.io`, `auth.docker.io`, `production.cloudflare.docker.com`), `github.com`, `registry.npmjs.org`, `index.crates.io`, `static.crates.io`, Debian/Ubuntu-Paketquellen | nur für Installation und Updates (Bauen des Images) |

Genau welche Push-Adresse benutzt wird, bestimmt der Browser des Handys beim Aktivieren der Benachrichtigungen. Am
einfachsten ist es, ausgehendes HTTPS generell zu erlauben – das ist bei fast allen VPS-Anbietern die
Voreinstellung.

## 16. Weitere Verwaltungsbefehle

Alle im Ordner `~/displaybuddy-src/deploy` (Konten, Einladungen, Kontingente: [Abschnitt 9.5](#95-admin-befehle)):

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

### Optional: native Android-App mit Firebase

Ohne Firebase holt sich die native Android-App neue Erinnerungen selbst im Hintergrund (etwa alle 3 Minuten).
Firebase (FCM) weckt sie nur schneller. Es funktioniert nur, wenn die App mit **Ihrem eigenen** Firebase-Projekt
gebaut ist (`mobile/README.md`) – die offizielle App bekommt von Ihrem Server keine Firebase-Weckrufe.

1. Die Dienstkonto-Datei von Firebase auf den VPS kopieren (z. B. nach `~/fcm-service-account.json`) und in das
   Daten-Volume legen:

   ```sh
   cd ~/displaybuddy-src/deploy
   docker compose run --rm --no-deps -T buddy sh -c 'umask 077 && cat > /data/fcm-service-account.json' < ~/fcm-service-account.json
   rm ~/fcm-service-account.json
   ```

2. In `.env` eintragen und `docker compose up -d`:

   ```ini
   BUDDY_FCM_SERVICE_ACCOUNT_FILE=/data/fcm-service-account.json
   ```

3. Im Log (`docker compose logs buddy`) steht „native push via FCM HTTP v1 enabled“; ist die Datei unlesbar oder
   kein Dienstkonto-Schlüssel, startet der Server nicht und nennt den Grund.

Mit `BUDDY_FCM_PAYLOAD=minimal` zeigt die Benachrichtigung nur „Erinnerung fällig“ statt Titel und Text – dann
sieht Google keine Inhalte (Web Push ist ohnehin verschlüsselt). Standard ist `full`.

Diese Datei ist ein Geheimnis – niemals ins Git-Repository legen, aber mitsichern ([Abschnitt 12](#12-backups)).
