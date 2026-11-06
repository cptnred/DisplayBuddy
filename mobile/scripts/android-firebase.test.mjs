// node --test mobile/scripts/ (Node's built-in test runner; Vitest only covers src/)
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { decodeGoogleServices, GOOGLE_SERVICES_VERSION, patchAppGradle, patchRootGradle, run } from "./android-firebase.mjs";

const PKG = "de.displaybuddy.mobile";
// Shape of a google-services.json with placeholder values (no real project).
const services = (pkg = PKG) => ({
  project_info: { project_number: "000000000000", project_id: "buddy-example", storage_bucket: "buddy-example.example" },
  client: [
    {
      client_info: { mobilesdk_app_id: "1:000000000000:android:0000", android_client_info: { package_name: pkg } },
      api_key: [{ current_key: "placeholder" }],
    },
  ],
  configuration_version: "1",
});
const b64 = (v) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64");

// Layout of the root build.gradle.kts that `tauri android init` (Tauri 2) generates.
const ROOT = `buildscript {
    repositories {
        google()
        mavenCentral()
    }
    dependencies {
        classpath("com.android.tools.build:gradle:8.11.0")
        classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:1.9.25")
    }
}

allprojects {
    repositories {
        google()
        mavenCentral()
    }
}
`;
const APP = `plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

android { namespace = "de.displaybuddy.mobile" }
`;

test("decodes and checks google-services.json", () => {
  assert.equal(JSON.parse(decodeGoogleServices(b64(services()), PKG)).project_info.project_id, "buddy-example");
  assert.throws(() => decodeGoogleServices(b64(services("com.other.app")), PKG), /no Android app "de.displaybuddy.mobile".*com\.other\.app/);
  assert.throws(() => decodeGoogleServices("!!!", PKG), /not base64 of a JSON/);
  assert.throws(() => decodeGoogleServices(b64("{}"), PKG), /no project_info/);
});

test("adds the classpath next to the Android Gradle plugin, once", () => {
  const once = patchRootGradle(ROOT);
  assert.match(once, new RegExp(`gradle:8\\.11\\.0"\\)\\n        classpath\\("com\\.google\\.gms:google-services:${GOOGLE_SERVICES_VERSION.replace(/\./g, "\\.")}"\\)`));
  assert.equal(patchRootGradle(once), once);
  assert.throws(() => patchRootGradle("plugins {}\n"), /no classpath/);
});

test("applies the plugin in the app module, once", () => {
  const once = patchAppGradle(APP);
  assert.ok(once.endsWith('apply(plugin = "com.google.gms.google-services")\n'));
  assert.equal(patchAppGradle(once), once);
});

test("run: without the secret nothing changes; with it all three steps happen", () => {
  const dir = mkdtempSync(join(tmpdir(), "buddy-gen-"));
  mkdirSync(join(dir, "app"));
  writeFileSync(join(dir, "build.gradle.kts"), ROOT);
  writeFileSync(join(dir, "app", "build.gradle.kts"), APP);
  assert.equal(run(dir, PKG, {}), false);
  assert.equal(readFileSync(join(dir, "build.gradle.kts"), "utf8"), ROOT);

  assert.equal(run(dir, PKG, { GOOGLE_SERVICES_JSON_BASE64: b64(services()) }), true);
  const json = join(dir, "app", "google-services.json");
  assert.equal(JSON.parse(readFileSync(json, "utf8")).project_info.project_id, "buddy-example");
  if (process.platform !== "win32") assert.equal(statSync(json).mode & 0o777, 0o600);
  assert.match(readFileSync(join(dir, "build.gradle.kts"), "utf8"), /google-services:/);
  assert.match(readFileSync(join(dir, "app", "build.gradle.kts"), "utf8"), /apply\(plugin = "com\.google\.gms\.google-services"\)/);
  // idempotent
  run(dir, PKG, { GOOGLE_SERVICES_JSON_BASE64: b64(services()) });
  assert.equal(readFileSync(join(dir, "app", "build.gradle.kts"), "utf8").match(/google-services"\)/g).length, 1);

  assert.throws(() => run(join(dir, "missing"), PKG, { GOOGLE_SERVICES_JSON_BASE64: b64(services()) }), /not a generated Android project/);
});
