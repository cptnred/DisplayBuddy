#!/usr/bin/env node
/**
 * Display Buddy v4 – end-to-end acceptance against the real buddy-server process (PLAN_V4 §13,
 * phase F). No extra packages: Node fetch plays the desktop (bearer), the native app (bearer)
 * and the PWA (cookie + CSRF headers) over HTTP; admin steps use the real CLI.
 *
 * The server runs in WSL (it needs OpenSSL, D-111). Different clients are simulated with
 * X-Forwarded-For from a trusted proxy (127.0.0.1), as behind Caddy/NPM.
 *
 * Usage (Windows, Git Bash):
 *   wsl -e bash -lc 'cd /mnt/c/.../server && CARGO_TARGET_DIR=~/buddy-target ~/.cargo/bin/cargo build'
 *   npm run build:web && node e2e/v4-e2e.mjs
 * Env: E2E_BIN (WSL path, default /home/<user>/buddy-target/debug/buddy-server via $HOME),
 *      E2E_PORT (default 18090), E2E_WEB_DIR (WSL path of dist-web).
 * Exit code 0 = all scenarios passed. One line per scenario.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.E2E_PORT ?? 18090);
const ORIGIN = `http://localhost:${PORT}`;
const API = `${ORIGIN}/api/v1`;
const DIR = `/tmp/buddy-e2e-v4-${process.pid}`;
const DB = `${DIR}/buddy.db`;
const BIN = process.env.E2E_BIN ?? "$HOME/buddy-target/debug/buddy-server";
const wslPath = (p) => "/mnt/" + p[0].toLowerCase() + p.slice(2).replace(/\\/g, "/");
const WEB_DIR = process.env.E2E_WEB_DIR ?? wslPath(resolve(ROOT, "dist-web"));
const PW = "correct horse battery staple";

const secrets = new Set([PW]);
const results = [];
/** ok: true = pass, false = fail, null = skipped (never counted as passed). */
function record(id, name, ok, detail = "") {
  results.push({ id, ok });
  console.log(`${ok === null ? "SKIP" : ok ? "PASS" : "FAIL"}  #${id} ${name}${detail ? ` – ${detail}` : ""}`);
}
const SKIP = Symbol("skip");
async function scenario(id, name, fn) {
  try {
    const out = await fn();
    if (out === SKIP) record(id, name, null, "kein Chromium gefunden (E2E_CHROME setzen)");
    else record(id, name, true, out ?? "");
  } catch (e) {
    record(id, name, false, e instanceof Error ? e.message : String(e));
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
function eq(actual, expected, what) {
  assert(actual === expected, `${what}: expected ${expected}, got ${actual}`);
}

// ---- HTTP --------------------------------------------------------------------------------

/** opts: token (bearer), cookie, body, ip (X-Forwarded-For), pwa (same-origin CSRF headers),
 *  site (Sec-Fetch-Site override). */
async function api(method, path, opts = {}) {
  const headers = { Accept: "application/json", "X-Forwarded-For": opts.ip ?? "198.51.100.1" };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.cookie) headers.Cookie = opts.cookie;
  if (opts.pwa) {
    headers["Sec-Fetch-Site"] = opts.site ?? "same-origin";
    headers.Origin = ORIGIN;
    headers["X-Buddy-Request"] = "1";
  }
  const res = await fetch(API + path, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body, headers: res.headers };
}
const errOf = (r) => `${r.status} ${r.body?.error ?? ""}`.trim();

/** PoW check, independent of buddy-core: SHA-256(challenge ‖ nonce_u32_le) has ≥ bits zero bits. */
function meets(challenge, bits, n) {
  const nb = Buffer.alloc(4);
  nb.writeUInt32LE(n);
  const h = createHash("sha256").update(Buffer.from(challenge, "base64url")).update(nb).digest();
  let z = 0;
  for (const b of h) {
    if (b !== 0) return z + Math.clz32(b) - 24 >= bits;
    z += 8;
  }
  return z >= bits;
}

function solve(challenge, bits) {
  for (let n = 0; n < 2 ** 32; n++) if (meets(challenge, bits, n)) return n;
  throw new Error("no nonce");
}

async function challenge(ip) {
  const r = await api("POST", "/accounts/challenge", { body: {}, ip });
  eq(r.status, 200, `challenge ${errOf(r)}`);
  return r.body;
}

async function register(username, password, ip, extra = {}) {
  const c = await challenge(ip);
  const r = await api("POST", "/accounts", {
    ip,
    body: {
      username,
      password,
      deviceName: "Windows-PC",
      timeZone: "Europe/Berlin",
      inviteCode: null,
      challengeId: c.id,
      nonce: solve(c.challenge, c.bits),
      ...extra,
    },
  });
  if (r.status === 200) {
    secrets.add(password).add(r.body.token).add(r.body.recoveryCode);
  }
  return r;
}

async function deviceLogin(username, password, kind = "desktop", ip) {
  const r = await api("POST", "/devices", { ip, body: { username, password, deviceName: `${kind}-x`, kind } });
  if (r.status === 200) secrets.add(r.body.token);
  return r;
}

async function startPairing(token) {
  const r = await api("POST", "/pairing", { token, body: {} });
  eq(r.status, 200, `POST /pairing ${errOf(r)}`);
  const code = r.body.code;
  secrets.add(code).add(`${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8)}`);
  return r.body;
}

async function redeemNative(code, ip, name = "Pixel 8") {
  const r = await api("POST", "/devices/pairing", { ip, body: { code, deviceName: name, kind: "mobile" } });
  if (r.status === 200) secrets.add(r.body.token);
  return r;
}

function noteRecord(id, by, title, at = new Date().toISOString(), extra = "") {
  return {
    id,
    updatedAt: at,
    updatedBy: by,
    deleted: false,
    note: {
      id,
      title,
      color: "yellow",
      content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: `x${extra}` }] }] },
      createdAt: at,
      updatedAt: at,
      schemaVersion: 1,
    },
  };
}

