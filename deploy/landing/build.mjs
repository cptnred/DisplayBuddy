// Füllt die [[FELD]]-Platzhalter der Seiten mit den Angaben aus kontakt.txt und schreibt fertige Seiten nach dist/.
// Aufruf: node deploy/landing/build.mjs [pfad/zu/kontakt.txt]
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));
const out = join(dir, "dist");
const kontakt = process.argv[2] ?? join(dir, "kontakt.txt");

let text;
try {
  text = readFileSync(kontakt, "utf8");
} catch {
  console.error(`Datei fehlt: ${kontakt}\nkontakt.beispiel.txt kopieren, "kontakt.txt" nennen und ausfüllen.`);
  process.exit(1);
}

const values = {};
for (const line of text.split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/); // Kommentare (#) und Leerzeilen passen nicht
  if (m && !/^[-.\s]*$/.test(m[2])) values[m[1]] = m[2]; // "----" zählt als leer
}
values.STAND_DATUM ||= new Date().toLocaleDateString("de-DE");

const escape = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const missing = new Set();
const pages = {};
for (const f of readdirSync(dir).filter((n) => n.endsWith(".html"))) {
  pages[f] = readFileSync(join(dir, f), "utf8")
    .replace(/<!--[\s\S]*?-->/g, "") // Vorlagen-Hinweise nicht veröffentlichen
    .replace(/\[\[([A-Z_]+)\]\]/g, (_, key) => {
      if (!values[key]) missing.add(key);
      return escape(values[key] ?? "");
    });
}

if (missing.size) {
  console.error(`Diese Felder fehlen oder sind leer in ${kontakt}:\n  ${[...missing].join("\n  ")}`);
  process.exit(1);
}

mkdirSync(out, { recursive: true });
for (const [f, html] of Object.entries(pages)) writeFileSync(join(out, f), html);
copyFileSync(join(dir, "style.css"), join(out, "style.css"));
console.log(`Fertig: ${Object.keys(pages).length} Seiten in ${out}`);
