import { describe, expect, it } from "vitest";
import { SyncError } from "../../sync";
import { errorText } from "./LoginPage";

describe("login error texts", () => {
  it("maps SyncError codes of the real engine to German texts", () => {
    expect(errorText(new SyncError("unauthorized", "x", 401))).toBe("Benutzername oder Passwort ist falsch.");
    expect(errorText(new SyncError("too_many_requests", "x", 429))).toMatch(/Zu viele Versuche/);
    expect(errorText(new SyncError("account_mismatch", "x"))).toMatch(/anderes Konto/);
    expect(errorText(new SyncError("network", "x"))).toMatch(/nicht erreichbar/);
    expect(errorText(new SyncError("http", "x", 500))).toMatch(/unerwartet/);
  });
});