// ---- Chromium over the DevTools protocol (no Playwright needed) -------------------------------

const CHROME =
  process.env.E2E_CHROME ??
  join(process.env.LOCALAPPDATA ?? "", "ms-playwright", "chromium-1243", "chrome-win64", "chrome.exe");

async function withPage(fn) {
  const { existsSync, mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  if (!existsSync(CHROME)) return null;
  const profile = mkdtempSync(`${tmpdir()}/buddy-e2e-chrome-`);
  const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`,
    "--no-first-run", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  let chromeErr = "";
  chrome.stderr.on("data", (d) => (chromeErr += d));
  try {
    let target;
    for (let i = 0; i < 75 && !target; i++) {
      await new Promise((r) => setTimeout(r, 200));
      const port = /DevTools listening on ws:\/\/[^:]+:(\d+)/.exec(chromeErr)?.[1];
      if (!port) continue;
      target = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json()).then((l) =>
        l.find((t) => t.type === "page")).catch(() => undefined);
    }
    assert(target, `chrome did not start: ${chromeErr.slice(-400)}`);
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = fail; });
    let seq = 0;
    const pending = new Map();
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    };
    const send = (method, params = {}) => new Promise((res) => {
      const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async (expression) =>
      (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;
    const until = async (expression, what, ms = 10_000) => {
      for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 150)))
        if (await evaluate(expression)) return;
      throw new Error(`timeout: ${what}`);
    };
    try {
      return await fn({ navigate: (url) => send("Page.navigate", { url }), evaluate, until });
    } finally {
      ws.close();
    }
  } finally {
    const exited = new Promise((r) => chrome.once("exit", r));
    chrome.kill();
    await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    } catch {
      /* temp profile; Windows may still hold a file – not part of the result */
    }
  }
}

// ---- server + CLI (WSL) -------------------------------------------------------------------

function wsl(cmd, input) {
  const r = spawnSync("wsl", ["-e", "bash", "-lc", cmd], { input, encoding: "utf8" });
  return { code: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
}
function admin(args, input) {
  const r = wsl(`BUDDY_DB=${DB} ${BIN} ${args}`, input);
  assert(r.code === 0, `buddy-server ${args}: ${r.out.trim()}`);
  return r.out;
}

async function startServer() {
  wsl(`rm -rf ${DIR} && mkdir -p ${DIR}`);
  const env = [
    `BUDDY_LISTEN=127.0.0.1:${PORT}`,
    `BUDDY_PUBLIC_URL=${ORIGIN}`,
    `BUDDY_DB=${DB}`,
    `BUDDY_WEB_DIR=${WEB_DIR}`,
    "BUDDY_TRUSTED_PROXIES=127.0.0.1",
    "BUDDY_REGISTRATION=open",
    "BUDDY_REGISTRATION_POW_BITS=12",
    "BUDDY_PRIVACY_URL=https://example.org/datenschutz",
    "RUST_LOG=debug",
  ].join(" ");
  const proc = spawn("wsl", ["-e", "bash", "-lc", `exec env ${env} ${BIN} serve > ${DIR}/server.log 2>&1`], {
    stdio: "ignore",
  });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${API}/health`)).ok) return proc;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`server did not start: ${wsl(`cat ${DIR}/server.log`).out}`);
}

