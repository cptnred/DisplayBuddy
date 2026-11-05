/**
 * Every `api.*` call a window makes must be allowed by that window's capability
 * (src-tauri/capabilities/<window>.json); otherwise the call fails at runtime on
 * Windows only ("command not allowed"), which no other unit test would notice.
 * Source files are scanned as text.
 */
import { describe, expect, it } from "vitest";
import buddyCap from "../../src-tauri/capabilities/buddy.json";
import notesCap from "../../src-tauri/capabilities/notes.json";
import settingsCap from "../../src-tauri/capabilities/settings.json";
import { api } from "./api";

const sources = import.meta.glob<string>(["../windows/*/*.{ts,tsx}", "../components/**/*.{ts,tsx}"], {
  query: "?raw",
  import: "default",
  eager: true,
});

const CAPS: Record<string, { windows: string[]; permissions: string[] }> = {
  buddy: buddyCap,
  notes: notesCap,
  settings: settingsCap,
};

/** Which window bundle a source file ends up in (editor components belong to notes). */
function windowOf(path: string): string | null {
  if (path.includes(".test.")) return null;
  const m = /\.\.\/windows\/(\w+)\//.exec(path);
  if (m) return m[1];
  if (path.startsWith("../components/editor/")) return "notes";
  return null;
}

const snake = (camel: string) => camel.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/** Permissions each window needs, derived from the source text. */
function requiredPermissions(): Record<string, Set<string>> {
  const req: Record<string, Set<string>> = {};
  for (const [path, text] of Object.entries(sources)) {
    const win = windowOf(path);
    if (!win) continue;
    const set = (req[win] ??= new Set());
    // `api.foo(` or `api\n  .foo(` (chained formatting)
    for (const m of text.matchAll(/\bapi\s*\.\s*(\w+)/g)) {
      const method = m[1];
      if (method.startsWith("on")) {
        set.add("core:event:allow-listen");
        set.add("core:event:allow-unlisten");
      } else {
        set.add(`allow-${snake(method).replace(/_/g, "-")}`);
      }
    }
    if (/\.startDragging\s*\(/.test(text)) set.add("core:window:allow-start-dragging");
  }
  return req;
}

describe("capabilities", () => {
  it("scans the expected window sources", () => {
    const wins = new Set(Object.keys(sources).map(windowOf).filter(Boolean));
    expect([...wins].sort()).toEqual(["buddy", "notes", "settings"]);
  });

  it("api method names map to real api methods", () => {
    const req = requiredPermissions();
    const commands = new Set(
      Object.keys(api)
        .filter((k) => !/^on[A-Z]/.test(k))
        .map((k) => `allow-${snake(k).replace(/_/g, "-")}`),
    );
    for (const perms of Object.values(req)) {
      for (const p of perms) {
        if (p.startsWith("core:")) continue;
        expect(commands, `unknown api call → ${p}`).toContain(p);
      }
    }
  });

  it.each(Object.keys(CAPS))("%s capability allows everything the %s window calls", (win) => {
    const cap = CAPS[win];
    expect(cap.windows).toEqual([win]);
    const required = [...(requiredPermissions()[win] ?? [])].sort();
    expect(required.length).toBeGreaterThan(0);
    const missing = required.filter((p) => !cap.permissions.includes(p));
    expect(missing, `${win}.json is missing permissions`).toEqual([]);
  });

  it("capabilities grant no command the window does not use (least privilege)", () => {
    // Granted on purpose although currently unused: part of the notes CRUD contract (PLAN §5).
    const ALLOWED_UNUSED: Record<string, string[]> = { notes: ["allow-load-note"] };
    const req = requiredPermissions();
    for (const [win, cap] of Object.entries(CAPS)) {
      const unused = cap.permissions.filter((p) => !req[win]?.has(p) && !ALLOWED_UNUSED[win]?.includes(p));
      expect(unused, `${win}.json grants unused permissions`).toEqual([]);
    }
  });
});
