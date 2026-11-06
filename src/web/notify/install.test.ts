import { describe, expect, it, vi } from "vitest";
import { createInstallController, createStorageController } from "./install";
import type { PlatformInfo } from "./platform";

const CHROME: PlatformInfo = { userAgent: "Mozilla/5.0 (Linux; Android 15) Chrome/142.0 Mobile Safari/537.36", displayStandalone: false };
const IOS: PlatformInfo = { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) Safari/604.1", displayStandalone: false };
const FIREFOX: PlatformInfo = { userAgent: "Mozilla/5.0 (Android 15; Mobile; rv:150.0) Gecko/150.0 Firefox/150.0", displayStandalone: false };

function promptEvent(outcome: "accepted" | "dismissed") {
  const e = new Event("beforeinstallprompt", { cancelable: true }) as Event & {
    prompt: ReturnType<typeof vi.fn>;
    userChoice: Promise<{ outcome: string }>;
  };
  e.prompt = vi.fn(async () => undefined);
  e.userChoice = Promise.resolve({ outcome });
  return e;
}

describe("install controller", () => {
  it("offers the prompt after beforeinstallprompt and prevents the mini-infobar", async () => {
    const target = new EventTarget();
    const c = createInstallController({ platform: () => CHROME, target });
    expect(c.mode()).toBe("manual");
    const seen: string[] = [];
    c.onChange((m) => seen.push(m));
    const e = promptEvent("accepted");
    target.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(c.mode()).toBe("prompt");
    expect(await c.prompt()).toBe(true);
    expect(e.prompt).toHaveBeenCalled();
    expect(c.mode()).toBe("installed");
    expect(seen).toEqual(["prompt", "installed"]);
  });

  it("drops a dismissed prompt (an event can be prompted only once)", async () => {
    const target = new EventTarget();
    const c = createInstallController({ platform: () => CHROME, target });
    target.dispatchEvent(promptEvent("dismissed"));
    expect(await c.prompt()).toBe(false);
    expect(c.mode()).toBe("manual");
    expect(await c.prompt()).toBe(false);
  });

  it("shows the guide on iOS and Firefox, nothing when installed", () => {
    const target = new EventTarget();
    expect(createInstallController({ platform: () => IOS, target }).mode()).toBe("ios");
    expect(createInstallController({ platform: () => FIREFOX, target }).mode()).toBe("manual");
    expect(createInstallController({ platform: () => ({ ...IOS, iosStandalone: true }), target }).mode()).toBe("installed");
    const c = createInstallController({ platform: () => CHROME, target });
    target.dispatchEvent(new Event("appinstalled"));
    expect(c.mode()).toBe("installed");
  });
});

describe("storage controller", () => {
  it("wraps navigator.storage and is null without it", async () => {
    expect(createStorageController(undefined)).toBeNull();
    const s = createStorageController({
      persist: async () => true,
      persisted: async () => false,
      estimate: async () => ({ usage: 2048, quota: 10_000 }),
    } as unknown as StorageManager);
    expect(await s?.persist()).toBe(true);
    expect(await s?.persisted()).toBe(false);
    expect(await s?.estimate()).toEqual({ usage: 2048, quota: 10_000 });
  });
});
