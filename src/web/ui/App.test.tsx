import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { createInstallController } from "../notify/install";
import { ACCOUNT, createFakeNotifier, makeNote, makeReminder, renderApp } from "./testing/renderApp";

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 Version/18.5 Mobile/15E148 Safari/604.1";
const CHROME = "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/142.0 Mobile Safari/537.36";

describe("login", () => {
  it("redirects to /login without account and logs in to /setup", async () => {
    const persist = vi.fn(async () => true);
    const { history, sync, store } = renderApp({
      account: null,
      storage: { persist, persisted: async () => true, estimate: async () => null },
    });
    await screen.findByRole("form", { name: "Anmelden" });
    expect(history.path()).toBe("/login");
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Benutzername"), "anna");
    await user.type(screen.getByLabelText("Passwort"), "zu-kurz");
    await user.click(screen.getByRole("button", { name: "Anmelden" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Benutzername oder Passwort ist falsch.");

    await user.clear(screen.getByLabelText("Passwort"));
    await user.type(screen.getByLabelText("Passwort"), "ein-langes-passwort");
    await user.click(screen.getByRole("button", { name: "Anmelden" }));
    await waitFor(() => expect(history.path()).toBe("/setup"));
    expect(sync.calls).toContain("login:anna:Testgerät");
    expect(persist).toHaveBeenCalled();
    expect((await store.getAccount())?.username).toBe("anna");
    expect(await screen.findByRole("region", { name: "Benachrichtigungen" })).toBeInTheDocument();
  });

  it("asks to sign in again when the session expired and keeps the pending changes", async () => {
    const { sync, store } = renderApp({ path: "/", notes: [makeNote("n1", "Einkauf")] });
    await store.saveNote(makeNote("n1", "Einkauf 2"));
    act(() => sync.setStatus({ state: "unauthorized" }));
    const link = await screen.findByRole("link", { name: "Anmelden" });
    await userEvent.click(link);
    expect(await screen.findByText("1 Änderung wird nach dem Anmelden übertragen.")).toBeInTheDocument();
  });
});

describe("list and search", () => {
  const notes = [
    makeNote("a", "Einkaufsliste", "Milch und Brot"),
    makeNote("b", "Straße", "Hausnummer 12"),
    makeNote("c", "", "Ohne Titel hier"),
  ];

  it("lists notes in the stored order and searches title and text", async () => {
    renderApp({ notes });
    const list = await screen.findByRole("list", { name: "Notizen" });
    expect(within(list).getAllByRole("link").map((a) => a.getAttribute("href"))).toEqual([
      "/notes/a",
      "/notes/b",
      "/notes/c",
    ]);
    expect(within(list).getByText("Notiz ohne Titel")).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText("Notizen durchsuchen"), "strasse");
    expect(await screen.findByText("1 Treffer")).toBeInTheDocument();
    expect(within(list).getAllByRole("link")).toHaveLength(1);
    expect(within(list).getByText("Straße").tagName).toBe("MARK");

    await userEvent.clear(screen.getByLabelText("Notizen durchsuchen"));
    await userEvent.type(screen.getByLabelText("Notizen durchsuchen"), "xyz");
    expect(await screen.findByText("Keine Treffer.")).toBeInTheDocument();
  });

  it("creates a new note and opens it", async () => {
    const { store, history } = renderApp({ notes });
    await userEvent.click(await screen.findByRole("link", { name: "Neue Notiz anlegen" }));
    await waitFor(() => expect(history.path()).toBe("/notes/new-1"));
    expect((await store.getNote("new-1"))?.title).toBe("");
    expect(await screen.findByLabelText("Titel der Notiz")).toBeInTheDocument();
  });
});

describe("editing", () => {
  it("autosaves the title 500 ms after the last change with the store stamp", async () => {
    const { store } = renderApp({ path: "/notes/a", notes: [makeNote("a", "Alt")] });
    const title = await screen.findByLabelText("Titel der Notiz");
    fireEvent.change(title, { target: { value: "Neu" } });
    fireEvent.change(title, { target: { value: "Neuer Titel" } });
    expect(store.saveCount).toBe(0);
    await waitFor(() => expect(store.saveCount).toBe(1), { timeout: 2000 });
    const saved = await store.getNote("a");
    expect(saved?.title).toBe("Neuer Titel");
    expect(saved?.updatedAt).toBe("2026-11-11T06:00:00.000Z");
    expect(screen.getByRole("textbox", { name: "Notizinhalt" })).toBeInTheDocument();
  });

  it("shows a remote version only when nothing is pending", async () => {
    const { store } = renderApp({ path: "/notes/a", notes: [makeNote("a", "Alt")] });
    const title = (await screen.findByLabelText("Titel der Notiz")) as HTMLInputElement;
    fireEvent.change(title, { target: { value: "Lokal" } });
    act(() => store.seedNote(makeNote("a", "Remote")));
    await new Promise((r) => setTimeout(r, 50));
    expect(title.value).toBe("Lokal");
    await waitFor(() => expect(store.saveCount).toBe(1), { timeout: 2000 });
    await new Promise((r) => setTimeout(r, 20));
    act(() => store.seedNote(makeNote("a", "Remote 2")));
    await waitFor(() => expect((screen.getByLabelText("Titel der Notiz") as HTMLInputElement).value).toBe("Remote 2"));
  });

  it("changes the colour and deletes after confirmation", async () => {
    const { store, history } = renderApp({ path: "/notes/a", notes: [makeNote("a", "Weg damit")] });
    await userEvent.click(await screen.findByRole("button", { name: "Farbe Blau" }));
    await waitFor(async () => expect((await store.getNote("a"))?.color).toBe("blue"));
    await userEvent.click(screen.getByRole("button", { name: "Notiz „Weg damit“ löschen" }));
    await userEvent.click(screen.getByRole("button", { name: "Ja, Notiz löschen" }));
    await waitFor(() => expect(history.path()).toBe("/"));
    expect(await store.getNote("a")).toBeNull();
  });
});

describe("reminders in another zone", () => {
  // 09:00 Berlin = 08:00Z = 03:00 New York; device in New York
  it("shows device time with the original zone and edits in the reminder zone", async () => {
    const { store } = renderApp({
      path: "/notes/a",
      notes: [makeNote("a", "Meeting")],
      reminders: [makeReminder("a", { repeat: "daily" })],
      deviceZone: "America/New_York",
    });
    const button = await screen.findByRole("button", { name: "Erinnerung ändern" });
    expect(button).toHaveTextContent("Erinnerung: Heute, 03:00 (09:00 Berlin)");
    await userEvent.click(button);
    const dialog = screen.getByRole("dialog", { name: "Erinnerung ändern" });
    expect(within(dialog).getByLabelText("Uhrzeit der Erinnerung")).toHaveValue("09:00");
    expect(within(dialog).getByText("Zeitzone: Europe/Berlin")).toBeInTheDocument();
    expect(within(dialog).getByText(/Bei dir: Heute, 03:00/)).toBeInTheDocument();

    fireEvent.change(within(dialog).getByLabelText("Uhrzeit der Erinnerung"), { target: { value: "10:00" } });
    await userEvent.click(within(dialog).getByRole("button", { name: "Erinnerung speichern" }));
    const r = await store.getReminder("a");
    expect(r?.at).toBe("2026-11-11T09:00:00.000Z");
    expect(r?.timeZone).toBe("Europe/Berlin");
    expect(r?.repeat).toBe("daily");
  });

  it("switching the zone gives a new instant (Asia/Tokyo)", async () => {
    const { store } = renderApp({
      path: "/notes/a",
      notes: [makeNote("a", "Call")],
      reminders: [makeReminder("a")],
      deviceZone: "America/New_York",
    });
    await userEvent.click(await screen.findByRole("button", { name: "Erinnerung ändern" }));
    await userEvent.click(screen.getByRole("button", { name: "Zeitzone Europe/Berlin ändern" }));
    await userEvent.selectOptions(screen.getByLabelText("Zeitzone"), "Asia/Tokyo");
    fireEvent.change(screen.getByLabelText("Datum der Erinnerung"), { target: { value: "2026-11-12" } });
    await userEvent.click(screen.getByRole("button", { name: "Erinnerung speichern" }));
    const r = await store.getReminder("a");
    expect(r?.timeZone).toBe("Asia/Tokyo");
    expect(r?.at).toBe("2026-11-12T00:00:00.000Z"); // 09:00 Tokyo
  });

  it("new reminders default to the device zone and the next full hour", async () => {
    const { store } = renderApp({ path: "/notes/a", notes: [makeNote("a", "Neu")], deviceZone: "Asia/Kolkata" });
    await userEvent.click(await screen.findByRole("button", { name: "Erinnerung setzen" }));
    const dialog = screen.getByRole("dialog", { name: "Erinnerung setzen" });
    // now = 06:00Z = 11:30 Kolkata → next full hour 12:00
    expect(within(dialog).getByLabelText("Uhrzeit der Erinnerung")).toHaveValue("12:00");
    expect(within(dialog).getByText("Zeitzone: Asia/Kolkata")).toBeInTheDocument();
    expect(within(dialog).queryByText(/Bei dir/)).toBeNull();
    await userEvent.click(within(dialog).getByRole("button", { name: "Erinnerung speichern" }));
    expect((await store.getReminder("a"))?.at).toBe("2026-11-11T06:30:00.000Z");
  });

  it("due banner: „Erledigt“ moves a daily reminder to the next day 09:00 Berlin, „10 Min. später“ snoozes", async () => {
    const { store } = renderApp({
      notes: [makeNote("a", "Tabletten"), makeNote("b", "Pflanzen")],
      reminders: [
        makeReminder("a", { repeat: "daily", state: "due", at: "2026-11-11T05:00:00.000Z" }),
        makeReminder("b", { state: "due", at: "2026-11-11T05:30:00.000Z" }),
      ],
      deviceZone: "America/New_York",
    });
    const banner = await screen.findByRole("region", { name: "Fällige Erinnerungen" });
    expect(within(banner).getByText("2 fällige Erinnerungen")).toBeInTheDocument();
    expect(within(banner).getByText("Heute, 00:00 (06:00 Berlin)")).toBeInTheDocument();
    await userEvent.click(within(banner).getByRole("button", { name: "Erinnerung „Tabletten“ erledigt" }));
    const a = await store.getReminder("a");
    expect(a?.at).toBe("2026-11-12T05:00:00.000Z");
    expect(a?.state).toBe("scheduled");
    await userEvent.click(within(banner).getByRole("button", { name: "Erinnerung „Pflanzen“ 10 Minuten später" }));
    expect((await store.getReminder("b"))?.at).toBe("2026-11-11T06:10:00.000Z");
    await waitFor(() => expect(screen.queryByRole("region", { name: "Fällige Erinnerungen" })).toBeNull());
  });

  it("the UI timer marks a reached reminder due", async () => {
    const { store, notifier } = renderApp({
      notes: [makeNote("a", "Jetzt")],
      reminders: [makeReminder("a", { at: "2026-11-11T05:59:00.000Z" })],
    });
    await waitFor(async () => expect((await store.getReminder("a"))?.state).toBe("due"));
    expect(await screen.findByRole("region", { name: "Fällige Erinnerungen" })).toBeInTheDocument();
    await waitFor(() =>
      expect(notifier?.syncDue).toHaveBeenLastCalledWith([expect.objectContaining({ state: "due" })], ["a"]),
    );
  });
});

describe("install and update", () => {
  it("shows an install button after beforeinstallprompt (Chromium)", async () => {
    const target = new EventTarget();
    const install = createInstallController({ platform: () => ({ userAgent: CHROME, displayStandalone: false }), target });
    renderApp({ path: "/setup", install });
    expect((await screen.findAllByText(/Browser-Menü/)).length).toBeGreaterThan(0);
    const e = Object.assign(new Event("beforeinstallprompt", { cancelable: true }), {
      prompt: vi.fn(async () => undefined),
      userChoice: Promise.resolve({ outcome: "accepted" as const }),
    });
    act(() => {
      target.dispatchEvent(e);
    });
    await userEvent.click(await screen.findByRole("button", { name: "App installieren" }));
    expect(e.prompt).toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("region", { name: "App installieren" })).toBeNull());
  });

  it("shows the home-screen guide on iOS and the needs-install hint for notifications", async () => {
    const install = createInstallController({
      platform: () => ({ userAgent: IPHONE, displayStandalone: false, iosStandalone: false }),
      target: new EventTarget(),
    });
    renderApp({ path: "/setup", install, notifier: createFakeNotifier("needsInstall") });
    expect(await screen.findByText(/„Zum Home-Bildschirm“ wählen/)).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Zuerst zum Home-Bildschirm hinzufügen" })).toBeDisabled();
  });

  it("update banner waits for pending saves, flushes and updates", async () => {
    const update = { needRefresh: true, update: vi.fn(async () => undefined), dismiss: vi.fn() };
    const { store } = renderApp({ path: "/notes/a", notes: [makeNote("a", "Alt")], update });
    expect(await screen.findByRole("region", { name: "Update verfügbar" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Titel der Notiz"), { target: { value: "Tippen" } });
    expect(screen.queryByRole("region", { name: "Update verfügbar" })).toBeNull();
    await waitFor(() => expect(store.saveCount).toBe(1), { timeout: 2000 });
    const banner = await screen.findByRole("region", { name: "Update verfügbar" });
    await userEvent.click(within(banner).getByRole("button", { name: "Jetzt aktualisieren" }));
    expect(update.update).toHaveBeenCalled();
    await userEvent.click(within(banner).getByRole("button", { name: "Später aktualisieren" }));
    expect(update.dismiss).toHaveBeenCalled();
  });
});

describe("settings, notifications, status", () => {
  it("enables notifications from the click and sends a test", async () => {
    const notifier = createFakeNotifier();
    renderApp({ path: "/settings", notifier });
    await userEvent.click(await screen.findByRole("button", { name: "Benachrichtigungen aktivieren" }));
    expect(notifier.enable).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("Benachrichtigungen sind aktiv.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Testbenachrichtigung senden" }));
    expect(notifier.test).toHaveBeenCalled();
    expect(await screen.findByText("Testbenachrichtigung gesendet.")).toBeInTheDocument();
  });

  it("settings follow a status change the notifier reports by itself (permission answered)", async () => {
    const base = createFakeNotifier("available");
    let listener: (() => void) | null = null;
    const notifier = {
      ...base,
      subscribe: (l: () => void) => {
        listener = l;
        return () => {
          listener = null;
        };
      },
    };
    renderApp({ path: "/settings", notifier });
    expect(await screen.findByRole("button", { name: "Benachrichtigungen aktivieren" })).toBeInTheDocument();
    base.status.mockResolvedValue({ state: "enabled" });
    act(() => listener?.());
    expect(await screen.findByText("Benachrichtigungen sind aktiv.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Benachrichtigungen aktivieren" })).not.toBeInTheDocument();
  });

  it("reconciles the push subscription at start", async () => {
    const notifier = createFakeNotifier("enabled");
    renderApp({ notifier });
    await waitFor(() => expect(notifier.reconcile).toHaveBeenCalled());
  });

  it("status bar: offline with waiting changes, clock warning, sync now", async () => {
    const { sync, store } = renderApp({ notes: [makeNote("a", "x")] });
    await store.saveNote(makeNote("a", "y"));
    act(() => sync.setStatus({ state: "offline", clockOffsetMs: 10 * 60_000 }));
    const status = await screen.findByRole("contentinfo", { name: "Synchronisationsstatus" });
    await waitFor(() => expect(status).toHaveTextContent("Offline – 1 Änderung wartet"));
    expect(status).toHaveTextContent("Die Uhr dieses Geräts geht 10 Min. nach.");
    await userEvent.click(within(status).getByRole("button", { name: "Jetzt synchronisieren" }));
    expect(sync.calls).toContain("syncNow");
  });

  it("status bar: „Änderung wartet“ disappears after a sync that emptied the outbox (no data event)", async () => {
    const { sync, store } = renderApp({ notes: [makeNote("a", "x")] });
    await store.saveNote(makeNote("a", "y"));
    act(() => sync.setStatus({ state: "idle" }));
    const status = await screen.findByRole("contentinfo", { name: "Synchronisationsstatus" });
    await waitFor(() => expect(status).toHaveTextContent("1 Änderung wartet"));
    // the sync engine pushed: outbox empty, engine reports pending 0, the store emits nothing
    store.clearOutbox();
    act(() => sync.setStatus({ state: "idle", pending: 0, lastSyncAt: new Date().toISOString() }));
    await waitFor(() => expect(status).toHaveTextContent("Synchronisiert"));
    expect(status).not.toHaveTextContent("wartet");
  });

  it("asks before signing out with pending changes and clears local data", async () => {
    const notifier = createFakeNotifier("enabled");
    const { store, history, sync } = renderApp({ path: "/settings", notes: [makeNote("a", "x")], notifier });
    await store.saveNote(makeNote("a", "y"));
    expect(await screen.findByText(`Angemeldet als`, { exact: false })).toHaveTextContent(ACCOUNT.username);
    await userEvent.click(screen.getByRole("button", { name: "Abmelden" }));
    expect(await screen.findByText(/1 Änderung wurde noch nicht übertragen/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Trotzdem abmelden" }));
    await waitFor(() => expect(history.path()).toBe("/login"));
    expect(notifier.disable).toHaveBeenCalled();
    expect(sync.calls).toContain("logout");
    expect(await store.getAccount()).toBeNull();
    expect(await store.listNotes()).toEqual([]);
  });

  it("shows sync notices and leaves a note deleted remotely", async () => {
    const { sync, history } = renderApp({ path: "/notes/a", notes: [makeNote("a", "x")] });
    await screen.findByLabelText("Titel der Notiz");
    act(() => sync.notice({ kind: "remoteDeleted", id: "a" }));
    expect(await screen.findByText("Diese Notiz wurde auf einem anderen Gerät gelöscht.")).toBeInTheDocument();
    await waitFor(() => expect(history.path()).toBe("/"));
  });
});
