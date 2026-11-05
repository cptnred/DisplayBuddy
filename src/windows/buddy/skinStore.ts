import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import type { SkinData, SkinInfo } from "../../types";

/**
 * Per-window cache of imported skins (`load_skin` results), keyed by id.
 * Skin files never change under the same id, so `skins-changed` only drops ids that no longer
 * exist (deleted) and lets subscribers retry ids that failed or were unknown before.
 */
export type SkinLoader = (id: string) => Promise<SkinData>;

const cache = new Map<string, Promise<SkinData>>();
const subscribers = new Set<() => void>();
let unlisten: Promise<(() => void) | undefined> | null = null;

function onSkinsChanged(list: SkinInfo[]) {
  const alive = new Set(list.map((s) => s.id));
  for (const id of [...cache.keys()]) if (!alive.has(id)) cache.delete(id);
  subscribers.forEach((cb) => cb());
}

/** Subscribe to `skins-changed` (one shared listener per window). Returns the unsubscribe fn. */
export function subscribeSkins(cb: () => void): () => void {
  subscribers.add(cb);
  if (!unlisten) {
    unlisten = api.onSkinsChanged(onSkinsChanged).catch((err) => {
      console.warn("[buddy] onSkinsChanged failed:", err);
      return undefined;
    });
  }
  return () => {
    subscribers.delete(cb);
    if (subscribers.size === 0 && unlisten) {
      const u = unlisten;
      unlisten = null;
      void u.then((fn) => fn?.());
    }
  };
}

/** Cached load; failed loads are not cached so a later attempt can retry. */
export function getSkin(id: string, loader: SkinLoader = api.loadSkin): Promise<SkinData> {
  let p = cache.get(id);
  if (!p) {
    p = loader(id);
    cache.set(id, p);
    p.catch(() => {
      if (cache.get(id) === p) cache.delete(id);
    });
  }
  return p;
}

/** Test helper: forget all cached skins and listeners. */
export function resetSkinCache() {
  cache.clear();
  subscribers.clear();
  unlisten = null;
}

export type SkinLoadState =
  | { status: "loading" }
  | { status: "ready"; data: SkinData }
  | { status: "error"; error: unknown };

/** Loads an imported skin (cached), re-checking after every `skins-changed`. */
export function useSkinData(id: string | null, loader?: SkinLoader): SkinLoadState {
  const [version, setVersion] = useState(0);
  const [result, setResult] = useState<{ id: string; state: SkinLoadState } | null>(null);

  useEffect(() => subscribeSkins(() => setVersion((v) => v + 1)), []);

  useEffect(() => {
    if (!id) return;
    let alive = true;
    getSkin(id, loader).then(
      (data) => alive && setResult({ id, state: { status: "ready", data } }),
      (error) => alive && setResult({ id, state: { status: "error", error } }),
    );
    return () => {
      alive = false;
    };
  }, [id, version, loader]);

  return result && result.id === id ? result.state : { status: "loading" };
}
