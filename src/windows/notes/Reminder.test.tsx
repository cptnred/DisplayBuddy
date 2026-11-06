/**
 * v3 reminder popover / banner / badge in several zones (PLAN_V3_SYNC §5.5, §8).
 * Device zone and "now" are injected, so the results do not depend on the TZ of the
 * test run (npm run test:tz runs this under America/New_York and Asia/Tokyo too).
 */
import { fireEvent, render, screen, within } from "@testing-library/react";
import { vi } from "vitest";
import type { Reminder } from "../../types";
import { DueBanner, ReminderBadge, ReminderControl, formatInZone, reminderLabel } from "./Reminder";

const ID = "11111111-1111-4111-8111-111111111111";
const BERLIN = "Europe/Berlin";
const NEW_YORK = "America/New_York";

const rem = (at: string, timeZone: string | null, state: Reminder["state"] = "scheduled"): Reminder => ({
  noteId: ID,
  at,
  repeat: "daily",
  state,
  firedAt: state === "due" ? at : null,
  updatedAt: "2026-11-06T08:00:00.000Z",
  timeZone,
});

function renderControl(reminder: Reminder | null, deviceZone: string, nowIso: string) {
  const onSave = vi.fn(async () => true);
  const onRemove = vi.fn(async () => true);
  render(
    <ReminderControl
      reminder={reminder}
      onSave={onSave}
      onRemove={onRemove}
      deviceZone={deviceZone}
      now={() => new Date(nowIso)}
    />,
  );
  const bell = screen.getByRole("button", { name: "Erinnerung" });
  return { onSave, onRemove, bell };
}

const open = (bell: HTMLElement) => {
  fireEvent.click(bell);
  return screen.getByRole("dialog", { name: "Erinnerung festlegen" });
};
const input = (dialog: HTMLElement, label: string) => within(dialog).getByLabelText(label) as HTMLInputElement;

describe("reminder labels", () => {
  it("formats relative days in the given zone", () => {
    const now = Date.parse("2026-11-06T10:00:00.000Z"); // Fri
    expect(formatInZone(Date.parse("2026-11-06T13:30:00.000Z"), now, BERLIN)).toBe("Heute, 14:30");
    expect(formatInZone(Date.parse("2026-11-07T08:00:00.000Z"), now, BERLIN)).toBe("Morgen, 09:00");
    expect(formatInZone(Date.parse("2026-11-05T17:00:00.000Z"), now, BERLIN)).toBe("Gestern, 18:00");
    expect(formatInZone(Date.parse("2026-11-10T08:00:00.000Z"), now, BERLIN)).toBe("Di., 10.11., 09:00");
    expect(formatInZone(Date.parse("2027-01-04T08:00:00.000Z"), now, BERLIN)).toBe("04.01.2027, 09:00");
    // 23:30 UTC is already tomorrow in Tokyo, still today in New York
    const late = Date.parse("2026-11-06T23:30:00.000Z");
    expect(formatInZone(late, now, "Asia/Tokyo")).toBe("Morgen, 08:30");
    expect(formatInZone(late, now, NEW_YORK)).toBe("Heute, 18:30");
  });

  it("adds the original time only when the zone shows another wall time", () => {
    const now = new Date("2026-11-06T15:00:00.000Z");
    // daily 09:00 Berlin seen from New York
    expect(reminderLabel("2026-11-07T08:00:00.000Z", BERLIN, now, NEW_YORK)).toBe("Morgen, 03:00 (09:00 Berlin)");
    expect(reminderLabel("2026-11-07T08:00:00.000Z", BERLIN, now, BERLIN)).toBe("Morgen, 09:00");
    // alias with the same offset → no original
    expect(reminderLabel("2026-11-07T08:00:00.000Z", "Europe/Paris", now, BERLIN)).toBe("Morgen, 09:00");
    // legacy reminder without zone → device zone, garbage stays verbatim
    expect(reminderLabel("2026-11-07T08:00:00.000Z", null, now, NEW_YORK)).toBe("Morgen, 03:00");
    expect(reminderLabel("nope", BERLIN, now, BERLIN)).toBe("nope");
  });

  it("EU/US switch week: 09:00 Berlin is 04:00 in New York before, 03:00 after the US switch", () => {
    const now = new Date("2026-10-27T12:00:00.000Z");
    expect(reminderLabel("2026-10-28T08:00:00.000Z", BERLIN, now, NEW_YORK)).toBe("Morgen, 04:00 (09:00 Berlin)");
    expect(reminderLabel("2026-11-02T08:00:00.000Z", BERLIN, now, NEW_YORK)).toBe("Mo., 02.11., 03:00 (09:00 Berlin)");
  });
});

