#!/usr/bin/env node
/**
 * Display Buddy v3 – end-to-end check (PLAN_V3_SYNC §13, phase F).
 *
 * Starts the real buddy-server (temp DB, own VAPID key) serving the built PWA (dist-web/),
 * drives the PWA in Chromium (Playwright, timezoneId America/New_York) and plays a second
 * device ("PC", kind desktop, Bearer token) over the same HTTP API the desktop client uses,
 * stamping like the desktop (Europe/Berlin reminders, UTC stamps).
 *
 * Usage:  npm run build:web && (cd server && cargo build --release) && node e2e/v3-e2e.mjs
 * Env:    BUDDY_SERVER_BIN (default server/target/release/buddy-server), E2E_PORT (default 18080),
 *         E2E_SHOTS=dir to save screenshots.
 * Exit code 0 = all scenarios passed. Prints one line per scenario.
 */
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = process.env.BUDDY_SERVER_BIN ?? join(ROOT, "server/target/release/buddy-server");
const PORT = Number(process.env.E2E_PORT ?? 18080);
const ORIGIN = `http://localhost:${PORT}`;
const API = `${ORIGIN}/api/v1`;
const USER = "e2e-user";
const PASSWORD = "correct horse battery staple";
const SHOTS = process.env.E2E_SHOTS;

const results = [];
function record(id, name, ok, detail = "") {
  results.push({ id, name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  #${id} ${name}${detail ? ` – ${detail}` : ""}`);
}
async function scenario(id, name, fn) {
  try {
    const detail = await fn();
    record(id, name, true, detail ?? "");
  } catch (e) {
    record(id, name, false, e instanceof Error ? e.message : String(e));
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15_000, what = "condition") {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await sleep(250);
  }
  throw new Error(`timeout waiting for ${what}${last ? ` (${last.message})` : ""}`);
}

// ---- server -----------------------------------------------------------------------
const dir = mkdtempSync(join(tmpdir(), "buddy-e2e-"));
const env = {
  ...process.env,
  BUDDY_LISTEN: `127.0.0.1:${PORT}`,
  BUDDY_PUBLIC_URL: ORIGIN,
  BUDDY_DB: join(dir, "buddy.db"),
  BUDDY_WEB_DIR: join(ROOT, "dist-web"),
  BUDDY_VAPID_PRIVATE_KEY_FILE: join(dir, "vapid.pem"),
  BUDDY_VAPID_SUBJECT: "mailto:e2e@example.invalid",
  RUST_LOG: "info",
};
function cli(args, input) {
  const r = spawnSync(BIN, args, { env, input, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`buddy-server ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}
cli(["vapid", "generate", "--out", env.BUDDY_VAPID_PRIVATE_KEY_FILE]);
cli(["user", "add", USER], `${PASSWORD}\n${PASSWORD}\n`);
const server = spawn(BIN, ["serve"], { env, stdio: ["ignore", "pipe", "pipe"] });
let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));
await until(async () => (await fetch(`${API}/health`)).ok, 15_000, "server health");

// ---- the "PC" device (desktop protocol over HTTP, Bearer) --------------------------
const iso = (ms = Date.now()) => new Date(ms).toISOString();
async function api(method, path, { token, body, headers = {} } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
}
const login = await api("POST", "/devices", {
  body: { username: USER, password: PASSWORD, deviceName: "E2E-PC", kind: "desktop" },
});
assert(login.status === 200 || login.status === 201, `PC login failed: ${login.status}`);
const pc = { token: login.body.token, id: login.body.deviceId, cursor: 0 };
const doc = (text) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
function noteRecord(note, deleted = false) {
  const at = iso();
  return { id: note.id, updatedAt: at, updatedBy: pc.id, deleted, note: deleted ? null : { ...note, updatedAt: at } };
}
async function pcPush(payload) {
  const r = await api("POST", "/sync/push", { token: pc.token, body: { notes: [], reminders: [], ...payload } });
  assert(r.status === 200, `push ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}
async function pcPull() {
  const all = { notes: [], reminders: [], order: null };
  for (;;) {
    const r = await api("GET", `/sync/changes?since=${pc.cursor}&limit=200`, { token: pc.token });
    assert(r.status === 200, `pull ${r.status}`);
    all.notes.push(...r.body.notes);
    all.reminders.push(...r.body.reminders);
    all.order = r.body.order ?? all.order;
    pc.cursor = r.body.cursor;
    if (!r.body.hasMore) return all;
  }
}

// ---- the PWA (Chromium, New York) ----------------------------------------------------
const browser = await chromium.launch({ channel: "chromium" });
const context = await browser.newContext({ timezoneId: "America/New_York", locale: "de-DE", serviceWorkers: "allow" });
const page = await context.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));
const shot = async (name) => {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });
};
async function pwaSync(p = page) {
  await p.goto(`${ORIGIN}/`);
  const btn = p.getByRole("button", { name: "Jetzt synchronisieren" });
  if (await btn.count()) await btn.first().click();
  await sleep(1500);
}

