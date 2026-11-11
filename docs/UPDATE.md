# Server aktualisieren – buddy.pev-point.de

Stand: 2026-11-11 · Kurzanleitung für den Betreiber. Ausführliches dazu: `deploy/README.md` §13 und
`docs/OPERATIONS.md` §12.

## Wo liegt was?

| Was | Wert |
|---|---|
| Anmeldung | per SSH als Benutzer `martin` (Adresse und Schlüsseldatei: `~/.ssh/config`). **Kein root nötig** – `martin` darf `docker` ohne `sudo`. |
| Programm (Git-Ordner) | `~/displaybuddy-src` = `/home/martin/displaybuddy-src`, Branch `claude/display-buddy-v3-c9w0c8` |
| **Arbeitsordner für alle Befehle** | `~/displaybuddy-src/deploy` – hier liegt die `.env` |
| Container / Daten | `displaybuddy-buddy-1` · Docker-Volume `displaybuddy_buddy-data` (Datenbank unter `/data/buddy.db`) |
| Proxy | Nginx Proxy Manager, Proxy-Host Nr. 7 (`COMPOSE_FILE=compose.npm.yaml:compose.site.yaml` in der `.env`) |
| Eigene Seiten | `~/displaybuddy-src/deploy/site` → `https://buddy.pev-point.de/info/` (nicht im Git; ein Update lässt sie unberührt) |

Nicht verwechseln:

- `~/DisplayBuddy` (groß geschrieben) ist **nur ein Ordner mit Anleitungen und dem Installer** – ohne Git, ohne
  `.env`. Dort nichts starten.
- `/root/DisplayBuddy` gibt es nicht.
- Meldet Docker `required variable BUDDY_DOMAIN is missing`, bist du im falschen Ordner.

## Ablauf

**1. Anmelden und in den Arbeitsordner wechseln**

```sh
cd ~/displaybuddy-src/deploy
```

**2. Prüfen, was neu kommt**

```sh
git fetch
git status -sb                      # Branch claude/display-buddy-v3-c9w0c8, keine eigenen Änderungen
git log --oneline HEAD..@{u}        # die neuen Änderungen
```

**3. Jetzigen Stand merken** (für den Weg zurück)

```sh
git rev-parse HEAD > ~/displaybuddy-vor-update.txt
```

**4. Neuen Stand holen und bauen** – der Server läuft dabei weiter (5–15 Minuten)

```sh
git pull
docker compose build
```

**5. Sichern und umschalten** – der Server steht dabei etwa eine Minute

```sh
docker compose stop buddy
docker compose run --rm --no-deps buddy sh -c 'mkdir -p /data/vor-update && cp -a /data/buddy.db* /data/vor-update/'
docker compose up -d
docker image prune -f
```

Beim ersten Start ergänzt der Server die Datenbank selbst (Migration); vorhandene Daten bleiben erhalten.

**6. Prüfen**

```sh
docker compose ps                                   # buddy = healthy
curl -fsS https://buddy.pev-point.de/api/v1/info    # Version, "registration":"open", legal-URLs gefüllt
curl -fsSI https://buddy.pev-point.de/info/impressum.html | head -1   # HTTP 200
docker compose logs --tail 50 buddy                 # keine Fehler
docker compose exec buddy buddy-server user list    # die Konten sind da
```

Zum Schluss eine Testnotiz zwischen PC und Handy synchronisieren.

**Nur beim Sprung von 0.3 auf 0.4:** Konten aus der Zeit davor haben noch keinen Wiederherstellungscode
(`user list`, Spalte `recovery` = `no`). Nachholen mit:

```sh
docker compose exec buddy buddy-server user recovery <Benutzername>
```

## Registrierung und Anmeldung einstellen

Die Anmeldung geht immer. Ob sich neue Leute selbst ein Konto anlegen dürfen, steht in der `.env`
(Stand 2026-11-11: `open`):

```sh
cd ~/displaybuddy-src/deploy
nano .env                 # Strg+O, Enter, Strg+X zum Speichern und Beenden
docker compose up -d      # übernimmt die Änderung (wenige Sekunden)
curl -fsS https://buddy.pev-point.de/api/v1/info
```

| Zeile in der `.env` | Bedeutung |
|---|---|
| keine Zeile oder `BUDDY_REGISTRATION=closed` | niemand kann sich selbst registrieren (Konten nur mit `user add`) |
| `BUDDY_REGISTRATION=invite` | nur mit Einladungscode |
| `BUDDY_REGISTRATION=open` | jeder – vorher Checkliste `docs/OPERATIONS.md` §4 (Impressum, Datenschutz) |

Einladungscode erzeugen (bei `invite`):

```sh
docker compose exec buddy buddy-server invite create --expires 7d --label "für Anna"
```

Registrieren und anmelden geht in der **Display-Buddy-App 0.4 am PC**: Einstellungen → „Konto & Handy“ →
„Konto anlegen“. Das Handy kommt danach per QR-Code dazu.

## Wenn etwas schiefgeht: zurück auf den alten Stand

Konten und Einstellungen, die erst nach dem Update entstanden sind, gehen dabei verloren.

```sh
cd ~/displaybuddy-src/deploy
docker compose stop buddy
docker compose run --rm --no-deps buddy sh -c 'rm -f /data/buddy.db-wal /data/buddy.db-shm && cp -a /data/vor-update/. /data/'
git checkout "$(cat ~/displaybuddy-vor-update.txt)"
docker compose up -d --build
```

Danach wieder auf den Branch: `git checkout claude/display-buddy-v3-c9w0c8`.

## Apps

Die Web-App auf dem Handy meldet das Update beim nächsten Öffnen selbst („Aktualisieren“ antippen). PC- und
Android-App brauchen nur dann ein Update, wenn eine neue App-Version erscheint.
