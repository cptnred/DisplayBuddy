import {
  deviceZone,
  formatWall,
  instantToWall,
  isValidZone,
  offsetMs,
  parseWall,
  reminderWalls,
  supportedZones,
  wallFromInputs,
  wallToInstant,
  zoneLabel,
} from "./zoned";

describe("zoned.ts", () => {
  it("validates zone names", () => {
    expect(isValidZone("Europe/Berlin")).toBe(true);
    expect(isValidZone("Mars/Olympus")).toBe(false);
    expect(isValidZone("")).toBe(false);
    expect(isValidZone(deviceZone())).toBe(true);
    expect(supportedZones()).toContain("Asia/Tokyo");
    // ICU may list the canonical alias "Asia/Calcutta"; both names are valid
    expect(isValidZone("Asia/Calcutta") && isValidZone("Asia/Kolkata")).toBe(true);
  });

  it("parses wall times strictly", () => {
    expect(parseWall("2026-02-31T09:00")).toBeNull();
    expect(parseWall("2026-11-05T25:00")).toBeNull();
    expect(parseWall("2026-11-05 09:00")).toBeNull();
    expect(wallFromInputs("2026-11-05", "09:30")).toMatchObject({ year: 2026, month: 11, day: 5, hour: 9, minute: 30 });
  });

  it("offsets incl. half-hour zones", () => {
    const t = Date.UTC(2026, 10, 6, 8);
    expect(offsetMs(t, "Asia/Kolkata")).toBe(5.5 * 3600_000);
    expect(offsetMs(t, "Australia/Lord_Howe")).toBe(11 * 3600_000);
    expect(offsetMs(Date.UTC(2026, 6, 1), "Australia/Lord_Howe")).toBe(10.5 * 3600_000);
    expect(offsetMs(t, "UTC")).toBe(0);
  });

  it("gap → next valid minute, fold → earlier (Berlin)", () => {
    expect(new Date(wallToInstant(parseWall("2026-03-29T02:30")!, "Europe/Berlin")!).toISOString()).toBe("2026-03-29T01:00:00.000Z");
    expect(new Date(wallToInstant(parseWall("2026-10-25T02:30")!, "Europe/Berlin")!).toISOString()).toBe("2026-10-25T00:30:00.000Z");
    expect(formatWall(instantToWall(Date.UTC(2026, 9, 25, 1, 30), "Europe/Berlin"))).toBe("2026-10-25T02:30");
  });

  it("labels and display parts „03:00 (09:00 Berlin)“", () => {
    expect(zoneLabel("America/New_York")).toBe("New York");
    expect(zoneLabel("UTC")).toBe("UTC");
    const at = Date.UTC(2026, 10, 6, 8); // 09:00 Berlin = 03:00 New York
    const d = reminderWalls(at, "Europe/Berlin", "America/New_York");
    expect(formatWall(d.local)).toBe("2026-11-06T03:00");
    expect(d.original && formatWall(d.original.wall)).toBe("2026-11-06T09:00");
    expect(d.original?.zone).toBe("Berlin");
    expect(reminderWalls(at, "Europe/Berlin", "Europe/Berlin").original).toBeNull();
    // same offset, different name → no original shown
    expect(reminderWalls(at, "Europe/Berlin", "Europe/Paris").original).toBeNull();
  });
});
