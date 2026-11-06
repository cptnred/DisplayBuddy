/**
 * IndexedDB schema of the web data layer (PLAN_V3_SYNC §9.2), via `idb`.
 *
 * Stores: `notes` (key `id`, sync records incl. tombstones), `reminders` (key `noteId`,
 * sync records incl. tombstones), `meta` (out-of-line keys, see {@link MetaValues}),
 * `outbox` (key `"<kind>:<id>"`, only the latest version per document).
 *
 * Opening follows the idb README (`openDB(name, version, { upgrade, blocking })`); we
 * call `factory.open` + `wrap` ourselves only so that the IDBFactory can be injected
 * (tests: fake-indexeddb; a native shell could pass its own). No DOM access.
 */
import { type DBSchema, type IDBPDatabase, type IDBPTransaction, wrap } from "idb";
import type { NoteRecord, OrderRecord, RecordKind, ReminderRecord } from "../../lib/sync/types";
import type { Account } from "../contract";

export const DB_VERSION = 1;
export const DEFAULT_DB_NAME = "display-buddy";

export type OutboxEntry =
  | { key: string; kind: "note"; id: string; record: NoteRecord }
  | { key: string; kind: "reminder"; id: string; record: ReminderRecord }
  | { key: string; kind: "order"; id: "order"; record: OrderRecord };

export function outboxKey(kind: RecordKind, id: string): string {
  return `${kind}:${id}`;
}

/** Typed values of the `meta` store. */
export interface MetaValues {
  /** Id stamped into `updatedBy`: random until the first login, then the server's device id. */
  deviceId: string;
  account: Account;
  cursor: number;
  order: OrderRecord;
  /** Last offset samples (oldest first, src/lib/clock.ts). */
  clockOffsets: number[];
  lastSyncAt: string;
  /** Result of navigator.storage.persist() after login. */
  persisted: boolean;
}
export type MetaKey = keyof MetaValues;

export interface BuddyDB extends DBSchema {
  notes: { key: string; value: NoteRecord };
  reminders: { key: string; value: ReminderRecord };
  meta: { key: MetaKey; value: MetaValues[MetaKey] };
  outbox: { key: string; value: OutboxEntry };
}

export type BuddyDatabase = IDBPDatabase<BuddyDB>;
export const ALL_STORES = ["notes", "reminders", "meta", "outbox"] as const;
export type WriteTx = IDBPTransaction<BuddyDB, typeof ALL_STORES, "readwrite">;

export async function getMeta<K extends MetaKey>(
  tx: { objectStore(name: "meta"): { get(key: MetaKey): Promise<unknown> } },
  key: K,
): Promise<MetaValues[K] | undefined> {
  return (await tx.objectStore("meta").get(key)) as MetaValues[K] | undefined;
}

function upgrade(db: BuddyDatabase, oldVersion: number): void {
  if (oldVersion < 1) {
    db.createObjectStore("notes", { keyPath: "id" });
    db.createObjectStore("reminders", { keyPath: "noteId" });
    db.createObjectStore("meta");
    db.createObjectStore("outbox", { keyPath: "key" });
  }
}

export interface OpenHooks {
  /** Another connection wants to upgrade/delete the database: we must close. */
  onVersionChange(): void;
  /** The browser closed the connection unexpectedly. */
  onClose(): void;
}

export async function openBuddyDb(factory: IDBFactory, name: string, hooks: OpenHooks): Promise<BuddyDatabase> {
  const request = factory.open(name, DB_VERSION);
  request.addEventListener("upgradeneeded", (event) => {
    upgrade(wrap(request.result) as unknown as BuddyDatabase, event.oldVersion);
  });
  const db = (await wrap(request)) as unknown as BuddyDatabase;
  db.addEventListener("versionchange", () => {
    db.close();
    hooks.onVersionChange();
  });
  db.addEventListener("close", () => hooks.onClose());
  return db;
}

export async function deleteBuddyDb(factory: IDBFactory, name: string): Promise<void> {
  await wrap(factory.deleteDatabase(name));
}
