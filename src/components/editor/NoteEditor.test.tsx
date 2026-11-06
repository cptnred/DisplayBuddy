import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Editor, JSONContent } from "@tiptap/core";
import { NoteEditor } from "./NoteEditor";
import { TEXT_COLORS } from "./extensions";

// --- jsdom stubs needed by ProseMirror (layout APIs are missing in jsdom) ---
beforeAll(() => {
  const rect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) }) as DOMRect;
  const rects = () => {
    const list = [] as unknown as DOMRectList;
    Object.assign(list, { item: () => null, length: 0 });
    return list;
  };
  Range.prototype.getBoundingClientRect = rect;
  Range.prototype.getClientRects = rects;
  if (!document.elementFromPoint) document.elementFromPoint = () => null;
});

type MarkJSON = { type: string; attrs?: Record<string, unknown> };

function setup(content: JSONContent | null = null) {
  const onChange = vi.fn<(doc: JSONContent) => void>();
  let editor!: Editor;
  const utils = render(
    <NoteEditor content={content} onChange={onChange} onReady={(e) => (editor = e)} />,
  );
  return { ...utils, onChange, getEditor: () => editor };
}

const helloDoc: JSONContent = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "Hallo Welt" }] }],
};

/** Marks of the first text node of the first paragraph. */
function firstMarks(editor: Editor): MarkJSON[] {
  const p = editor.getJSON().content?.[0];
  return (p?.content?.[0]?.marks ?? []) as MarkJSON[];
}

function selectAll(editor: Editor) {
  act(() => {
    editor.commands.selectAll();
  });
}

describe("NoteEditor", () => {
  it("renders with null content (empty doc + placeholder)", () => {
    const { getEditor, container } = setup(null);
    expect(getEditor().isEmpty).toBe(true);
    const p = container.querySelector(".ProseMirror p");
    expect(p).toHaveClass("is-editor-empty");
    expect(p).toHaveAttribute("data-placeholder", "Notiz schreiben …");
    expect(screen.getByRole("textbox", { name: "Notizinhalt" })).toBeInTheDocument();
  });

  it("renders the given content", () => {
    const { getEditor } = setup(helloDoc);
    expect(screen.getByText("Hallo Welt")).toBeInTheDocument();
    expect(getEditor().getJSON()).toEqual(helloDoc);
  });

  it("uses a custom placeholder", () => {
    const { container } = render(
      <NoteEditor content={null} onChange={() => {}} placeholder="Los geht's" />,
    );
    expect(container.querySelector(".ProseMirror p")).toHaveAttribute("data-placeholder", "Los geht's");
  });

  it("calls onChange with JSON on doc changes but not on selection changes", () => {
    const { getEditor, onChange } = setup(helloDoc);
    const editor = getEditor();
    act(() => {
      editor.commands.setTextSelection(3);
    });
    expect(onChange).not.toHaveBeenCalled();
    act(() => {
      editor.commands.insertContentAt(editor.state.doc.content.size - 1, "!");
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]![0]).toEqual({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "Hallo Welt!" }] }],
    });
  });

  it("uses the latest onChange without recreating the editor", () => {
    const first = vi.fn();
    const second = vi.fn();
    let editor!: Editor;
    const { rerender } = render(<NoteEditor content={helloDoc} onChange={first} onReady={(e) => (editor = e)} />);
    const original = editor;
    rerender(<NoteEditor content={helloDoc} onChange={second} onReady={(e) => (editor = e)} />);
    expect(editor).toBe(original);
    act(() => {
      editor.commands.insertContent("x");
    });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("ignores content prop changes after mount", () => {
    let editor!: Editor;
    const { rerender } = render(<NoteEditor content={helloDoc} onChange={() => {}} onReady={(e) => (editor = e)} />);
    rerender(<NoteEditor content={null} onChange={() => {}} onReady={(e) => (editor = e)} />);
    expect(editor.getText()).toBe("Hallo Welt");
  });
});