describe("ReminderControl in several zones", () => {
  it("PC in Berlin, reminder in New York: input in New York time, hint in Berlin time", () => {
    const { bell, onSave } = renderControl(rem("2026-11-06T14:00:00.000Z", NEW_YORK), BERLIN, "2026-11-06T10:00:00.000Z");
    expect(bell).toHaveAttribute("title", "Erinnerung: Heute, 15:00 (09:00 New York)");
    const dialog = open(bell);
    expect(within(dialog).getByText("Geplant: Heute, 15:00 (09:00 New York)")).toBeInTheDocument();
    expect(input(dialog, "Datum").value).toBe("2026-11-06");
    expect(input(dialog, "Uhrzeit").value).toBe("09:00");
    expect(within(dialog).getByText("Zeitzone: America/New_York")).toBeInTheDocument();
    expect(within(dialog).getByText("Bei dir: Heute, 15:00")).toBeInTheDocument();
    fireEvent.change(input(dialog, "Uhrzeit"), { target: { value: "10:30" } });
    expect(within(dialog).getByText("Bei dir: Heute, 16:30")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Speichern" }));
    expect(onSave).toHaveBeenCalledWith("2026-11-06T15:30:00.000Z", "daily", NEW_YORK);
  });

  it("PC in New York, reminder in Berlin", () => {
    const { bell } = renderControl(rem("2026-11-07T08:00:00.000Z", BERLIN), NEW_YORK, "2026-11-06T15:00:00.000Z");
    expect(bell).toHaveAttribute("title", "Erinnerung: Morgen, 03:00 (09:00 Berlin)");
    const dialog = open(bell);
    expect(input(dialog, "Datum").value).toBe("2026-11-07");
    expect(input(dialog, "Uhrzeit").value).toBe("09:00");
    expect(within(dialog).getByText("Bei dir: Morgen, 03:00")).toBeInTheDocument();
  });

  it("new reminder: PC zone, next full hour, no hint", () => {
    const { bell, onSave } = renderControl(null, BERLIN, "2026-11-06T10:20:00.000Z");
    const dialog = open(bell);
    expect(input(dialog, "Datum").value).toBe("2026-11-06");
    expect(input(dialog, "Uhrzeit").value).toBe("12:00"); // 11:20 Berlin → 12:00
    expect(within(dialog).getByText("Zeitzone: Europe/Berlin")).toBeInTheDocument();
    expect(dialog.querySelector("[data-local-hint]")).toBeNull();
    expect(within(dialog).queryByLabelText("Zeitzone")).toBeNull(); // picker collapsed
    fireEvent.click(within(dialog).getByRole("button", { name: "Speichern" }));
    expect(onSave).toHaveBeenCalledWith("2026-11-06T11:00:00.000Z", "none", BERLIN);
  });

  it("changing the zone keeps the entered wall time and changes the instant", () => {
    const { bell, onSave } = renderControl(null, BERLIN, "2026-11-06T10:00:00.000Z");
    const dialog = open(bell);
    fireEvent.change(input(dialog, "Datum"), { target: { value: "2026-11-10" } });
    fireEvent.change(input(dialog, "Uhrzeit"), { target: { value: "09:00" } });
    const toggle = within(dialog).getByRole("button", { name: "Zeitzone ändern" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const select = within(dialog).getByLabelText("Zeitzone") as HTMLSelectElement;
    expect(select.value).toBe(BERLIN);
    expect([...select.options].map((o) => o.value)).toContain("Asia/Tokyo");
    fireEvent.change(select, { target: { value: "Asia/Tokyo" } });
    expect(within(dialog).getByText("Zeitzone: Asia/Tokyo")).toBeInTheDocument();
    expect(within(dialog).getByText("Bei dir: Di., 10.11., 01:00")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Speichern" }));
    expect(onSave).toHaveBeenCalledWith("2026-11-10T00:00:00.000Z", "none", "Asia/Tokyo");
  });

  it("DST gap: 02:30 Berlin on the switch day becomes 03:00 CEST", () => {
    const { bell, onSave } = renderControl(null, BERLIN, "2027-03-20T10:00:00.000Z");
    const dialog = open(bell);
    fireEvent.change(input(dialog, "Datum"), { target: { value: "2027-03-28" } });
    fireEvent.change(input(dialog, "Uhrzeit"), { target: { value: "02:30" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Speichern" }));
    expect(onSave).toHaveBeenCalledWith("2027-03-28T01:00:00.000Z", "none", BERLIN);
  });

  it("past check compares instants, not wall times of different zones", () => {
    // 10:00 UTC now; 08:00 New York (= 13:00 UTC) is still in the future
    const { bell, onSave } = renderControl(null, BERLIN, "2026-11-06T10:00:00.000Z");
    const dialog = open(bell);
    fireEvent.click(within(dialog).getByRole("button", { name: "Zeitzone ändern" }));
    fireEvent.change(within(dialog).getByLabelText("Zeitzone"), { target: { value: NEW_YORK } });
    fireEvent.change(input(dialog, "Datum"), { target: { value: "2026-11-06" } });
    fireEvent.change(input(dialog, "Uhrzeit"), { target: { value: "08:00" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Speichern" }));
    expect(onSave).toHaveBeenCalledWith("2026-11-06T13:00:00.000Z", "none", NEW_YORK);
  });
});

describe("banner and badge show the original time", () => {
  it("due banner and side badge from a Berlin PC for a New York reminder", () => {
    const now = () => new Date("2026-11-06T14:05:00.000Z");
    const r = rem("2026-11-06T14:00:00.000Z", NEW_YORK, "due");
    render(<DueBanner reminder={r} onAck={() => {}} onSnooze={() => {}} now={now} deviceZone={BERLIN} />);
    expect(screen.getByText("🔔 Erinnerung fällig – Heute, 15:00 (09:00 New York)")).toBeInTheDocument();
    render(<ReminderBadge reminder={r} now={now} deviceZone={BERLIN} />);
    const badge = document.querySelector("[data-reminder-badge]")!;
    expect(badge).toHaveTextContent("Heute, 15:00 (09:00 New York)");
    expect(badge).toHaveAttribute("title", "Erinnerung fällig: Heute, 15:00 (09:00 New York)");
  });
});