const NOTE1 = { id: randomUUID(), title: "Einkauf vom PC", color: "yellow", content: doc("Milch und Brot"), createdAt: iso(), updatedAt: iso(), schemaVersion: 1 };

try {
  await scenario(13, "Installierbarkeit: Manifest, Service Worker, Cache-Header", async () => {
    const man = await fetch(`${ORIGIN}/manifest.webmanifest`);
    assert(man.headers.get("content-type")?.startsWith("application/manifest+json"), "manifest MIME");
    const m = await man.json();
    assert(m.name && m.short_name && m.start_url && m.display === "standalone", "manifest fields");
    const sizes = m.icons.map((i) => i.sizes);
    assert(sizes.includes("192x192") && sizes.includes("512x512"), "icons 192/512");
    for (const p of ["/", "/sw.js", "/manifest.webmanifest"]) {
      const cc = (await fetch(`${ORIGIN}${p}`)).headers.get("cache-control") ?? "";
      assert(cc.includes("no-cache"), `${p} cache-control ${cc}`);
    }
    await page.goto(`${ORIGIN}/`);
    await until(() => page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration())?.active), 20_000, "SW active");
    return `Icons ${sizes.join(", ")}`;
  });

  await scenario(0, "PWA-Login (Cookie-Session) und Einrichtung", async () => {
    await page.goto(`${ORIGIN}/login`);
    await page.getByLabel("Benutzername").fill(USER);
    await page.getByLabel("Passwort").fill(PASSWORD);
    const name = page.getByLabel("Gerätename");
    if (await name.count()) await name.fill("E2E-Handy");
    await page.getByRole("button", { name: "Anmelden" }).click();
    await until(() => !page.url().endsWith("/login"), 15_000, "leave /login");
    const done = page.getByRole("button", { name: "Einrichtung abschließen" });
    if (await done.count()) await done.click();
    const cookies = await context.cookies();
    const c = cookies.find((x) => x.name === "__Host-buddy_session");
    assert(c && c.httpOnly && c.secure && c.sameSite === "Strict" && c.path === "/", "cookie attributes");
    await shot("00-after-login");
    return "Cookie __Host- HttpOnly Secure SameSite=Strict";
  });

  await scenario(1, "Notiz am PC anlegen → in der PWA sichtbar", async () => {
    const r = await pcPush({ notes: [noteRecord(NOTE1)] });
    assert(r.results[0].status === "applied", "push applied");
    await pwaSync();
    await until(() => page.getByText("Einkauf vom PC").count(), 15_000, "note in PWA list");
    await shot("01-note-from-pc");
  });

  await scenario(2, "Notiz in der PWA ändern → PC erhält neuen Inhalt", async () => {
    await pcPull();
    await page.getByText("Einkauf vom PC").first().click();
    const title = page.getByLabel("Titel der Notiz");
    await title.fill("Einkauf (am Handy geändert)");
    await sleep(1200); // autosave 500 ms + debounce
    await page.getByRole("link", { name: "Zurück zur Übersicht" }).click();
    await pwaSync();
    const got = await until(async () => {
      const ch = await pcPull();
      return ch.notes.find((n) => n.id === NOTE1.id && n.note?.title === "Einkauf (am Handy geändert)");
    }, 15_000, "changed note at PC");
    assert(got.updatedBy !== pc.id, "stamped by the phone");
    return `updatedBy=${got.updatedBy.slice(0, 8)}…, updatedAt=${got.updatedAt}`;
  });

  await scenario(24, "Zeitzonen: PC (Berlin) „täglich 09:00“ → PWA (New York) zeigt 03:00 (09:00 Berlin)", async () => {
    // next 09:00 Berlin = 08:00Z in winter (November)
    const now = new Date();
    const at = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 8, 0, 0));
    const stamp = iso();
    const reminder = { noteId: NOTE1.id, at: at.toISOString(), repeat: "daily", state: "scheduled", firedAt: null, updatedAt: stamp, timeZone: "Europe/Berlin" };
    const r = await pcPush({ reminders: [{ noteId: NOTE1.id, updatedAt: stamp, updatedBy: pc.id, deleted: false, reminder }] });
    assert(r.results[0].status === "applied", `reminder push ${JSON.stringify(r.results[0])}`);
    await pwaSync();
    await page.getByText(/Einkauf/).first().click();
    await until(() => page.getByText(/03:00/).count(), 10_000, "03:00 shown");
    await until(() => page.getByText(/09:00 Berlin/).count(), 10_000, "(09:00 Berlin) shown");
    await shot("24-zones");
    return "03:00 und „09:00 Berlin“ angezeigt";
  });

  await scenario(4, "Am PC löschen → verschwindet in der PWA; spätere Bearbeitung bringt sie zurück", async () => {
    const tmp = { id: randomUUID(), title: "Wird gelöscht", color: "pink", content: doc("x"), createdAt: iso(), updatedAt: iso(), schemaVersion: 1 };
    await pcPush({ notes: [noteRecord(tmp)] });
    await pwaSync();
    await until(() => page.getByText("Wird gelöscht").count(), 10_000, "tmp visible");
    await sleep(5);
    await pcPush({ notes: [noteRecord(tmp, true)] });
    await pwaSync();
    await until(async () => (await page.getByText("Wird gelöscht").count()) === 0, 10_000, "tmp gone");
    await sleep(5);
    await pcPush({ notes: [noteRecord({ ...tmp, title: "Wieder da" })] });
    await pwaSync();
    await until(() => page.getByText("Wieder da").count(), 10_000, "tmp back");
  });

  await scenario(14, "Offline-Start: online geladen, offline neu laden → App und Notizen da", async () => {
    await context.setOffline(true);
    await page.reload();
    await until(() => page.getByText("Wieder da").count(), 15_000, "note offline");
    await shot("14-offline");
    await context.setOffline(false);
  });

  await scenario(15, "Offline bearbeiten → online automatisch synchronisiert", async () => {
    await context.setOffline(true);
    await page.goto(`${ORIGIN}/new`).catch(() => {});
    await page.reload().catch(() => {});
    await until(() => page.getByLabel("Titel der Notiz").count(), 15_000, "editor offline");
    await page.getByLabel("Titel der Notiz").fill("Offline geschrieben");
    await sleep(1200);
    await page.getByRole("link", { name: "Zurück zur Übersicht" }).click();
    await until(() => page.getByText("Offline geschrieben").count(), 5_000, "offline note listed");
    await context.setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    const got = await until(async () => {
      const ch = await pcPull();
      return ch.notes.find((n) => n.note?.title === "Offline geschrieben");
    }, 30_000, "offline note on server");
    return `angekommen (updatedAt ${got.updatedAt})`;
  });

  await scenario(3, "Konflikt: neuere Fassung gewinnt, ältere in note_revisions", async () => {
    const id = NOTE1.id;
    const old = new Date(Date.now() - 3600_000).toISOString();
    const r = await pcPush({ notes: [{ id, updatedAt: old, updatedBy: pc.id, deleted: false, note: { ...NOTE1, title: "Alte PC-Fassung", updatedAt: old } }] });
    assert(r.results[0].status === "stale", `expected stale, got ${r.results[0].status}`);
    const rev = cli(["revisions", "--note", id]);
    assert(/rejected/.test(rev), "rejected revision listed");
    return "PC-Fassung (älter) → stale + Revision „rejected“";
  });

  await scenario(19, "Zwei Tabs: beide sehen die Änderung", async () => {
    const tab2 = await context.newPage();
    await tab2.goto(`${ORIGIN}/`);
    const n = { id: randomUUID(), title: "Für beide Tabs", color: "blue", content: doc("y"), createdAt: iso(), updatedAt: iso(), schemaVersion: 1 };
    await pcPush({ notes: [noteRecord(n)] });
    await pwaSync(page);
    await until(() => page.getByText("Für beide Tabs").count(), 15_000, "tab1 synced the change");
    await until(() => tab2.getByText("Für beide Tabs").count(), 15_000, "tab2 sees change (BroadcastChannel)");
    await tab2.close();
  });

  await scenario(9, "Widerrufenes Gerät → 401, keine Daten verloren", async () => {
    const r1 = await api("DELETE", "/devices/current", { token: pc.token });
    assert(r1.status === 204, `revoke ${r1.status}`);
    const r2 = await api("GET", "/sync/changes?since=0", { token: pc.token });
    assert(r2.status === 401, `after revoke ${r2.status}`);
    const again = await api("POST", "/devices", { body: { username: USER, password: PASSWORD, deviceName: "E2E-PC", kind: "desktop" } });
    pc.token = again.body.token;
    pc.id = again.body.deviceId;
    pc.cursor = 0;
    const all = await pcPull();
    assert(all.notes.some((n) => n.note?.title === "Offline geschrieben"), "data still there");
    const bad = await api("POST", "/devices", { body: { username: USER, password: "wrong password!!", deviceName: "x", kind: "desktop" } });
    assert(bad.status === 401, `wrong password ${bad.status}`);
  });

  await scenario(12, "Sicherheit: Cross-Site-POST mit Cookie abgelehnt, keine Geheimnisse im Log", async () => {
    const cookies = await context.cookies();
    const c = cookies.find((x) => x.name === "__Host-buddy_session");
    const r = await api("POST", "/sync/push", {
      body: { notes: [], reminders: [] },
      headers: { cookie: `${c.name}=${c.value}`, "sec-fetch-site": "cross-site", origin: "https://evil.example", "x-buddy-request": "1" },
    });
    assert(r.status === 403, `cross-site ${r.status}`);
    for (const secret of [PASSWORD, pc.token, c.value, "Milch und Brot"]) {
      assert(!serverLog.includes(secret), "secret or note content in server log");
    }
    return "403; Log ohne Passwort/Token/Cookie/Inhalt";
  });

  await scenario(0, "Keine Seitenfehler im Browser", async () => {
    assert(pageErrors.length === 0, pageErrors.join(" | "));
  });
} finally {
  await browser.close();
  server.kill("SIGTERM");
  await new Promise((r) => server.once("exit", r));
  rmSync(dir, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
