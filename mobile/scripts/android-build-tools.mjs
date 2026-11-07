#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const DEFAULT_BUILD_TOOLS_VERSION = "36.1.0";

export function patchBuildToolsVersion(source, version = DEFAULT_BUILD_TOOLS_VERSION) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`Invalid Android Build-Tools version "${version}" (expected x.y.z)`);
  }

  const configured = /^([ \t]*)buildToolsVersion[ \t]*=[ \t]*"([^"]+)"[ \t]*$/m;
  if (configured.test(source)) {
    return source.replace(configured, (_line, indent) => `${indent}buildToolsVersion = "${version}"`);
  }

  const androidBlock = /^([ \t]*android[ \t]*\{)[ \t]*(\r?\n)/m;
  const match = androidBlock.exec(source);
  if (!match) {
    throw new Error("app/build.gradle.kts: no android { block found");
  }

  const indent = match[1].match(/^[ \t]*/)?.[0] ?? "";
  const buildTools = `${indent}    buildToolsVersion = "${version}"`;
  return source.replace(androidBlock, `${match[1]}${match[2]}${buildTools}${match[2]}`);
}

export function run(genAndroid, version = DEFAULT_BUILD_TOOLS_VERSION) {
  const appGradle = join(genAndroid, "app", "build.gradle.kts");
  if (!existsSync(appGradle)) {
    throw new Error(`${genAndroid} is not a generated Android project (run tauri android init first)`);
  }

  const source = readFileSync(appGradle, "utf8");
  const configured = patchBuildToolsVersion(source, version);
  if (configured !== source) writeFileSync(appGradle, configured);
  console.log(`Android Build-Tools pinned to ${version} in ${appGradle}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [genAndroid, version = DEFAULT_BUILD_TOOLS_VERSION] = process.argv.slice(2);
  if (!genAndroid) {
    console.error("usage: android-build-tools.mjs <gen/android dir> [version]");
    process.exit(2);
  }
  try {
    run(genAndroid, version);
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
