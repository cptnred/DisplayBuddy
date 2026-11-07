// node --test mobile/scripts/ (Node's built-in test runner; Vitest only covers src/)
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_BUILD_TOOLS_VERSION, patchBuildToolsVersion, run } from "./android-build-tools.mjs";

const APP = `plugins {
    id("com.android.application")
}

android {
    compileSdk = 37
    namespace = "de.displaybuddy.mobile"
}
`;

test("pins the selected Build-Tools version once", () => {
  const configured = patchBuildToolsVersion(APP);
  assert.ok(configured.includes(`    buildToolsVersion = "${DEFAULT_BUILD_TOOLS_VERSION}"\n`));
  assert.equal(patchBuildToolsVersion(configured), configured);
  assert.ok(patchBuildToolsVersion(configured, "36.0.0").includes('buildToolsVersion = "36.0.0"'));
});

test("rejects invalid versions and unexpected Gradle files", () => {
  assert.throws(() => patchBuildToolsVersion(APP, "latest"), /Invalid Android Build-Tools version/);
  assert.throws(() => patchBuildToolsVersion("plugins {}\n"), /no android \{ block found/);
});

test("run updates the generated app Gradle file", () => {
  const dir = mkdtempSync(join(tmpdir(), "buddy-android-"));
  mkdirSync(join(dir, "app"));
  const appGradle = join(dir, "app", "build.gradle.kts");
  writeFileSync(appGradle, APP);

  run(dir);
  assert.ok(readFileSync(appGradle, "utf8").includes(`buildToolsVersion = "${DEFAULT_BUILD_TOOLS_VERSION}"`));
  const configured = readFileSync(appGradle, "utf8");
  run(dir);
  assert.equal(readFileSync(appGradle, "utf8"), configured);

  assert.throws(() => run(join(dir, "missing")), /not a generated Android project/);
});
