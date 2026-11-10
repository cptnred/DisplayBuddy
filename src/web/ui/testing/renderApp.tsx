/** Test helpers: renders the web UI against the in-memory fakes. */
import { render } from "@testing-library/react";
import { vi } from "vitest";
import { createClock } from "../../../lib/clock";
import type { ServerInfo } from "../../../lib/sync/types";
import type { Note, Reminder } from "../../../types";
import type { Account, QrScanner, ServerSelector } from "../../contract";
import type { InstallController, Notifier, NotifierStatus, StorageController } from "../../notify/types";
import { App } from "../App";
import { memoryHistory } from "../router";
import type { Services, UpdateState } from "../services";
import { createFakeStore } from "./fakeStore";
import { createFakeHttp, createFakeSync } from "./fakeSync";

export const NOW = Date.parse("2026-11-11T06:00:00.000Z");

export const ACCOUNT: Account = {
  username: "anna",
  deviceId: "dev-1",
  serverUrl: "https://buddy.test",
  timeZone: "Europe/Berlin",
};

export function makeNote(id: string, title: string, text = "", patch: Partial<Note> = {}): Note {
  return {
    id,
    title,
    color: "yellow",
    content: {
      type: "doc",
      content: [{ type: "paragraph", content: text ? [{ type: "text", text }] : undefined }],
    },
    createdAt: "2026-11-01T10:00:00.000Z",
    updatedAt: "2026-11-01T10:00:00.000Z",
    schemaVersion: 1,
    ...patch,
  };
}

export function makeReminder(noteId: string, patch: Partial<Reminder> = {}): Reminder {
  return {
    noteId,
    at: "2026-11-11T08:00:00.000Z",
    repeat: "none",
    state: "scheduled",
    firedAt: null,
    updatedAt: "2026-11-01T10:00:00.000Z",
    timeZone: "Europe/Berlin",
    ...patch,
  };
}

export function createFakeNotifier(initial: NotifierStatus["state"] = "available") {
  let state: NotifierStatus = { state: initial };
  const n = {
    kind: "pwa" as const,
    status: vi.fn(async () => state),
    enable: vi.fn(async () => {
      state = { state: "enabled" };
      return state;
    }),
    disable: vi.fn(async () => {
      state = { state: "available" };
      return state;
    }),
    test: vi.fn(async () => undefined),
    reconcile: vi.fn(async () => state),
    syncDue: vi.fn(async () => undefined),
  } satisfies Notifier;
  return n;
}

export interface RenderOptions {
  path?: string;
  account?: Account | null;
  notes?: Note[];
  reminders?: Reminder[];
  deviceZone?: string;
  now?: number;
  update?: UpdateState | null;
  notifier?: Notifier | null;
  install?: InstallController | null;
  storage?: StorageController | null;
  scanner?: QrScanner | null;
  server?: ServerSelector | null;
  /** GET /info answer of the fake engine. */
  info?: ServerInfo | null;
}

export function renderApp(opts: RenderOptions = {}) {
  const zone = opts.deviceZone ?? "Europe/Berlin";
  const store = createFakeStore({
    clock: createClock(() => opts.now ?? NOW),
    account: opts.account === undefined ? ACCOUNT : opts.account,
    notes: opts.notes ?? [],
    reminders: opts.reminders ?? [],
    deviceZone: () => zone,
  });
  const sync = createFakeSync({ store, http: createFakeHttp() });
  if (opts.account !== null) sync.setStatus({ state: "idle" });
  sync.info = opts.info ?? null;
  const history = memoryHistory(opts.path ?? "/");
  const notifier = opts.notifier === undefined ? createFakeNotifier() : opts.notifier;
  let ids = 0;
  const services: Services = {
    store,
    sync,
    notifier,
    install: opts.install ?? null,
    storage: opts.storage ?? null,
    deviceZone: () => zone,
    newId: () => `new-${++ids}`,
    defaultDeviceName: () => "Testgerät",
    scanner: opts.scanner ?? null,
    server: opts.server ?? null,
  };
  const utils = render(<App services={services} history={history} update={opts.update ?? null} />);
  return { ...utils, store, sync, history, services, notifier };
}
