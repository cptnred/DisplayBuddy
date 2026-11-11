#!/usr/bin/env node
/**
 * Android emulator test of the native shell (PLAN_V3_SYNC §13, scenarios 28 and 29; PLAN_V4 §13
 * scenarios 6 and 29: sign-in with a pairing code, background sync after that sign-in).
 * Runs in GitHub Actions (mobile-android.yml, job "emulator") – not in the cloud sandbox.
 *
 * Needs: a running buddy-server on the runner (port 8080, user from E2E_USER/E2E_PASSWORD),
 * a booted emulator (adb), and a DEBUG apk built with BUDDY_PUBLIC_URL=http://10.0.2.2:8080
 * (debug builds enable WebView remote debugging, used here via the Chrome DevTools
 * protocol with Node's built-in WebSocket – no extra dependencies).
 *
 * Flow:
 *  1. install, grant POST_NOTIFICATIONS, start; a "PC" (API client, kind desktop) creates a
 *     pairing code (POST /pairing) and the app signs in with „Code eingeben“ (the camera
 *     scanner cannot run in the emulator; the scan path is covered by Vitest with a mocked
 *     plugin). „QR-Code scannen“ must be offered;
 *  2. the PC creates a note + reminder → the app syncs → the
 *     plugin's pending() holds exactly that instant;
 *  3. scenario 29: the PC moves the reminder → after the app's sync only the new instant is
 *     pending (old plan cancelled);
 *  4. scenario 28: flight mode, app process killed → the notification is posted on time;
 *  5. "Erledigt" in the notification while offline → after reconnecting the server has
 *     state "done";
 *  6. background sync: app process killed (online), the PC sets the reminder again → the
 *     3-minute tick (BackgroundSync.kt) plans it without the app and it rings on time.
 * Usage: node mobile/e2e/emulator.mjs <app-debug.apk>
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const APK = process.argv[2];
const PKG = "de.displaybuddy.mobile";
const API = process.env.E2E_API ?? "http://127.0.0.1:8080/api/v1";
const USER = process.env.E2E_USER ?? "ci";
const PASSWORD = process.env.E2E_PASSWORD ?? "";
const TITLE = "CI-Erinnerung";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function adb(...args) {
  // logcat dumps can be large (2 MB buffer): allow 64 MB of output
  return execFileSync("adb", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
}
function log(msg) {
  console.log(`[e2e ${new Date().toISOString()}] ${msg}`);
}
async function until(what, fn, timeoutMs, stepMs = 2000) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await sleep(stepMs);
  }
  throw new Error(`timeout: ${what}${last ? ` (${last.message})` : ""}`);
}

// ---- server ("PC" device) -----------------------------------------------------------

async function api(method, path, body, token) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}`);
  return text ? JSON.parse(text) : null;
}

const iso = (ms) => new Date(ms).toISOString();

async function pcPushReminder(pc, noteId, atMs, stampMs) {
  const reminder = {
    noteId,
    at: iso(atMs),
    timeZone: "Europe/Berlin",
    repeat: "none",
    state: "scheduled",
    firedAt: null,
    updatedAt: iso(stampMs),
  };
  const res = await api(
    "POST",
    "/sync/push",
    {
      notes: [],
      reminders: [{ noteId, updatedAt: iso(stampMs), updatedBy: pc.deviceId, deleted: false, reminder }],
      order: null,
    },
    pc.token,
  );
  if (res.results?.[0]?.status !== "applied") throw new Error("reminder push not applied");
}

async function serverReminder(pc, noteId) {
  let since = 0;
  let found = null;
  for (let i = 0; i < 50; i++) {
    const page = await api("GET", `/sync/changes?since=${since}&limit=500`, undefined, pc.token);
    for (const r of page.reminders) if (r.noteId === noteId) found = r;
    since = page.cursor;
    if (!page.hasMore) break;
  }
  return found;
}

// ---- app (WebView over the DevTools protocol) -------------------------------------

/** Last WebView connection (for failure diagnostics). */
let lastApp = null;

