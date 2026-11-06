/**
 * Notifier of the native shell: local planning of all synced reminders (PLAN_V3_SYNC
 * §10.3). Reminders ring at their absolute `at` even offline and with the app closed.
 *
 * - Re-plans after every sync, every local change, at start and on resume (the entry
 *   point wires sync status and the resume event to {@link NativeNotifier.replan}; data
 *   changes are observed here). Runs are serialised and coalesced.
 * - Each run: diff of the wanted plan (≤ 60 nearest) against `pending()` → `cancel` +
 *   schedule; delivered notifications of resolved occurrences → `removeActive`.
 * - Buttons „Erledigt“ / „10 Min. später“ act through the data layer (corrected time,
 *   outbox, works offline); the data change triggers the sync and the next plan.
 * - deviceState `{scheduledSeq, localNotifications}` for `/sync/push`: the cursor read
 *   BEFORE the reminders, so it never claims more than was planned (§7.4, D-48).
 *
 * No platform globals: plugin, store, cursor, zone and preferences are injected.
 */
import type { DeviceState } from "../../lib/sync/types";
import { formatWallTime, instantToWall, zoneLabel } from "../../lib/zoned";
import type { Reminder } from "../../types";
import type { DataStore, SyncEngine } from "../contract";
import {
  ACTION_ACK,
  ACTION_SNOOZE,
  diffPlan,
  planReminders,
  reminderForNotification,
  resolvedActive,
  SNOOZE_MINUTES,
  TEST_NOTIFICATION_ID,
} from "./native-plan";
import type { ActionEvent, NativePermission, NotificationPlugin } from "./native-plugin";
import type { Notifier, NotifierStatus } from "./types";

/** Lead time of the „in 2 min erinnern“ check (§10.4). */
export const TIMING_CHECK_MS = 2 * 60_000;
/** A failed schedule this close to `at` is harmless: the reminder is due anyway. */
const PAST_GRACE_MS = 5_000;

export type ReplanReason = "start" | "resume" | "sync" | "change" | "action" | "enable" | "disable";

/** Device preference „Benachrichtigungen ein/aus“ (null = never decided → on if permitted). */
export interface NativePrefs {
  enabled(): boolean | null;
  setEnabled(on: boolean): void;
}

export interface NativeNotifierDeps {
  store: DataStore;
  /** Sync cursor of the data layer (`syncAccess(store).getCursor`). */
  getCursor(): Promise<number>;
  plugin: NotificationPlugin;
  deviceZone(): string;
  prefs: NativePrefs;
  /** deviceState changed → the entry asks the sync engine to report it. */
  onDeviceState?(state: DeviceState): void;
  /** Tap on a reminder notification → open the note. */
  onOpenNote?(noteId: string): void;
  /** Diagnostics (never note content or tokens). */
  log?(message: string): void;
}

export interface TimingCheck {
  /** Planned instant (UTC) and the device zone at planning time. */
  plannedFor: string;
  deviceZone: string;
  /** The test notification was found in pending() right after scheduling. */
  pendingFound: boolean;
  /** Delivery seen in the foreground (null until then / app was in the background). */
  deliveredAt: string | null;
  /** deliveredAt − plannedFor in ms. */
  deviationMs: number | null;
}

export interface PlanReport {
  planned: number;
  cancelled: number;
  scheduled: number;
  failed: number;
  removedActive: number;
  truncated: number;
}

export interface NativeNotifier extends Notifier {
  readonly kind: "native";
  /** Registers channel/actions and listeners, then plans. Idempotent. */
  start(): Promise<void>;
  stop(): void;
  /** Re-plans now (coalesced with a running plan). */
  replan(reason: ReplanReason): Promise<void>;
  /** For SyncEngineOptions.deviceState (null until the first plan finished). */
  deviceState(): DeviceState | null;
  /** §10.4: plans a test notification in 2 min and compares with pending(). */
  checkTiming(): Promise<TimingCheck>;
  lastTimingCheck(): TimingCheck | null;
  lastReport(): PlanReport | null;
}

/**
 * Re-plans after every finished sync (the cursor may move without a data change) – PLAN
 * §10.3 „nach jedem Sync“. Returns the unsubscribe function.
 */
export function followSync(notifier: Pick<NativeNotifier, "replan">, sync: Pick<SyncEngine, "onStatus" | "status">): () => void {
  let last = sync.status().lastSyncAt;
  return sync.onStatus((s) => {
    if (s.state === "idle" && s.lastSyncAt && s.lastSyncAt !== last) {
      last = s.lastSyncAt;
      void notifier.replan("sync");
    }
  });
}

