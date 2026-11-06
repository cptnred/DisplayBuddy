/**
 * Persistent storage request after login (PLAN_V3_SYNC §9.2; MDN StorageManager.persist(),
 * "Storage quotas and eviction criteria"). Optional everywhere: missing API → false.
 * Chrome Android and Safari iOS ≥ 15.2 support it per browser-compat-data; the
 * browser decides (Chromium heuristics, Safari: installed web apps).
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