// ---- scenarios ----------------------------------------------------------------------------

const proc = await startServer();
const A = {}; // anna: main account
try {
  await scenario(1, "Registrieren (open): Konto + Gerät, Code, Sync läuft", async () => {
    const info = await api("GET", "/info");
    eq(info.body.registration, "open", "/info registration");
    eq(info.body.apiLevel, 2, "apiLevel");
    const r = await register("anna", PW, "198.51.100.1");
    eq(r.status, 200, `register ${errOf(r)}`);
    Object.assign(A, { token: r.body.token, device: r.body.deviceId, recovery: r.body.recoveryCode });
    assert(/^[0-9A-Z]{24}$/.test(A.recovery), "recovery code format");
    const devs = await api("GET", "/me/devices", { token: A.token });
    eq(devs.body.devices[0].createdVia, "register", "createdVia");
    const p = await api("POST", "/sync/push", {
      token: A.token,
      body: { notes: [noteRecord(randomUUID(), A.device, "Einkauf")], reminders: [] },
    });
    eq(p.status, 200, `push ${errOf(p)}`);
    eq(p.body.results[0].status, "applied", "push result");
  });

  await scenario(2, "Registrieren: Name vergeben/ungültig, Passwort kurz/häufig/= Name", async () => {
    const cases = [
      ["Anna", PW, "username_taken"],
      ["a@b", PW, "username_invalid"],
      ["admin", PW, "username_invalid"],
      ["paul", "kurz", "password_weak"],
      ["paul", "unbelievable", "password_weak"],
      ["paulpaulpaul", "PaulPaulPaul", "password_weak"],
    ];
    let i = 10;
    for (const [u, p, code] of cases) {
      const r = await register(u, p, `198.51.100.${i++}`);
      eq(r.body?.error, code, `${u}/${p.length} chars`);
    }
    return `${cases.length} Fälle`;
  });

  await scenario(4, "Registrieren: falsche/wiederverwendete Challenge, 4. Registrierung pro IP", async () => {
    const ip = "198.51.100.40";
    const body = { username: "zoe", password: PW, deviceName: "PC", timeZone: null, inviteCode: null };
    const c1 = await challenge(ip);
    const good1 = solve(c1.challenge, c1.bits);
    const unknown = await api("POST", "/accounts", { ip, body: { ...body, challengeId: randomUUID(), nonce: good1 } });
    eq(unknown.body?.error, "challenge_invalid", "unknown challenge");
    let wrongNonce = 0;
    while (meets(c1.challenge, c1.bits, wrongNonce)) wrongNonce++;
    const wrong = await api("POST", "/accounts", { ip, body: { ...body, challengeId: c1.id, nonce: wrongNonce } });
    eq(wrong.body?.error, "challenge_invalid", "wrong nonce");
    const c2 = await challenge(ip);
    const good = solve(c2.challenge, c2.bits);
    const ok = await api("POST", "/accounts", { ip, body: { ...body, challengeId: c2.id, nonce: good } });
    eq(ok.status, 200, `register with solved nonce ${errOf(ok)}`);
    secrets.add(ok.body.token).add(ok.body.recoveryCode);
    const reuse = await api("POST", "/accounts", { ip, body: { ...body, username: "zoe2", challengeId: c2.id, nonce: good } });
    eq(reuse.body?.error, "challenge_invalid", "reused challenge");
    for (const u of ["zoe3", "zoe4"]) {
      const r = await register(u, PW, ip);
      eq(r.status, 200, `${u} ${errOf(r)}`);
    }
    const fourth = await register("zoe5", PW, ip);
    eq(fourth.status, 429, `4th registration ${errOf(fourth)}`);
    assert(fourth.headers.get("retry-after"), "Retry-After");
  });

  await scenario(5, "Pairing PWA: /session/pairing → Cookie, Sync, PC sieht „redeemed“", async () => {
    const p = await startPairing(A.token);
    assert(p.url === `${ORIGIN}/pair#c=${p.code}`, `url ${p.url}`);
    const r = await api("POST", "/session/pairing", {
      pwa: true,
      ip: "203.0.113.5",
      body: { code: p.code.toLowerCase(), deviceName: "iPhone (Web-App)", deviceId: null },
    });
    eq(r.status, 200, `session pairing ${errOf(r)}`);
    const cookie = r.headers.get("set-cookie")?.split(";")[0];
    assert(cookie?.startsWith("__Host-buddy_session="), "cookie");
    secrets.add(cookie.split("=")[1]);
    const me = await api("GET", "/me", { cookie, pwa: true });
    eq(me.body?.username, "anna", "GET /me with cookie");
    const ch = await api("GET", "/sync/changes?since=0&limit=200", { cookie, pwa: true });
    eq(ch.body.notes.length, 1, "PWA sees the PC note");
    const st = await api("GET", `/pairing/${p.pairingId}`, { token: A.token });
    eq(st.body.state, "redeemed", "PC status");
    eq(st.body.device?.name, "iPhone (Web-App)", "device name on the PC");
  });

  await scenario("5b", "PWA /pair im Browser: Fragment weg, kein Einlösen ohne Klick, dann angemeldet", async () => {
    const p = await startPairing(A.token);
    const done = await withPage(async ({ navigate, evaluate, until }) => {
      await navigate(`${ORIGIN}/pair#c=${p.code}`);
      await until(`[...document.querySelectorAll("button")].some(b => b.textContent.includes("Hier anmelden"))`,
        "button „Hier anmelden“");
      eq(await evaluate("location.hash"), "", "fragment removed");
      assert(await evaluate(`document.body.innerText.includes("${p.code.slice(0, 4)}-")`), "code shown as text");
      await new Promise((r) => setTimeout(r, 1500));
      eq((await api("GET", `/pairing/${p.pairingId}`, { token: A.token })).body.state, "pending", "no redeem without click");
      await evaluate(`[...document.querySelectorAll("button")].find(b => b.textContent.includes("Hier anmelden")).click()`);
      for (let i = 0; i < 50; i++) {
        const st = (await api("GET", `/pairing/${p.pairingId}`, { token: A.token })).body;
        if (st.state === "redeemed") return st.device?.kind;
        await new Promise((r) => setTimeout(r, 200));
      }
      throw new Error("not redeemed after the click");
    });
    if (done === null) return SKIP;
    eq(done, "web", "device kind");
  });

  await scenario(6, "Pairing nativ: /devices/pairing → Token, Sync, PC sieht Gerät", async () => {
    const p = await startPairing(A.token);
    const r = await redeemNative(`${p.code.slice(0, 4)}-${p.code.slice(4, 8)}-${p.code.slice(8)}`, "203.0.113.6");
    eq(r.status, 200, `redeem ${errOf(r)}`);
    eq(r.body.username, "anna", "username");
    assert(r.headers.get("set-cookie") === null, "no cookie for bearer redeem");
    A.phone = r.body.token;
    A.phoneId = r.body.deviceId;
    const ch = await api("GET", "/sync/changes?since=0&limit=200", { token: A.phone });
    eq(ch.status, 200, "phone sync");
    const devs = await api("GET", "/me/devices", { token: A.token });
    const d = devs.body.devices.find((x) => x.id === A.phoneId);
    eq(d?.createdVia, "pairing", "createdVia");
  });

  await scenario(8, "Code zweimal / parallel zweimal: genau ein Gerät", async () => {
    const p = await startPairing(A.token);
    const [x, y] = await Promise.all([redeemNative(p.code, "203.0.113.8"), redeemNative(p.code, "203.0.113.9")]);
    eq([x.status, y.status].sort().join(","), "200,400", "parallel");
    eq([x, y].find((r) => r.status === 400).body.error, "pairing_invalid", "loser code");
    const again = await redeemNative(p.code, "203.0.113.10");
    eq(again.body?.error, "pairing_invalid", "third try");
    // clean up the extra device (younger than the PC → no password)
    const won = [x, y].find((r) => r.status === 200);
    const rv = await api("POST", `/me/devices/${won.body.deviceId}/revoke`, { token: A.token, body: {} });
    eq(rv.status, 204, "revoke extra device");
  });

  await scenario(11, "Cross-Site-POST /session/pairing → 403", async () => {
    const p = await startPairing(A.token);
    const r = await api("POST", "/session/pairing", {
      pwa: true,
      site: "cross-site",
      body: { code: p.code, deviceName: "evil", deviceId: null },
    });
    eq(r.status, 403, `cross-site ${errOf(r)}`);
    const st = await api("GET", `/pairing/${p.pairingId}`, { token: A.token });
    eq(st.body.state, "pending", "code untouched");
    await api("DELETE", `/pairing/${p.pairingId}`, { token: A.token });
  });

  await scenario(12, "11 falsche Codes von einer IP → 429 mit Retry-After", async () => {
    const ip = "203.0.113.12";
    for (let i = 0; i < 10; i++) {
      const r = await redeemNative(`ZZZZ-ZZZZ-ZZ${String(i).padStart(2, "0")}`, ip);
      eq(r.body?.error, "pairing_invalid", `try ${i + 1}`);
    }
    const r = await redeemNative("ZZZZ-ZZZZ-ZZZZ", ip);
    eq(r.status, 429, `11th ${errOf(r)}`);
    assert(Number(r.headers.get("retry-after")) > 0, "Retry-After");
  });

  await scenario(13, "„Das war ich nicht – abmelden“: Handy danach 401", async () => {
    const rv = await api("POST", `/me/devices/${A.phoneId}/revoke`, { token: A.token, body: { password: null } });
    eq(rv.status, 204, `revoke ${errOf(rv)}`);
    eq((await api("GET", "/me", { token: A.phone })).status, 401, "phone after revoke");
  });

  await scenario(14, "Jüngeres Gerät meldet älteres ab: ohne Passwort 403, mit 204", async () => {
    const r = await register("dora", PW, "198.51.100.14");
    eq(r.status, 200, `register ${errOf(r)}`);
    const pc = r.body;
    const p = await startPairing(pc.token);
    const phone = (await redeemNative(p.code, "203.0.113.14")).body;
    const no = await api("POST", `/me/devices/${pc.deviceId}/revoke`, { token: phone.token, body: {} });
    eq(no.body?.error, "password_required", "without password");
    const wrong = await api("POST", `/me/devices/${pc.deviceId}/revoke`, {
      token: phone.token,
      body: { password: "wrong password!!" },
    });
    eq(wrong.status, 403, "wrong password = 403 (not 401)");
    const yes = await api("POST", `/me/devices/${pc.deviceId}/revoke`, { token: phone.token, body: { password: PW } });
    eq(yes.status, 204, `with password ${errOf(yes)}`);
    eq((await api("GET", "/me", { token: pc.token })).status, 401, "old PC signed out");
  });

  await scenario(16, "Wiederherstellung: alle anderen 401, neuer Code, alter ungültig", async () => {
    const r = await register("carla", PW, "198.51.100.16");
    const c = r.body;
    const other = (await deviceLogin("carla", PW, "mobile", "198.51.100.16")).body;
    const NEW = "a brand new passphrase";
    secrets.add(NEW);
    const rec = await api("POST", "/accounts/recover", {
      ip: "198.51.100.17",
      body: { username: "carla", recoveryCode: c.recoveryCode.toLowerCase(), newPassword: NEW, deviceName: "PC" },
    });
    eq(rec.status, 200, `recover ${errOf(rec)}`);
    secrets.add(rec.body.token).add(rec.body.recoveryCode);
    assert(rec.body.recoveryCode !== c.recoveryCode, "new code");
    eq((await api("GET", "/me", { token: c.token })).status, 401, "old PC");
    eq((await api("GET", "/me", { token: other.token })).status, 401, "other device");
    const again = await api("POST", "/accounts/recover", {
      ip: "198.51.100.18",
      body: { username: "carla", recoveryCode: c.recoveryCode, newPassword: "yet another passphrase", deviceName: "PC" },
    });
    eq(again.status, 401, "old code");
    const unknown = await api("POST", "/accounts/recover", {
      ip: "198.51.100.19",
      body: { username: "nobody-here", recoveryCode: c.recoveryCode, newPassword: NEW, deviceName: "PC" },
    });
    eq(JSON.stringify([unknown.status, unknown.body?.error]), JSON.stringify([again.status, again.body?.error]),
      "same answer for unknown user");
  });

  await scenario(18, "Export: Format, keine Hashes/Tokens/Endpunkte", async () => {
    const r = await api("GET", "/me/export", { token: A.token });
    eq(r.status, 200, `export ${errOf(r)}`);
    eq(r.body.format, "display-buddy-export/1", "format");
    assert(/attachment/.test(r.headers.get("content-disposition") ?? ""), "Content-Disposition");
    const text = JSON.stringify(r.body);
    for (const bad of ["hash", "token", "endpoint", "p256dh", A.token]) assert(!text.includes(bad), `contains ${bad}`);
    eq(r.body.notes.length, 1, "live notes");
    const second = await api("GET", "/me/export", { token: A.token });
    eq(second.status, 429, "1/min");
  });

  await scenario(22, "Kontingent: Paket über Limit 413, Löschen geht durch", async () => {
    const used = (await api("GET", "/me/account", { token: A.token })).body.usage.bytes;
    admin(`user quota anna --bytes ${used + 200}`);
    const id = randomUUID();
    const big = await api("POST", "/sync/push", {
      token: A.token,
      body: { notes: [noteRecord(id, A.device, "Groß", undefined, "y".repeat(2000))], reminders: [] },
    });
    eq(big.status, 413, `big push ${errOf(big)}`);
    eq(big.body.error, "quota_exceeded", "code");
    const notes = (await api("GET", "/sync/changes?since=0&limit=200", { token: A.token })).body.notes;
    eq(notes.length, 1, "nothing applied");
    const del = await api("POST", "/sync/push", {
      token: A.token,
      body: {
        notes: [{ id: notes[0].id, updatedAt: new Date().toISOString(), updatedBy: A.device, deleted: true, note: null }],
        reminders: [],
      },
    });
    eq(del.status, 200, `delete push ${errOf(del)}`);
    admin("user quota anna --bytes default");
  });

  await scenario(23, "Geräte-Limit: nächstes Gerät 409 device_limit", async () => {
    const n = (await api("GET", "/me/account", { token: A.token })).body.usage.devices;
    admin(`user quota anna --devices ${n}`);
    const r = await deviceLogin("anna", PW, "mobile", "198.51.100.23");
    eq(r.body?.error, "device_limit", `login ${errOf(r)}`);
    const p = await startPairing(A.token);
    const q = await redeemNative(p.code, "203.0.113.23");
    eq(q.body?.error, "device_limit", "pairing");
    admin("user quota anna --devices default");
  });

  await scenario(24, "Konto gesperrt (CLI): 403 account_disabled, auch Login", async () => {
    admin("user disable anna");
    const r = await api("GET", "/me/account", { token: A.token });
    eq(r.body?.error, "account_disabled", `token ${errOf(r)}`);
    const l = await deviceLogin("anna", PW, "desktop", "198.51.100.24");
    eq(l.body?.error, "account_disabled", "login");
    admin("user enable anna");
    eq((await api("GET", "/me/account", { token: A.token })).status, 200, "after enable");
  });

  await scenario(15, "Passwort ändern: ohne altes (< 24 h) 403, mit altem → andere abgemeldet", async () => {
    const other = (await deviceLogin("anna", PW, "mobile", "198.51.100.15")).body;
    const NEW = "anna has a new passphrase";
    secrets.add(NEW);
    const no = await api("PUT", "/me/password", {
      token: A.token,
      body: { currentPassword: null, newPassword: NEW, signOutOthers: true },
    });
    eq(no.body?.error, "password_required", "young device without current password");
    const ok = await api("PUT", "/me/password", {
      token: A.token,
      body: { currentPassword: PW, newPassword: NEW, signOutOthers: true },
    });
    eq(ok.status, 204, `change ${errOf(ok)}`);
    eq((await api("GET", "/me", { token: other.token })).status, 401, "other device signed out");
    eq((await api("GET", "/me", { token: A.token })).status, 200, "this device stays");
  });

  await scenario(17, "Konto löschen: alle Daten weg, anderes Konto unberührt", async () => {
    const r = await register("bert", PW, "198.51.100.170");
    const b = r.body;
    const p = await startPairing(b.token);
    const phone = (await redeemNative(p.code, "203.0.113.17")).body;
    const wrongName = await api("POST", "/me/delete", { token: b.token, body: { password: PW, confirmUsername: "anna" } });
    eq(wrongName.status, 400, "username mismatch");
    const wrongPw = await api("POST", "/me/delete", {
      token: b.token,
      body: { password: "not the password", confirmUsername: "bert" },
    });
    eq(wrongPw.status, 403, "wrong password = 403");
    const del = await api("POST", "/me/delete", { token: b.token, body: { password: PW, confirmUsername: "Bert" } });
    eq(del.status, 204, `delete ${errOf(del)}`);
    eq((await api("GET", "/me", { token: b.token })).status, 401, "PC token");
    eq((await api("GET", "/me", { token: phone.token })).status, 401, "phone token");
    const list = admin("user list");
    assert(!/\bbert\b/.test(list), "bert still listed");
    assert(/\banna\b/.test(list), "anna gone");
  });

  await scenario(26, "Logs ohne Passwort, Token, Wiederherstellungs- und Pairing-Code", async () => {
    const log = wsl(`cat ${DIR}/server.log`).out;
    assert(log.length > 1000, "log too short – RUST_LOG not applied?");
    const leaked = [...secrets].filter((s) => s && s.length >= 8 && log.includes(s));
    eq(leaked.length, 0, `secrets in log (${leaked.length})`);
    return `${secrets.size} Geheimnisse geprüft, Log ${log.length} Zeichen`;
  });
} finally {
  wsl(`pkill -f '${BIN} serve' ; true`);
  proc.kill();
  wsl(`rm -rf ${DIR}`);
}

const failed = results.filter((r) => r.ok === false);
const skipped = results.filter((r) => r.ok === null).length;
console.log(
  `
${results.length - failed.length - skipped}/${results.length} Szenarien bestanden` +
    (skipped ? `, ${skipped} übersprungen` : ""),
);
process.exit(failed.length ? 1 : 0);
