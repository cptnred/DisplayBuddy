# Landingpage, Impressum, Datenschutz (Vorlagen)

Statische Seiten ohne Build, ohne Skripte, ohne externe Schriften: `index.html` (Platzhalter-Startseite),
`impressum.html`, `datenschutz.html`, `style.css`. Die Links untereinander sind relativ; der Ordner funktioniert
unter jedem Pfad.

## 1. Kontaktangaben eintragen und Seiten bauen

Alle Angaben stehen in **einer** Datei:

1. `kontakt.beispiel.txt` kopieren und die Kopie `kontakt.txt` nennen (gleicher Ordner).
2. Hinter jedes `=` den Text schreiben (Name, Anschrift, E-Mail, Telefon, Hosting, Grundlage für Push-Dienste in
   den USA, Log-Frist – die Datei erklärt jedes Feld).
3. Im Projektordner ausführen:

   ```sh
   node deploy/landing/build.mjs
   ```

Das Skript setzt die Angaben in `impressum.html` und `datenschutz.html` ein (`[[FELD]]`-Platzhalter), setzt das
Datum „Stand“ auf heute und schreibt die fertigen Seiten nach `deploy/landing/dist/`. Fehlt ein Feld, nennt es
das Feld und schreibt nichts. Die Seiten brauchen kein JavaScript. `kontakt.txt` steht in `.gitignore`: keine
Privatdaten ins Git. Nach jeder Änderung an der Datei das Skript neu ausführen und `dist/` neu hochladen.

## 2. Veröffentlichen unter https://buddy.pev-point.de/info/

buddy-server liefert die Seiten selbst aus (`deploy/compose.site.yaml` bindet den Ordner `deploy/site/` als
`/info/` ein; die Web-App lässt `/info/` in Ruhe).

Einmalig auf dem Server: Ordner anlegen (sonst legt Docker ihn root-eigen an und `martin` kann nicht hochladen),
in `~/displaybuddy-src/deploy/.env` die Zeile `COMPOSE_FILE=compose.npm.yaml:compose.site.yaml` setzen, neu starten:

```sh
mkdir -p ~/displaybuddy-src/deploy/site
cd ~/displaybuddy-src/deploy && nano .env && docker compose up -d
```

Seiten hochladen (vom PC aus, im Projektordner; danach ist kein Neustart nötig):

```sh
scp deploy/landing/dist/* martin@<server>:displaybuddy-src/deploy/site/
```

Adressen: `https://buddy.pev-point.de/info/` (Startseite), `…/info/impressum.html`, `…/info/datenschutz.html`.

## 3. Registrierung öffnen

Erst wenn die Seiten online sind. In `deploy/.env` (Server nur mit `https://`-Adressen, sonst startet er nicht):

```ini
BUDDY_REGISTRATION=open
BUDDY_IMPRINT_URL=https://buddy.pev-point.de/info/impressum.html
BUDDY_PRIVACY_URL=https://buddy.pev-point.de/info/datenschutz.html
BUDDY_OPERATOR_NAME=pev-point.de
BUDDY_QUOTA_BYTES=52428800
BUDDY_QUOTA_NOTES=5000
BUDDY_QUOTA_DEVICES=10
```

Dann `docker compose up -d` und `curl -fsS https://buddy.pev-point.de/api/v1/info`: `"registration":"open"`
und die `legal`-URLs gefüllt.

## 4. Muss stimmen, bevor die Erklärung online geht

Die Datenschutzerklärung nennt Fristen und Zusagen. Sie müssen auf dem Server wirklich gelten
(`docs/OPERATIONS.md` §4, Checkliste):

- Log-Frist `LOG_AUFBEWAHRUNG` in `kontakt.txt`: 7 Tage nur mit §7 (Skript und cron), sonst 11 Wochen
- tägliche Sicherung, 14 Tage (läuft in `buddy-server`); eine Außer-Haus-Sicherung (§5) steht **nicht** in der
  Erklärung – bei Einrichtung dort ergänzen
- AV-Vertrag mit dem Hosting-Anbieter, Verzeichnis der Verarbeitungstätigkeiten (§4.3, §4.4)
- Kein Rechtsrat: Texte vom Betreiber prüfen lassen
