import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Carousel } from "./Carousel";
import { step } from "../../lib/carousel";

interface Item {
  id: string;
  name: string;
}
const makeItems = (n: number): Item[] => Array.from({ length: n }, (_, i) => ({ id: `id-${i}`, name: `Notiz ${i + 1}` }));

function cards(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLElement>("[data-carousel-card]")];
}

function Harness({ n, initial = 0, onSelectSpy }: { n: number; initial?: number; onSelectSpy?: (i: number) => void }) {
  const items = makeItems(n);
  const [active, setActive] = useState(initial);
  return (
    <Carousel
      items={items}
      activeIndex={active}
      onSelect={(i) => {
        onSelectSpy?.(i);
        setActive(i);
      }}
      onStep={(d) => setActive((a) => step(a, d, items.length))}
      getItemLabel={(it) => it.name}
      renderActive={(it) => <div data-testid="active">{it.name}</div>}
      renderPreview={(it) => <div>{it.name} preview</div>}
    />
  );
}

describe("Carousel", () => {
  it.each([
    [0, 0, 0],
    [1, 1, 0],
    [2, 2, 1],
    [3, 3, 2],
    [10, 5, 2],
  ])("n=%i renders %i cards with %i side buttons, no duplicate ids", (n, cardCount, sideCount) => {
    const { container } = render(<Harness n={n} />);
    const cs = cards(container);
    expect(cs).toHaveLength(cardCount);
    expect(new Set(cs.map((c) => c.dataset.id)).size).toBe(cs.length);
    expect(container.querySelectorAll('[data-carousel-card][role="button"]')).toHaveLength(sideCount);
    expect(screen.queryAllByTestId("active")).toHaveLength(n > 0 ? 1 : 0);
  });

  it("shows the indicator and hides arrows for n <= 1", () => {
    const { rerender } = render(<Harness n={0} />);
    expect(screen.getByText("0 / 0")).toHaveAttribute("aria-live", "polite");
    expect(screen.queryByRole("button", { name: "Nächste Notiz" })).toBeNull();
    rerender(<Harness n={1} />);
    expect(screen.getByText("1 / 1")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Vorherige Notiz" })).toBeNull();
  });

  it("n=2 shows the other note exactly once as „Nächste Notiz“", () => {
    render(<Harness n={2} />);
    expect(screen.getByRole("button", { name: "Nächste Notiz: Notiz 2" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Vorherige Notiz:/ })).toBeNull();
  });

  it("labels side cards and selects on click and Enter", () => {
    const spy = vi.fn();
    render(<Harness n={10} onSelectSpy={spy} />);
    expect(screen.getByRole("button", { name: "Vorherige Notiz: Notiz 10" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Nächste Notiz: Notiz 2" }));
    expect(spy).toHaveBeenLastCalledWith(1);
    expect(screen.getByTestId("active")).toHaveTextContent("Notiz 2");
    fireEvent.keyDown(screen.getByRole("button", { name: "Vorherige Notiz: Notiz 1" }), { key: "Enter" });
    expect(spy).toHaveBeenLastCalledWith(0);
    expect(screen.getByText("1 / 10")).toBeInTheDocument();
  });

  it("arrow buttons step with wraparound in both directions", () => {
    render(<Harness n={3} />);
    fireEvent.click(screen.getByRole("button", { name: "Vorherige Notiz" }));
    expect(screen.getByText("3 / 3")).toBeInTheDocument();
    expect(screen.getByTestId("active")).toHaveTextContent("Notiz 3");
    fireEvent.click(screen.getByRole("button", { name: "Nächste Notiz" }));
    fireEvent.click(screen.getByRole("button", { name: "Nächste Notiz" }));
    expect(screen.getByText("2 / 3")).toBeInTheDocument();
  });

  it("wraps from last to first when stepping past the end", () => {
    const { container } = render(<Harness n={10} initial={9} />);
    expect(screen.getByText("10 / 10")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Nächste Notiz" }));
    expect(screen.getByText("1 / 10")).toBeInTheDocument();
    const offsets = Object.fromEntries(cards(container).map((c) => [c.dataset.id, Number(c.dataset.offset)]));
    expect(offsets).toEqual({ "id-8": -2, "id-9": -1, "id-0": 0, "id-1": 1, "id-2": 2 });
  });

  it("wheel over a side card steps (throttled)", () => {
    vi.useFakeTimers();
    try {
      render(<Harness n={5} />);
      const side = screen.getByRole("button", { name: "Nächste Notiz: Notiz 2" });
      fireEvent.wheel(side, { deltaY: 40 });
      expect(screen.getByText("2 / 5")).toBeInTheDocument();
      // throttled: immediate second wheel is ignored
      fireEvent.wheel(screen.getByRole("button", { name: "Nächste Notiz: Notiz 3" }), { deltaY: 40 });
      expect(screen.getByText("2 / 5")).toBeInTheDocument();
      vi.advanceTimersByTime(200);
      fireEvent.wheel(screen.getByRole("button", { name: "Vorherige Notiz: Notiz 1" }), { deltaX: -30, deltaY: 5 });
      expect(screen.getByText("1 / 5")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps card DOM nodes (keyed by id) across steps and settles jump state", () => {
    const { container } = render(<Harness n={3} />);
    const before = cards(container).find((c) => c.dataset.id === "id-2");
    fireEvent.click(screen.getByRole("button", { name: "Nächste Notiz" }));
    const after = cards(container).find((c) => c.dataset.id === "id-2");
    // id-2 went from offset -1 to +1 (wraparound): same node, no lingering jump flag
    expect(after).toBe(before);
    expect(after?.dataset.offset).toBe("1");
    expect(after).not.toHaveAttribute("data-jump");
  });

  it("n=2: stepping repeatedly always shows the other note once at +1 (no duplicate)", () => {
    const { container } = render(<Harness n={2} />);
    for (let k = 1; k <= 4; k++) {
      fireEvent.click(screen.getByRole("button", { name: "Nächste Notiz" }));
      const expectedActive = k % 2;
      expect(screen.getByText(`${expectedActive + 1} / 2`)).toBeInTheDocument();
      const offsets = Object.fromEntries(cards(container).map((c) => [c.dataset.id, Number(c.dataset.offset)]));
      expect(offsets).toEqual({ [`id-${expectedActive}`]: 0, [`id-${1 - expectedActive}`]: 1 });
    }
    fireEvent.click(screen.getByRole("button", { name: "Vorherige Notiz" }));
    expect(screen.getByText("2 / 2")).toBeInTheDocument();
  });

  it("normalises an out-of-range activeIndex (e.g. right after the last note was deleted)", () => {
    const items = makeItems(3);
    const props = {
      onSelect: () => {},
      onStep: () => {},
      renderActive: (it: Item) => <div data-testid="active">{it.name}</div>,
      renderPreview: (it: Item) => <div>{it.name}</div>,
    };
    const { rerender, container } = render(<Carousel items={items} activeIndex={5} {...props} />);
    expect(screen.getByTestId("active")).toHaveTextContent("Notiz 3");
    expect(screen.getByText("3 / 3")).toBeInTheDocument();
    rerender(<Carousel items={items} activeIndex={-1} {...props} />);
    expect(screen.getByTestId("active")).toHaveTextContent("Notiz 3");
    rerender(<Carousel items={items.slice(0, 1)} activeIndex={2} {...props} />);
    expect(screen.getByTestId("active")).toHaveTextContent("Notiz 1");
    expect(cards(container)).toHaveLength(1);
    rerender(<Carousel items={[]} activeIndex={0} {...props} />);
    expect(cards(container)).toHaveLength(0);
    expect(screen.getByText("0 / 0")).toBeInTheDocument();
  });

  it("wheel with zero delta or over the active card does not step", () => {
    render(<Harness n={5} />);
    fireEvent.wheel(screen.getByRole("button", { name: "Nächste Notiz: Notiz 2" }), { deltaX: 0, deltaY: 0 });
    expect(screen.getByText("1 / 5")).toBeInTheDocument();
    fireEvent.wheel(screen.getByTestId("active"), { deltaY: 100 });
    expect(screen.getByText("1 / 5")).toBeInTheDocument();
    // the zero-delta event did not arm the throttle
    fireEvent.wheel(screen.getByRole("button", { name: "Nächste Notiz: Notiz 2" }), { deltaY: 100 });
    expect(screen.getByText("2 / 5")).toBeInTheDocument();
  });

  it("staging cards (±2) are hidden from assistive technology and not focusable", () => {
    const { container } = render(<Harness n={10} />);
    const staging = cards(container).filter((c) => Math.abs(Number(c.dataset.offset)) === 2);
    expect(staging).toHaveLength(2);
    for (const c of staging) {
      expect(c).toHaveAttribute("aria-hidden", "true");
      expect(c).not.toHaveAttribute("tabindex");
      expect(c).not.toHaveAttribute("role");
    }
  });
});