function sameState(a: DeviceState | null, b: DeviceState | null): boolean {
  return !!a && !!b && a.scheduledSeq === b.scheduledSeq && a.localNotifications === b.localNotifications;
}

export function createNativeNotifier(deps: NativeNotifierDeps): NativeNotifier {
  const { store, plugin } = deps;
  const log = deps.log ?? (() => undefined);
  let state: DeviceState | null = null;
  let report: PlanReport | null = null;
  let timing: TimingCheck | null = null;
  let running: Promise<void> | null = null;
  let again = false;
  let started = false;
  let setupDone = false;
  const cleanups: (() => void)[] = [];

  async function permission(): Promise<NativePermission> {
    try {
      return await plugin.permission();
    } catch {
      return "prompt";
    }
  }

  function setState(next: DeviceState): void {
    if (sameState(next, state)) return;
    state = next;
    deps.onDeviceState?.(next);
  }

  async function planOnce(): Promise<void> {
    // signed out (or the database is gone): nothing of the old account may ring
    const account = await store.getAccount().catch(() => null);
    if (!account) {
      const ours = (await plugin.pending()).map((p) => p.id).filter((id) => id !== TEST_NOTIFICATION_ID);
      if (ours.length) await plugin.cancel(ours);
      report = { planned: 0, cancelled: ours.length, scheduled: 0, failed: 0, removedActive: 0, truncated: 0 };
      state = null;
      return;
    }
    // cursor first: the plan below covers at least everything up to it
    const seq = await deps.getCursor();
    const [reminders, notes] = await Promise.all([store.listReminders(), store.listNotes()]);
    const pref = deps.prefs.enabled();
    const perm = await permission();
    const pendingList = await plugin.pending();

    if (pref === false || perm !== "granted") {
      const ours = pendingList.map((p) => p.id).filter((id) => id !== TEST_NOTIFICATION_ID);
      if (ours.length && perm === "granted") await plugin.cancel(ours);
      report = { planned: 0, cancelled: ours.length, scheduled: 0, failed: 0, removedActive: 0, truncated: 0 };
      setState({ scheduledSeq: seq, localNotifications: "denied" });
      return;
    }

    const now = store.clock.correctedNow();
    const plan = planReminders({ reminders, notes, now, deviceZone: deps.deviceZone() });
    const diff = diffPlan(plan.notifications, pendingList);
    if (diff.cancel.length) await plugin.cancel(diff.cancel);
    let failed = 0;
    for (const n of diff.schedule) {
      try {
        await plugin.schedule({
          id: n.id,
          title: n.title,
          body: n.body,
          atMs: n.atMs,
          actions: true,
          extra: { noteId: n.noteId, at: n.at },
        });
      } catch (e) {
        if (n.atMs > store.clock.correctedNow() + PAST_GRACE_MS) {
          failed++;
          log(`schedule failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
    let removed: number[] = [];
    try {
      removed = resolvedActive(await plugin.active(), reminders);
      if (removed.length) await plugin.removeActive(removed);
    } catch {
      // active()/removeActive are best effort (closing resolved notifications)
    }
    report = {
      planned: plan.notifications.length,
      cancelled: diff.cancel.length,
      scheduled: diff.schedule.length - failed,
      failed,
      removedActive: removed.length,
      truncated: plan.truncated,
    };
    // a failed schedule must not be claimed as planned: keep the previous sequence
    const scheduledSeq = failed ? Math.min(state?.scheduledSeq ?? 0, seq) : seq;
    setState({ scheduledSeq, localNotifications: "granted" });
  }

  function replan(reason: ReplanReason): Promise<void> {
    if (running) {
      again = true;
      return running;
    }
    const run = (async () => {
      do {
        again = false;
        try {
          await planOnce();
        } catch (e) {
          // store closed (sign-out), plugin unavailable … the next trigger retries
          log(`plan (${reason}) failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      } while (again);
    })().finally(() => {
      running = null;
    });
    running = run;
    return run;
  }

  async function onAction(e: ActionEvent): Promise<void> {
    if (e.id === TEST_NOTIFICATION_ID) return;
    let reminders: Reminder[];
    try {
      reminders = await store.listReminders();
    } catch {
      return;
    }
    // Android reports the extra; iOS only the id → look the occurrence up by its id
    const extraNote = typeof e.extra?.noteId === "string" ? e.extra.noteId : null;
    const extraAt = typeof e.extra?.at === "string" ? e.extra.at : null;
    let target: Reminder | null = null;
    if (extraNote && extraAt) {
      const r = reminders.find((x) => x.noteId === extraNote) ?? null;
      target = r && r.at === extraAt ? r : r && e.id !== null ? reminderForNotification(e.id, [r]) : null;
    } else if (e.id !== null) {
      target = reminderForNotification(e.id, reminders);
    }
    if (e.actionId === "tap") {
      const noteId = target?.noteId ?? extraNote;
      if (noteId) deps.onOpenNote?.(noteId);
      return;
    }
    // only the occurrence the notification was for (not a newer one set meanwhile)
    if (!target || (target.state !== "scheduled" && target.state !== "due")) return;
    try {
      if (e.actionId === ACTION_ACK) await store.ackReminder(target.noteId);
      else if (e.actionId === ACTION_SNOOZE) await store.snoozeReminder(target.noteId, SNOOZE_MINUTES);
      else return;
    } catch (err) {
      log(`action failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    await replan("action");
  }

  function onReceived(id: number): void {
    if (id !== TEST_NOTIFICATION_ID || !timing || timing.deliveredAt) return;
    const now = store.clock.correctedNow();
    const planned = Date.parse(timing.plannedFor);
    timing = { ...timing, deliveredAt: new Date(now).toISOString(), deviationMs: now - planned };
    const seconds = Math.round((now - planned) / 1000);
    const ok = Math.abs(seconds) <= 60;
    void plugin
      .schedule({
        id: TEST_NOTIFICATION_ID - 1,
        title: ok ? "Zeitplanung stimmt" : "Zeitplanung weicht ab",
        body: `Abweichung ${seconds >= 0 ? "+" : ""}${seconds} s (Zone ${zoneLabel(timing.deviceZone)})`,
        atMs: null,
        actions: false,
      })
      .catch(() => undefined);
    log(`timing check: deviation ${seconds} s`);
  }

  async function status(): Promise<NotifierStatus> {
    const perm = await permission();
    if (perm === "denied") return { state: "denied" };
    if (perm === "prompt" || deps.prefs.enabled() === false) return { state: "available" };
    return { state: "enabled" };
  }

  const notifier: NativeNotifier = {
    kind: "native",

    async start() {
      if (!setupDone) {
        setupDone = true;
        try {
          await plugin.setup();
        } catch (e) {
          log(`notification setup failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      if (started) return replan("start");
      started = true;
      cleanups.push(
        store.subscribe((c) => {
          if (c.kind === "reminders" || c.kind === "notes" || c.kind === "all" || c.kind === "account") {
            void replan("change");
          }
        }),
      );
      try {
        cleanups.push(await plugin.onAction((e) => void onAction(e)));
        cleanups.push(await plugin.onReceived(onReceived));
      } catch (e) {
        log(`notification listeners failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      await replan("start");
    },

    stop() {
      started = false;
      for (const c of cleanups.splice(0)) c();
    },

    replan,

    deviceState: () => (state ? { ...state } : null),

    status,

    enable(): Promise<NotifierStatus> {
      // request first (before any await), as the Notifier contract asks for
      const asked = plugin.requestPermission().catch(() => "denied" as NativePermission);
      deps.prefs.setEnabled(true);
      return asked.then(async () => {
        await replan("enable");
        return status();
      });
    },

    async disable() {
      deps.prefs.setEnabled(false);
      await replan("disable");
      return status();
    },

    async test() {
      const check = await notifier.checkTiming();
      if (!check.pendingFound) throw new Error("test notification not pending");
    },

    async checkTiming() {
      const zone = deps.deviceZone();
      const atMs = Math.ceil((store.clock.correctedNow() + TIMING_CHECK_MS) / 1000) * 1000;
      const local = formatWallTime(instantToWall(atMs, zone));
      await plugin.cancel([TEST_NOTIFICATION_ID]).catch(() => undefined);
      await plugin.schedule({
        id: TEST_NOTIFICATION_ID,
        title: "Testbenachrichtigung",
        body: `Geplant für ${local} Uhr (${zoneLabel(zone)}). Kommt sie pünktlich, stimmt die Zeitplanung.`,
        atMs,
        actions: false,
      });
      const pendingList = await plugin.pending();
      timing = {
        plannedFor: new Date(atMs).toISOString(),
        deviceZone: zone,
        pendingFound: pendingList.some((p) => p.id === TEST_NOTIFICATION_ID),
        deliveredAt: null,
        deviationMs: null,
      };
      return { ...timing };
    },

    lastTimingCheck: () => (timing ? { ...timing } : null),
    lastReport: () => (report ? { ...report } : null),

    async reconcile() {
      await notifier.start();
      return status();
    },

    async syncDue() {
      // the reminder list changed in the UI: same diff as after a sync (cheap when equal)
      await replan("change");
    },
  };
  return notifier;
}
