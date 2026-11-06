#!/usr/bin/env node
/**
 * Adds Firebase to the generated Android project (gen/android is created in CI by
 * `tauri android init` and never committed, D-79) – only when the GitHub secret
 * GOOGLE_SERVICES_JSON_BASE64 is set. Without it the app builds unchanged and simply has
 * no native push (the buddy-push plugin answers NOT_CONFIGURED).
 *
 * Steps (Firebase docs „Add Firebase to your Android project“ → Gradle plugin):
 * 1. google-services.json → gen/android/app/ (checked: valid JSON, contains a client for
 *    the app's package name);
 * 2. root build.gradle.kts: classpath com.google.gms:google-services next to the Android
 *    Gradle plugin in the `buildscript` block;
 * 3. app/build.gradle.kts: `apply(plugin = "com.google.gms.google-services")`.
 * Idempotent; never prints the file contents.
 *
 * Usage: node mobile/scripts/android-firebase.mjs <gen/android dir> <package name>
 * (secret in the environment variable GOOGLE_SERVICES_JSON_BASE64).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** Google Services Gradle plugin (com.google.gms:google-services). */
export const GOOGLE_SERVICES_VERSION = "4.4.4";
const CLASSPATH = `classpath("com.google.gms:google-services:${GOOGLE_SERVICES_VERSION}")`;
const APPLY = `apply(plugin = "com.google.gms.google-services")`;

/** Decodes and checks the secret; returns the JSON text. Throws with a safe message. */
export function decodeGoogleServices(base64, packageName) {
  let text;
  let json;
  try {
    text = Buffer.from(base64.trim(), "base64").toString("utf8");
    json = JSON.parse(text);
  } catch {
    throw new Error("GOOGLE_SERVICES_JSON_BASE64 is not base64 of a JSON file (base64 -w0 google-services.json)");
  }
  const clients = Array.isArray(json?.client) ? json.client : [];
  const names = clients.map((c) => c?.client_info?.android_client_info?.package_name).filter(Boolean);
  if (!json?.project_info?.project_id || names.length === 0) {
    throw new Error("google-services.json has no project_info/client entries – download it again from the Firebase console");
  }
  if (!names.includes(packageName)) {
    throw new Error(`google-services.json has no Android app "${packageName}" (found: ${names.join(", ")}) – register the app with this package name in Firebase`);
  }
  return text;
}

/** Adds the google-services classpath to the root build.gradle.kts. */
export function patchRootGradle(src) {
  if (src.includes("com.google.gms:google-services")) return src;
  const re = /^(\s*)classpath\("com\.android\.tools\.build:gradle:[^"]+"\)\s*$/m;
  const m = re.exec(src);
  if (!m) throw new Error("root build.gradle.kts: no classpath(\"com.android.tools.build:gradle:…\") line found");
  const at = m.index + m[0].length;
  return `${src.slice(0, at)}\n${m[1]}${CLASSPATH}${src.slice(at)}`;
}

/** Applies the plugin at the end of app/build.gradle.kts. */
export function patchAppGradle(src) {
  if (src.includes("com.google.gms.google-services")) return src;
  return `${src.replace(/\s*$/, "")}\n\n// Firebase (added by mobile/scripts/android-firebase.mjs)\n${APPLY}\n`;
}

export function run(genAndroid, packageName, env = process.env) {
  const secret = env.GOOGLE_SERVICES_JSON_BASE64 ?? "";
  if (!secret.trim()) {
    console.log("GOOGLE_SERVICES_JSON_BASE64 not set: building without native push (FCM).");
    return false;
  }
  const rootGradle = join(genAndroid, "build.gradle.kts");
  const appGradle = join(genAndroid, "app", "build.gradle.kts");
  if (!existsSync(rootGradle) || !existsSync(appGradle)) {
    throw new Error(`${genAndroid} is not a generated Android project (run tauri android init first)`);
  }
  writeFileSync(join(genAndroid, "app", "google-services.json"), decodeGoogleServices(secret, packageName), { mode: 0o600 });
  writeFileSync(rootGradle, patchRootGradle(readFileSync(rootGradle, "utf8")));
  writeFileSync(appGradle, patchAppGradle(readFileSync(appGradle, "utf8")));
  console.log(`Firebase added to ${genAndroid} (google-services ${GOOGLE_SERVICES_VERSION}).`);
  return true;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [genAndroid, packageName] = process.argv.slice(2);
  if (!genAndroid || !packageName) {
    console.error("usage: android-firebase.mjs <gen/android dir> <package name>");
    process.exit(2);
  }
  try {
    run(genAndroid, packageName);
  } catch (e) {
    console.error(`::error::${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
