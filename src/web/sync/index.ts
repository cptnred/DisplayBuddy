/** Web sync engine + platform HTTP adapters (PLAN_V3_SYNC §9.3). Contract: src/web/contract.ts. */
export {
  BACKGROUND_SYNC_TAG,
  BACKOFF_MS,
  CHANGE_DEBOUNCE_MS,
  createSyncEngine,
  LOCK_NAME,
  PULL_LIMIT,
  SyncError,
  type SyncErrorCode,
  VISIBLE_INTERVAL_MS,
} from "./engine";
export {
  createNativeHttp,
  createWebHttp,
  NetworkError,
  type NativeHttpOptions,
  type OriginHttpAdapter,
  type WebHttpOptions,
} from "./http";