describe("Toolbar", () => {
  it("has aria-labels and titles on all buttons", () => {
    setup(helloDoc);
    const toolbar = screen.getByRole("toolbar", { name: "Formatierung" });
    const buttons = toolbar.querySelectorAll("button");
    expect(buttons.length).toBeGreaterThanOrEqual(10);
    buttons.forEach((b) => {
      expect(b.getAttribute("aria-label")).toBeTruthy();
      expect(b.getAttribute("title")).toBeTruthy();
      expect(b).toHaveAttribute("type", "button");
    });
    for (const label of [
      "Fett",
      "Kursiv",
      "Unterstrichen",
      "Durchgestrichen",
      "Textfarbe",
      "Aufzählung",
      "Nummerierung",
      "Checkliste",
      "Rückgängig",
      "Wiederholen",
    ]) {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    }
    expect(screen.getByRole("button", { name: "Fett" })).toHaveAttribute("title", "Fett (Strg+B)");
    expect(screen.getByRole("combobox", { name: "Schriftgröße" })).toBeInTheDocument();
  });

  it.each([
    ["Fett", "bold"],
    ["Kursiv", "italic"],
    ["Unterstrichen", "underline"],
    ["Durchgestrichen", "strike"],
  ])("%s toggles the %s mark", (label, mark) => {
    const { getEditor, onChange } = setup(helloDoc);
    const editor = getEditor();
    selectAll(editor);
    const button = screen.getByRole("button", { name: label });
    expect(button).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(button);
    expect(firstMarks(editor)).toEqual([{ type: mark }]);
    expect(button).toHaveAttribute("aria-pressed", "true");
    expect(onChange).toHaveBeenCalled();

    fireEvent.click(button);
    expect(firstMarks(editor)).toEqual([]);
    expect(button).toHaveAttribute("aria-pressed", "false");
  });

  it("prevents mousedown default on buttons so the editor keeps its selection", () => {
    setup(helloDoc);
    const button = screen.getByRole("button", { name: "Fett" });
    const ev = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    button.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
  });

  it("font size select sets and unsets fontSize on textStyle", () => {
    const { getEditor } = setup(helloDoc);
    const editor = getEditor();
    selectAll(editor);
    const select = screen.getByRole("combobox", { name: "Schriftgröße" }) as HTMLSelectElement;
    expect(select.value).toBe("");
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual([
      "Standard",
      "12 px",
      "14 px",
      "16 px",
      "18 px",
      "24 px",
      "32 px",
    ]);

    fireEvent.change(select, { target: { value: "24px" } });
    expect(firstMarks(editor)).toEqual([{ type: "textStyle", attrs: expect.objectContaining({ fontSize: "24px" }) }]);
    expect(select.value).toBe("24px");

    fireEvent.change(select, { target: { value: "" } });
    expect(firstMarks(editor)).toEqual([]);
    expect(select.value).toBe("");
  });

  it("colour palette sets and removes the text colour", () => {
    const { getEditor } = setup(helloDoc);
    const editor = getEditor();
    selectAll(editor);
    const trigger = screen.getByRole("button", { name: "Textfarbe" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");

    const palette = screen.getByRole("group", { name: "Textfarbe wählen" });
    for (const c of TEXT_COLORS) {
      expect(screen.getByRole("button", { name: c.name })).toBeInTheDocument();
    }
    // Focus moved into the palette for keyboard use.
    expect(palette.contains(document.activeElement)).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Blau" }));
    expect(screen.queryByRole("group", { name: "Textfarbe wählen" })).not.toBeInTheDocument();
    expect(firstMarks(editor)).toEqual([
      { type: "textStyle", attrs: expect.objectContaining({ color: "#1F5FBF" }) },
    ]);
    expect(screen.getByRole("button", { name: "Textfarbe (Blau)" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Textfarbe (Blau)" }));
    fireEvent.click(screen.getByRole("button", { name: "Farbe entfernen" }));
    expect(firstMarks(editor)).toEqual([]);
  });

  it("colour palette closes on Escape (focus back to trigger) and outside click", () => {
    setup(helloDoc);
    const trigger = screen.getByRole("button", { name: "Textfarbe" });
    fireEvent.click(trigger);
    const palette = screen.getByRole("group", { name: "Textfarbe wählen" });
    const swatches = palette.querySelectorAll("button");
    // Arrow keys move focus between swatches.
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(swatches[1]);
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("group", { name: "Textfarbe wählen" })).not.toBeInTheDocument();
    expect(document.activeElement).toBe(trigger);

    fireEvent.click(trigger);
    expect(screen.getByRole("group", { name: "Textfarbe wählen" })).toBeInTheDocument();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("group", { name: "Textfarbe wählen" })).not.toBeInTheDocument();
  });

  it.each([
    ["Aufzählung", "bulletList"],
    ["Nummerierung", "orderedList"],
    ["Checkliste", "taskList"],
  ])("%s creates a %s", (label, type) => {
    const { getEditor } = setup(helloDoc);
    const editor = getEditor();
    act(() => {
      editor.commands.setTextSelection(2);
    });
    const button = screen.getByRole("button", { name: label });
    fireEvent.click(button);
    expect(editor.getJSON().content?.[0]?.type).toBe(type);
    expect(button).toHaveAttribute("aria-pressed", "true");
  });

  it("undo / redo buttons work and are disabled when not possible", () => {
    const { getEditor } = setup(helloDoc);
    const editor = getEditor();
    const undo = screen.getByRole("button", { name: "Rückgängig" });
    const redo = screen.getByRole("button", { name: "Wiederholen" });
    expect(undo).toBeDisabled();
    expect(redo).toBeDisabled();

    act(() => {
      editor.commands.insertContentAt(1, "Oh ");
    });
    expect(editor.getText()).toBe("Oh Hallo Welt");
    expect(undo).toBeEnabled();

    fireEvent.click(undo);
    expect(editor.getText()).toBe("Hallo Welt");
    expect(redo).toBeEnabled();

    fireEvent.click(redo);
    expect(editor.getText()).toBe("Oh Hallo Welt");
    expect(redo).toBeDisabled();
  });
});

describe("keyboard", () => {
  function keydown(target: Element, init: KeyboardEventInit) {
    const ev = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(ev);
    return ev;
  }

  it.each([
    [{ key: "ArrowLeft", keyCode: 37, ctrlKey: true }],
    [{ key: "ArrowRight", keyCode: 39, ctrlKey: true }],
    [{ key: "ArrowLeft", keyCode: 37, ctrlKey: true, shiftKey: true }],
    [{ key: "ArrowRight", keyCode: 39, ctrlKey: true, shiftKey: true }],
  ])("lets %o bubble to window", (init) => {
    const { getEditor } = setup(helloDoc);
    const editor = getEditor();
    act(() => {
      editor.commands.focus();
      editor.commands.setTextSelection(3);
    });
    const received: KeyboardEvent[] = [];
    const listener = (e: KeyboardEvent) => received.push(e);
    window.addEventListener("keydown", listener);
    try {
      const ev = keydown(editor.view.dom, init);
      expect(received).toHaveLength(1);
      expect(received[0]).toBe(ev);
      expect(ev.defaultPrevented).toBe(false);
    } finally {
      window.removeEventListener("keydown", listener);
    }
  });

  it("Ctrl+Shift+7/8/9 toggle ordered/bullet/task lists", () => {
    const { getEditor } = setup(helloDoc);
    const editor = getEditor();
    act(() => {
      editor.commands.setTextSelection(2);
    });
    const cases = [
      { key: "7", keyCode: 55, type: "orderedList" },
      { key: "8", keyCode: 56, type: "bulletList" },
      { key: "9", keyCode: 57, type: "taskList" },
    ];
    for (const c of cases) {
      act(() => {
        keydown(editor.view.dom, { key: c.key, keyCode: c.keyCode, ctrlKey: true, shiftKey: true });
      });
      expect(editor.getJSON().content?.[0]?.type).toBe(c.type);
      act(() => {
        keydown(editor.view.dom, { key: c.key, keyCode: c.keyCode, ctrlKey: true, shiftKey: true });
      });
      expect(editor.getJSON().content?.[0]?.type).toBe("paragraph");
    }
  });

  it("Ctrl+Shift+7 also works on a German layout (key '/')", () => {
    const { getEditor } = setup(helloDoc);
    const editor = getEditor();
    act(() => {
      editor.commands.setTextSelection(2);
      keydown(editor.view.dom, { key: "/", keyCode: 55, ctrlKey: true, shiftKey: true });
    });
    expect(editor.getJSON().content?.[0]?.type).toBe("orderedList");
  });

  it("Ctrl+B toggles bold", () => {
    const { getEditor } = setup(helloDoc);
    const editor = getEditor();
    selectAll(editor);
    act(() => {
      keydown(editor.view.dom, { key: "b", keyCode: 66, ctrlKey: true });
    });
    expect(firstMarks(editor)).toEqual([{ type: "bold" }]);
  });

  it("Tab nests and Shift+Tab lifts list items; Tab is swallowed inside lists", () => {
    const doc: JSONContent = {
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [
            { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Eins" }] }] },
            { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Zwei" }] }] },
          ],
        },
      ],
    };
    const { getEditor } = setup(doc);
    const editor = getEditor();

    // First item cannot be sunk, but Tab must not leave the editor.
    act(() => {
      editor.commands.setTextSelection(3);
    });
    let ev!: KeyboardEvent;
    act(() => {
      ev = keydown(editor.view.dom, { key: "Tab", keyCode: 9 });
    });
    expect(ev.defaultPrevented).toBe(true);

    // Second item → nested under the first.
    // bulletList(0) listItem(1) p(2) "Eins"(3-7) … listItem(9) p(10) "Zwei"(11-15)
    act(() => {
      editor.commands.setTextSelection(12);
    });
    expect(editor.state.selection.$from.parent.textContent).toBe("Zwei");
    act(() => {
      keydown(editor.view.dom, { key: "Tab", keyCode: 9 });
    });
    const items = (editor.getJSON().content?.[0]?.content ?? []) as JSONContent[];
    expect(items).toHaveLength(1);
    expect(items[0]?.content?.[1]?.type).toBe("bulletList");

    act(() => {
      keydown(editor.view.dom, { key: "Tab", keyCode: 9, shiftKey: true });
    });
    expect(editor.getJSON().content?.[0]?.content).toHaveLength(2);
  });

  it("Tab nests task items", () => {
    const doc: JSONContent = {
      type: "doc",
      content: [
        {
          type: "taskList",
          content: [
            { type: "taskItem", attrs: { checked: true }, content: [{ type: "paragraph", content: [{ type: "text", text: "A" }] }] },
            { type: "taskItem", attrs: { checked: false }, content: [{ type: "paragraph", content: [{ type: "text", text: "B" }] }] },
          ],
        },
      ],
    };
    const { getEditor, container } = setup(doc);
    const editor = getEditor();
    expect(container.querySelector('li[data-checked="true"]')).toBeInTheDocument();
    // Position inside "B": doc(0) taskList(1) taskItem(2) p(3) "A"(4) /p /taskItem taskItem p "B"(9)
    act(() => {
      editor.commands.setTextSelection(9);
    });
    expect(editor.state.selection.$from.parent.textContent).toBe("B");
    act(() => {
      keydown(editor.view.dom, { key: "Tab", keyCode: 9 });
    });
    const items = (editor.getJSON().content?.[0]?.content ?? []) as JSONContent[];
    expect(items).toHaveLength(1);
    expect(items[0]?.content?.[1]?.type).toBe("taskList");
  });

  it("Tab outside of lists is not swallowed (focus may move on)", () => {
    const { getEditor } = setup(helloDoc);
    const editor = getEditor();
    act(() => {
      editor.commands.setTextSelection(2);
    });
    const ev = keydown(editor.view.dom, { key: "Tab", keyCode: 9 });
    expect(ev.defaultPrevented).toBe(false);
    expect(editor.getText()).toBe("Hallo Welt");
  });
});

describe("NoteEditor – remote content (v3 sync)", () => {
  it("a new revision loads the content without firing onChange; same revision ignores prop changes", () => {
    const onChange = vi.fn<(doc: JSONContent) => void>();
    let editor!: Editor;
    const onReady = (e: Editor) => (editor = e);
    const other: JSONContent = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "Vom Handy" }] }],
    };
    const { rerender } = render(<NoteEditor content={helloDoc} onChange={onChange} onReady={onReady} revision={0} />);
    // the content prop alone is mount-only
    rerender(<NoteEditor content={other} onChange={onChange} onReady={onReady} revision={0} />);
    expect(editor.getText()).toBe("Hallo Welt");
    act(() => {
      rerender(<NoteEditor content={other} onChange={onChange} onReady={onReady} revision={1} />);
    });
    expect(editor.getText()).toBe("Vom Handy");
    expect(onChange).not.toHaveBeenCalled();
  });
});
