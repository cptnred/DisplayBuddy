/**
 * Pure pointer-gesture classifier for the buddy window.
 *
 * A press becomes a "drag" as soon as the pointer moves further than
 * `threshold` px (Euclidean) from where it went down; otherwise releasing it
 * is a "click". Use screen coordinates so that moving the window itself does
 * not distort the measurement.
 */
export type DragClickTracker = {
  /** Start tracking a press at (x, y). Restarts any previous press. */
  down(x: number, y: number): void;
  /** Returns "drag" exactly once per press, when the threshold is exceeded. */
  move(x: number, y: number): "drag" | null;
  /** Ends the press: "click" if it never became a drag, otherwise "none". */
  up(): "click" | "none";
  /** Forget the current press (pointercancel, window blur, drag start …). */
  cancel(): void;
  /** Whether a press is currently being tracked. */
  readonly active: boolean;
};

export function createDragClickTracker({ threshold = 4 }: { threshold?: number } = {}): DragClickTracker {
  let origin: { x: number; y: number } | null = null;
  let dragging = false;

  return {
    down(x, y) {
      origin = { x, y };
      dragging = false;
    },
    move(x, y) {
      if (!origin || dragging) return null;
      if (Math.hypot(x - origin.x, y - origin.y) > threshold) {
        dragging = true;
        return "drag";
      }
      return null;
    },
    up() {
      const result = origin && !dragging ? "click" : "none";
      origin = null;
      dragging = false;
      return result;
    },
    cancel() {
      origin = null;
      dragging = false;
    },
    get active() {
      return origin !== null;
    },
  };
}
