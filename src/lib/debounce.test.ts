import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createKeyedDebouncer } from "./debounce";

function deferred() {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createKeyedDebouncer", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("runs only the latest value after the delay", async () => {
    const run = vi.fn(async () => {});
    const d = createKeyedDebouncer<string>(500, run);
    d.schedule("a", "1");
    await vi.advanceTimersByTimeAsync(300);
    d.schedule("a", "2");
    await vi.advanceTimersByTimeAsync(300);
    expect(run).not.toHaveBeenCalled();
    expect(d.pending()).toEqual(["a"]);
    await vi.advanceTimersByTimeAsync(200);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith("a", "2");
    expect(d.pending()).toEqual([]);
  });

  it("keeps keys independent", async () => {
    const run = vi.fn(async () => {});
    const d = createKeyedDebouncer<number>(100, run);
    d.schedule("a", 1);
    d.schedule("b", 2);
    expect(d.pending().sort()).toEqual(["a", "b"]);
    await vi.advanceTimersByTimeAsync(100);
    expect(run).toHaveBeenCalledWith("a", 1);
    expect(run).toHaveBeenCalledWith("b", 2);
  });

  it("flush(key) runs pending immediately; later timer does not run again", async () => {
    const run = vi.fn(async () => {});
    const d = createKeyedDebouncer<string>(500, run);
    d.schedule("a", "x");
    d.schedule("b", "y");
    await d.flush("a");
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith("a", "x");
    expect(d.pending()).toEqual(["b"]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenLastCalledWith("b", "y");
  });

  it("flush() without key flushes everything and resolves after runs finish", async () => {
    const gate = deferred();
    const run = vi.fn(() => gate.promise);
    const d = createKeyedDebouncer<string>(500, run);
    d.schedule("a", "1");
    d.schedule("b", "2");
    let done = false;
    const p = d.flush().then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(2);
    expect(done).toBe(false);
    gate.resolve();
    await p;
    expect(done).toBe(true);
  });

  it("flush on an unknown key resolves", async () => {
    const d = createKeyedDebouncer<string>(500, async () => {});
    await expect(d.flush("nope")).resolves.toBeUndefined();
    await expect(d.flush()).resolves.toBeUndefined();
  });

  it("cancel drops the pending value", async () => {
    const run = vi.fn(async () => {});
    const d = createKeyedDebouncer<string>(500, run);
    d.schedule("a", "1");
    d.cancel("a");
    expect(d.pending()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000);
    await d.flush();
    expect(run).not.toHaveBeenCalled();
  });

  it("serialises runs per key: a value scheduled during a run waits for it", async () => {
    const gates = [deferred(), deferred()];
    let active = 0;
    let maxActive = 0;
    const written: string[] = [];
    const run = vi.fn(async (_k: string, v: string) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await gates[run.mock.calls.length - 1].promise;
      written.push(v);
      active--;
    });
    const d = createKeyedDebouncer<string>(100, run);
    d.schedule("a", "old");
    await vi.advanceTimersByTimeAsync(100); // run #1 starts, blocked
    expect(run).toHaveBeenCalledTimes(1);
    d.schedule("a", "new");
    await vi.advanceTimersByTimeAsync(100); // due, but must wait for run #1
    expect(run).toHaveBeenCalledTimes(1);
    gates[0].resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(2);
    gates[1].resolve();
    await d.flush("a");
    expect(written).toEqual(["old", "new"]);
    expect(maxActive).toBe(1);
  });

  it("never writes an older snapshot after a newer one, even when flushing mid-run", async () => {
    const gate = deferred();
    const written: number[] = [];
    let first = true;
    const run = async (_k: string, v: number) => {
      if (first) {
        first = false;
        await gate.promise;
      }
      written.push(v);
    };
    const d = createKeyedDebouncer<number>(100, run);
    d.schedule("a", 1);
    const f1 = d.flush("a");
    d.schedule("a", 2);
    d.schedule("a", 3);
    const f2 = d.flush("a");
    gate.resolve();
    await Promise.all([f1, f2]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(written).toEqual([1, 3]);
  });

  it("cancel during a run lets flush wait for the in-flight run only", async () => {
    const gate = deferred();
    const run = vi.fn(() => gate.promise);
    const d = createKeyedDebouncer<string>(100, run);
    d.schedule("a", "1");
    void d.flush("a");
    d.schedule("a", "2");
    d.cancel("a");
    let done = false;
    const p = d.flush("a").then(() => (done = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(false);
    gate.resolve();
    await p;
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("reports errors and keeps working", async () => {
    const onError = vi.fn();
    const run = vi
      .fn<(k: string, v: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue(undefined);
    const d = createKeyedDebouncer<string>(100, run, { onError });
    d.schedule("a", "1");
    await expect(d.flush("a")).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledWith("a", expect.any(Error), "1");
    d.schedule("a", "2");
    await d.flush("a");
    expect(run).toHaveBeenLastCalledWith("a", "2");
  });
});
