/** Web data layer (PLAN_V3_SYNC §9.2). Contract: src/web/contract.ts. */
import type { OpenDataStore } from "../contract";
import { openDataStore as open } from "./store";

export const openDataStore: OpenDataStore = open;
export { BROADCAST_CHANNEL, syncAccess, type ApplyOutcome, type SyncAccess } from "./store";
export { DB_VERSION, DEFAULT_DB_NAME, type OutboxEntry } from "./db";
export { requestPersistentStorage } from "./persist";