async function connectWebView() {
  const sock = await until(
    "webview devtools socket",
    () => {
      const unix = adb("shell", "cat", "/proc/net/unix");
      const m = unix.match(/@(webview_devtools_remote_\d+)/);
      return m?.[1];
    },
    60_000,
  );
  adb("forward", "--remove-all");
  adb("forward", "tcp:9222", `localabstract:${sock}`);
  const pages = await until(
    "devtools page list",
    async () => {
      const list = await (await fetch("http://127.0.0.1:9222/json")).json();
      return list.find((p) => p.type === "page" && p.webSocketDebuggerUrl) ? list : null;
    },
    30_000,
  );
  const page = pages.find((p) => p.type === "page");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error("devtools websocket failed"));
  });
  let id = 0;
  const waiting = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString());
    if (msg.id && waiting.has(msg.id)) {
      waiting.get(msg.id)(msg);
      waiting.delete(msg.id);
    }
  };
  const evaluate = (expression) =>
    new Promise((resolve, reject) => {
      const n = ++id;
      waiting.set(n, (msg) => {
        if (msg.error) reject(new Error(msg.error.message));
        else if (msg.result.exceptionDetails) reject(new Error(msg.result.exceptionDetails.text));
        else resolve(msg.result.result.value);
      });
      ws.send(JSON.stringify({ id: n, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
    });
  lastApp = { evaluate, close: () => ws.close() };
  return lastApp;
}

const CLICK_JS = (label) => `(() => {
  const b = document.querySelector('button[aria-label=${JSON.stringify(label)}]');
  if (!b) return false;
  b.click();
  return true;
})()`;

/** Fills the inputs (by aria-label) of the open login form and submits it. */
const FILL_JS = (fields, submit) => `(() => {
  const set = (label, v) => {
    const el = document.querySelector('input[aria-label="' + label + '"]');
    if (!el) return false;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  };
  const fields = ${JSON.stringify(fields)};
  if (!Object.entries(fields).every(([label, v]) => set(label, v))) return false;
  set("Gerätename", "CI-Emulator");
  document.querySelector('button[type="submit"][aria-label=${JSON.stringify(submit)}]').click();
  return true;
})()`;

const PENDING_JS = `window.__TAURI_INTERNALS__.invoke("plugin:notification|get_pending").then((l) =>
  l.map((n) => ({ id: n.id, title: n.title, at: n.schedule && n.schedule.at ? n.schedule.at.date : null })))`;

async function pendingAt(app) {
  const list = await app.evaluate(PENDING_JS);
  return list.filter((n) => n.title === TITLE).map((n) => Date.parse(n.at));
}

function bringToFront() {
  adb("shell", "monkey", "-p", PKG, "-c", "android.intent.category.LAUNCHER", "1");
}

/** Background + foreground → resume event → sync + re-plan in the app. */
async function resume() {
  adb("shell", "input", "keyevent", "KEYCODE_HOME");
  await sleep(1500);
  bringToFront();
}

function notificationPosted() {
  const dump = adb("shell", "dumpsys", "notification", "--noredact");
  return dump.split("NotificationRecord").some((block) => block.includes(`pkg=${PKG}`) && block.includes(TITLE));
}

async function tapAction(text) {
  adb("shell", "cmd", "statusbar", "expand-notifications");
  await sleep(2000);
  return until(
    `notification button "${text}"`,
    () => {
      adb("shell", "uiautomator", "dump", "/sdcard/ui.xml");
      const xml = adb("shell", "cat", "/sdcard/ui.xml");
      const re = new RegExp(`text="${text}"[^>]*bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"`, "i");
      const m = xml.match(re);
      if (!m) return null;
      const [x1, y1, x2, y2] = m.slice(1).map(Number);
      adb("shell", "input", "tap", String(Math.round((x1 + x2) / 2)), String(Math.round((y1 + y2) / 2)));
      return true;
    },
    20_000,
  );
}

// ---- run ------------------------------------------------------------------------

async function main() {
  if (!APK || !PASSWORD) throw new Error("usage: E2E_PASSWORD=… node mobile/e2e/emulator.mjs <apk>");
  log("install");
  adb("install", "-r", "-g", APK);
  adb("shell", "pm", "grant", PKG, "android.permission.POST_NOTIFICATIONS");
  adb("shell", "cmd", "connectivity", "airplane-mode", "disable");
  bringToFront();

  const login = await api("POST", "/devices", { username: USER, password: PASSWORD, deviceName: "CI-PC", kind: "desktop" });
  const pc = { deviceId: login.deviceId, token: login.token };

  let app = await connectWebView();
  await until("login page", () => app.evaluate(`!!document.querySelector('button[aria-label="Code eingeben"]')`), 60_000);
  if (!(await app.evaluate(`!!document.querySelector('button[aria-label="QR-Code scannen"]')`))) {
    throw new Error("„QR-Code scannen“ is missing in the Android app");
  }
  // the code only travels from the PC to the WebView, never into the log
  const pairing = await api("POST", "/pairing", {}, pc.token).catch((e) => {
    if (/→ 404$/.test(e.message)) return null;
    throw e;
  });
  if (pairing) {
    const formatted = `${pairing.code.slice(0, 4)}-${pairing.code.slice(4, 8)}-${pairing.code.slice(8)}`;
    await app.evaluate(CLICK_JS("Code eingeben"));
    await until("code form", () => app.evaluate(FILL_JS({ Anmeldecode: formatted }, "Mit Code anmelden")), 30_000);
    await until("signed in", () => app.evaluate(`!location.pathname.startsWith("/login")`), 60_000);
    const status = await api("GET", `/pairing/${pairing.pairingId}`, undefined, pc.token);
    if (status.state !== "redeemed") throw new Error(`pairing state ${status.state}`);
    log("signed in with „Code eingeben“, PC sees the pairing as redeemed ✓");
  } else {
    // server without the pairing endpoints (PLAN_V4 phase P not integrated yet)
    console.log("::warning::server has no POST /pairing – password login instead of „Code eingeben“");
    await app.evaluate(CLICK_JS("Mit Passwort anmelden"));
    await until(
      "password form",
      () => app.evaluate(FILL_JS({ Benutzername: USER, Passwort: PASSWORD }, "Anmelden")),
      30_000,
    );
    await until("signed in", () => app.evaluate(`!location.pathname.startsWith("/login")`), 60_000);
    log("signed in with the password");
  }
  const noteId = randomUUID();
  const t = Date.now();
  await api(
    "POST",
    "/sync/push",
    {
      notes: [
        {
          id: noteId,
          updatedAt: iso(t),
          updatedBy: pc.deviceId,
          deleted: false,
          note: {
            id: noteId,
            title: TITLE,
            color: "yellow",
            content: { type: "doc", content: [] },
            createdAt: iso(t),
            updatedAt: iso(t),
            schemaVersion: 1,
          },
        },
      ],
      reminders: [],
      order: null,
    },
    pc.token,
  );
  const at1 = Math.ceil((Date.now() + 10 * 60_000) / 1000) * 1000;
  await pcPushReminder(pc, noteId, at1, Date.now());
  log(`PC set reminder at ${iso(at1)}`);

  await resume();
  app.close();
  app = await connectWebView();
  await until("plan contains the reminder", async () => (await pendingAt(app)).includes(at1), 120_000, 3000);
  log("scheduled locally ✓");

  // scenario 29: the PC moves the reminder → old plan gone, new one set
  const at2 = Math.ceil((Date.now() + 150_000) / 1000) * 1000;
  await pcPushReminder(pc, noteId, at2, Date.now());
  log(`PC moved reminder to ${iso(at2)}`);
  await resume();
  app.close();
  app = await connectWebView();
  await until(
    "plan updated (old cancelled, new set)",
    async () => {
      const p = await pendingAt(app);
      return p.length === 1 && p[0] === at2;
    },
    120_000,
    3000,
  );
  log("scenario 29: plan replaced ✓");
  app.close();

  // scenario 28: offline, app process gone → rings on time
  adb("shell", "cmd", "connectivity", "airplane-mode", "enable");
  adb("shell", "input", "keyevent", "KEYCODE_HOME");
  await sleep(1500);
  adb("shell", "am", "kill", PKG);
  log("flight mode on, app killed; waiting for the alarm");
  while (Date.now() < at2 - 3000) {
    if (notificationPosted()) throw new Error("notification posted too early");
    await sleep(2000);
  }
  await until("notification posted", () => notificationPosted(), 90_000, 1000);
  const late = Date.now() - at2;
  log(`scenario 28: notification posted ${Math.round(late / 1000)} s after the reminder time ✓`);
  if (late > 60_000) throw new Error(`notification too late (${late} ms)`);

  // „Erledigt“ offline → synced after reconnecting
  await tapAction("Erledigt");
  log("tapped „Erledigt“ while offline");
  await sleep(8000);
  app = await connectWebView();
  await until(
    "local reminder done",
    () =>
      app.evaluate(
        `new Promise((res) => { const r = indexedDB.open("display-buddy"); r.onsuccess = () => {
          const tx = r.result.transaction("reminders"); const g = tx.objectStore("reminders").get(${JSON.stringify(noteId)});
          g.onsuccess = () => res(g.result && g.result.reminder ? g.result.reminder.state : null); g.onerror = () => res(null); }; r.onerror = () => res(null); })`,
      ).then((s) => s === "done"),
    60_000,
  );
  const before = await serverReminder(pc, noteId);
  if (before?.reminder?.state === "done") throw new Error("server knew 'done' while the phone was offline");
  adb("shell", "cmd", "connectivity", "airplane-mode", "disable");
  log("flight mode off");
  await until(
    "server has state done",
    async () => (await serverReminder(pc, noteId))?.reminder?.state === "done",
    180_000,
    5000,
  );
  log("offline „Erledigt“ synced ✓");
  app.close();

  // background sync (D-107): app process gone, online → only BackgroundSync can plan the
  // reminder (tick every 3 min); it must ring on time with the note title it learned itself
  await until("old notification dismissed", () => !notificationPosted(), 30_000, 1000);
  adb("shell", "input", "keyevent", "KEYCODE_HOME");
  await sleep(1500);
  adb("shell", "am", "kill", PKG);
  const at3 = Math.ceil((Date.now() + 270_000) / 1000) * 1000; // > one tick interval + sync time
  await pcPushReminder(pc, noteId, at3, Date.now());
  log(`app killed; PC set reminder at ${iso(at3)}; waiting for the background tick to plan it`);
  while (Date.now() < at3 - 3000) {
    if (notificationPosted()) throw new Error("background-planned notification posted too early");
    await sleep(2000);
  }
  await until("background-planned notification posted", () => notificationPosted(), 90_000, 1000);
  const late3 = Date.now() - at3;
  log(`background sync: notification posted ${Math.round(late3 / 1000)} s after the reminder time ✓`);
  if (late3 > 60_000) throw new Error(`background-planned notification too late (${late3} ms)`);
}

main().then(
  () => log("all emulator checks passed"),
  async (e) => {
    console.error(`[e2e] FAILED: ${e.message}`);
    // App state as the WebView sees it (sync status, local reminders, OS plan). No secrets.
    try {
      const app = lastApp ?? (await connectWebView());
      const state = await app.evaluate(`(async () => {
        const status = document.querySelector('[aria-label="Synchronisationsstatus"]')?.textContent ?? null;
        const db = await new Promise((res) => { const r = indexedDB.open("display-buddy"); r.onsuccess = () => res(r.result); r.onerror = () => res(null); });
        const all = (store) => db ? new Promise((res) => { try { const g = db.transaction(store).objectStore(store).getAll(); g.onsuccess = () => res(g.result); g.onerror = () => res("error"); } catch (err) { res(String(err)); } }) : null;
        const reminders = await all("reminders");
        const outbox = await all("outbox");
        const meta = await all("meta");
        return JSON.stringify({ path: location.pathname, status,
          reminders: Array.isArray(reminders) ? reminders.map((r) => ({ noteId: r.noteId, deleted: r.deleted, at: r.reminder && r.reminder.at, state: r.reminder && r.reminder.state })) : reminders,
          outbox: Array.isArray(outbox) ? outbox.length : outbox,
          metaKeys: Array.isArray(meta) ? meta.map((m) => m && (m.key ?? Object.keys(m)[0])) : meta });
      })()`);
      console.error(`[e2e] app state: ${state}`);
      console.error(`[e2e] pending: ${JSON.stringify(await app.evaluate(PENDING_JS))}`);
    } catch (err) {
      console.error(`[e2e] app state unavailable: ${err.message}`);
    }
    try {
      const alarms = adb("shell", "dumpsys", "alarm").split("\n").filter((l) => /displaybuddy/.test(l));
      console.error(`[e2e] alarms of the app: ${alarms.length}\n${alarms.slice(0, 20).join("\n")}`);
    } catch (err) {
      console.error(`[e2e] dumpsys alarm failed: ${err.message}`);
    }
    // Diagnostics: is the app alive, and what did it (and Android) log? Never contains
    // secrets: the app logs no tokens or note contents (PLAN §7.5).
    try {
      console.error(`[e2e] app pid: ${adb("shell", "pidof", "de.displaybuddy.mobile").trim() || "(not running)"}`);
    } catch {
      console.error("[e2e] app pid: (not running)");
    }
    try {
      const pid = adb("shell", "pidof", "de.displaybuddy.mobile").trim();
      if (pid) {
        console.error(`[e2e] --- logcat of the app process (${pid}) ---`);
        console.error(adb("logcat", "-d", "-v", "brief", `--pid=${pid}`).split("\n").slice(-300).join("\n"));
      }
    } catch (err) {
      console.error(`[e2e] app logcat failed: ${err.message}`);
    }
    try {
      console.error("[e2e] --- relevant system logcat ---");
      const all = adb("logcat", "-d", "-v", "brief").split("\n");
      const relevant = all.filter((l) =>
        /buddy|tauri|Console|chromium|AndroidRuntime|FATAL|Firebase|Notification|AlarmManager|de\.displaybuddy/i.test(l),
      );
      console.error(relevant.slice(-250).join("\n"));
    } catch (err) {
      console.error(`[e2e] logcat failed: ${err.message}`);
    }
    process.exit(1);
  },
);
