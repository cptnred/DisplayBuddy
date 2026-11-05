import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  type WheelEvent,
} from "react";
import { indicatorLabel, visibleSlots } from "../../lib/carousel";
import styles from "./Carousel.module.css";

/** Minimum time between two wheel-triggered steps. */
export const WHEEL_THROTTLE_MS = 150;

export interface CarouselProps<T extends { id: string }> {
  items: T[];
  activeIndex: number;
  /** Select an absolute index (side-card click / Enter). */
  onSelect: (index: number) => void;
  /** Step relative to the active index (arrow buttons, wheel). */
  onStep: (delta: number) => void;
  renderActive: (item: T) => ReactNode;
  renderPreview: (item: T) => ReactNode;
  /** Accessible name of an item used in side-card labels („Vorherige Notiz: <label>“). */
  getItemLabel?: (item: T) => string;
  prevLabel?: string;
  nextLabel?: string;
}

interface RenderedCard<T> {
  item: T;
  index: number;
  offset: number;
  jump: boolean;
}

/**
 * Endless coverflow carousel. Cards are keyed by item id and positioned purely via
 * CSS transforms driven by `--offset` (−2…2). Cards whose offset jumps by more than one
 * slot (wraparound) or that newly appear are placed without transition at opacity 0 for
 * one frame and then fade in, so nothing flies across the stack.
 */
export function Carousel<T extends { id: string }>({
  items,
  activeIndex,
  onSelect,
  onStep,
  renderActive,
  renderPreview,
  getItemLabel = () => "",
  prevLabel = "Vorherige Notiz",
  nextLabel = "Nächste Notiz",
}: CarouselProps<T>) {
  const n = items.length;
  const prevOffsets = useRef<Map<string, number> | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const lastWheel = useRef(Number.NEGATIVE_INFINITY);
  const [, setSettleTick] = useState(0);

  const before = prevOffsets.current;
  const cards: RenderedCard<T>[] = visibleSlots(n, activeIndex, 2).map(({ index, offset }) => {
    const item = items[index];
    const old = before?.get(item.id);
    const jump = before !== null && (old === undefined || Math.abs(old - offset) > 1);
    return { item, index, offset, jump };
  });
  const anyJump = cards.some((c) => c.jump);

  useLayoutEffect(() => {
    prevOffsets.current = new Map(cards.map((c) => [c.item.id, c.offset]));
    if (anyJump && stageRef.current) {
      // Commit the "jump" styles (new position, no transition, opacity 0), then re-render
      // without them so the card fades in at its new place.
      for (const el of stageRef.current.querySelectorAll<HTMLElement>("[data-jump]")) {
        void getComputedStyle(el).opacity;
        void el.offsetWidth;
      }
      setSettleTick((t) => t + 1);
    }
  });

  const onWheel = (e: WheelEvent) => {
    const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (d === 0) return;
    const now = Date.now();
    if (now - lastWheel.current < WHEEL_THROTTLE_MS) return;
    lastWheel.current = now;
    onStep(d > 0 ? 1 : -1);
  };

  const onSideKey = (e: KeyboardEvent, index: number) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onSelect(index);
    }
  };

  return (
    <div className={styles.root}>
      <div className={styles.stage} ref={stageRef}>
        {cards.map(({ item, index, offset, jump }) => {
          const abs = Math.abs(offset);
          const isActive = offset === 0;
          const isSide = abs === 1;
          const cls = [
            styles.card,
            isActive ? styles.active : isSide ? styles.side : styles.staging,
            jump ? styles.jump : "",
          ]
            .filter(Boolean)
            .join(" ");
          const style = {
            "--offset": offset,
            "--abs": abs,
            zIndex: 10 - abs * 2,
          } as CSSProperties;
          const label = getItemLabel(item);
          return (
            <div
              key={item.id}
              className={cls}
              style={style}
              data-carousel-card=""
              data-id={item.id}
              data-offset={offset}
              data-jump={jump ? "" : undefined}
              aria-hidden={!isActive && !isSide ? true : undefined}
              {...(isSide
                ? {
                    role: "button",
                    tabIndex: 0,
                    "aria-label": `${offset < 0 ? prevLabel : nextLabel}: ${label}`,
                    onClick: () => onSelect(index),
                    onKeyDown: (e: KeyboardEvent) => onSideKey(e, index),
                    onWheel,
                  }
                : {})}
            >
              {isActive ? renderActive(item) : renderPreview(item)}
            </div>
          );
        })}
      </div>
      <div className={styles.footer}>
        <span className={styles.footerStart}>
          {n > 1 && (
            <button type="button" className={styles.arrow} aria-label={prevLabel} title={prevLabel} onClick={() => onStep(-1)}>
              <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
                <path d="M10 3.5 5.5 8l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          )}
        </span>
        <span className={styles.indicator} aria-live="polite" aria-atomic="true">
          {indicatorLabel(activeIndex, n)}
        </span>
        <span className={styles.footerEnd}>
          {n > 1 && (
            <button type="button" className={styles.arrow} aria-label={nextLabel} title={nextLabel} onClick={() => onStep(1)}>
              <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
                <path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          )}
        </span>
      </div>
    </div>
  );
}
