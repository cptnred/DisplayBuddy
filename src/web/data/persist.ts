/**
 * Persistent storage request after login (PLAN_V3_SYNC §9.2; MDN StorageManager.persist(),
 * "Storage quotas and eviction criteria"). Optional everywhere: missing API → false.
 * Treated as optional (not verified against browser-compat-data here); the browser
 * decides whether to grant it.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  const storage = (globalThis.navigator as { storage?: StorageManager } | undefined)?.storage;
  try {
    if (!storage?.persist) return false;
    if (storage.persisted && (await storage.persisted())) return true;
    return await storage.persist();
  } catch {
    return false;
  }
}
