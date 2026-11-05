import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { Editor } from "@tiptap/core";
import { useEditorState } from "@tiptap/react";
import { FONT_SIZES, TEXT_COLORS } from "./extensions";
import {
  BoldIcon,
  BulletListIcon,
  ItalicIcon,
  OrderedListIcon,
  RedoIcon,
  StrikeIcon,
  TaskListIcon,
  TextColorIcon,
  UnderlineIcon,
  UndoIcon,
} from "./icons";
import styles from "./editor.module.css";

export interface ToolbarProps {
  editor: Editor | null;
}

interface ToolbarState {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  bulletList: boolean;
  orderedList: boolean;
  taskList: boolean;
  fontSize: string;
  color: string;
  canUndo: boolean;
  canRedo: boolean;
}

const EMPTY_STATE: ToolbarState = {
  bold: false,
  italic: false,
  underline: false,
  strike: false,
  bulletList: false,
  orderedList: false,
  taskList: false,
  fontSize: "",
  color: "",
  canUndo: false,
  canRedo: false,
};

/** Keeps the editor selection when a toolbar button is clicked with the mouse. */
const keepSelection = (e: { preventDefault: () => void }) => e.preventDefault();

function ToolButton(props: {
  label: string;
  title: string;
  pressed?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={styles.button}
      aria-label={props.label}
      title={props.title}
      aria-pressed={props.pressed}
      disabled={props.disabled}
      onMouseDown={keepSelection}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}

export function Toolbar({ editor }: ToolbarProps) {
  const state =
    useEditorState({
      editor,
      selector: ({ editor: e }): ToolbarState => {
        if (!e) return EMPTY_STATE;
        const ts = e.getAttributes("textStyle") as { fontSize?: string | null; color?: string | null };
        return {
          bold: e.isActive("bold"),
          italic: e.isActive("italic"),
          underline: e.isActive("underline"),
          strike: e.isActive("strike"),
          bulletList: e.isActive("bulletList"),
          orderedList: e.isActive("orderedList"),
          taskList: e.isActive("taskList"),
          fontSize: ts.fontSize ?? "",
          color: ts.color ?? "",
          canUndo: e.can().undo(),
          canRedo: e.can().redo(),
        };
      },
    }) ?? EMPTY_STATE;

  const run = (fn: (e: Editor) => void) => () => {
    if (editor) fn(editor);
  };
  const knownSize = state.fontSize === "" || FONT_SIZES.some((s) => `${s}px` === state.fontSize);

  return (
    <div className={styles.toolbar} role="toolbar" aria-label="Formatierung">
      <div className={styles.group}>
        <ToolButton
          label="Fett"
          title="Fett (Strg+B)"
          pressed={state.bold}
          onClick={run((e) => e.chain().focus().toggleBold().run())}
        >
          <BoldIcon />
        </ToolButton>
        <ToolButton
          label="Kursiv"
          title="Kursiv (Strg+I)"
          pressed={state.italic}
          onClick={run((e) => e.chain().focus().toggleItalic().run())}
        >
          <ItalicIcon />
        </ToolButton>
        <ToolButton
          label="Unterstrichen"
          title="Unterstrichen (Strg+U)"
          pressed={state.underline}
          onClick={run((e) => e.chain().focus().toggleUnderline().run())}
        >
          <UnderlineIcon />
        </ToolButton>
        <ToolButton
          label="Durchgestrichen"
          title="Durchgestrichen (Strg+Umschalt+S)"
          pressed={state.strike}
          onClick={run((e) => e.chain().focus().toggleStrike().run())}
        >
          <StrikeIcon />
        </ToolButton>
      </div>

      <div className={styles.group}>
        <select
          className={styles.select}
          aria-label="Schriftgröße"
          title="Schriftgröße"
          value={state.fontSize}
          disabled={!editor}
          onChange={(ev) => {
            const value = ev.target.value;
            if (!editor) return;
            if (value) editor.chain().focus().setFontSize(value).run();
            else editor.chain().focus().unsetFontSize().run();
          }}
        >
          <option value="">Standard</option>
          {FONT_SIZES.map((s) => (
            <option key={s} value={`${s}px`}>
              {s} px
            </option>
          ))}
          {!knownSize && <option value={state.fontSize}>{state.fontSize}</option>}
        </select>
        <ColorPicker editor={editor} current={state.color} />
      </div>

      <div className={styles.group}>
        <ToolButton
          label="Aufzählung"
          title="Aufzählung (Strg+Umschalt+8)"
          pressed={state.bulletList}
          onClick={run((e) => e.chain().focus().toggleBulletList().run())}
        >
          <BulletListIcon />
        </ToolButton>
        <ToolButton
          label="Nummerierung"
          title="Nummerierung (Strg+Umschalt+7)"
          pressed={state.orderedList}
          onClick={run((e) => e.chain().focus().toggleOrderedList().run())}
        >
          <OrderedListIcon />
        </ToolButton>
        <ToolButton
          label="Checkliste"
          title="Checkliste (Strg+Umschalt+9)"
          pressed={state.taskList}
          onClick={run((e) => e.chain().focus().toggleTaskList().run())}
        >
          <TaskListIcon />
        </ToolButton>
      </div>

      <div className={styles.group}>
        <ToolButton
          label="Rückgängig"
          title="Rückgängig (Strg+Z)"
          disabled={!state.canUndo}
          onClick={run((e) => e.chain().focus().undo().run())}
        >
          <UndoIcon />
        </ToolButton>
        <ToolButton
          label="Wiederholen"
          title="Wiederholen (Strg+Y)"
          disabled={!state.canRedo}
          onClick={run((e) => e.chain().focus().redo().run())}
        >
          <RedoIcon />
        </ToolButton>
      </div>
    </div>
  );
}

function ColorPicker({ editor, current }: { editor: Editor | null; current: string }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const currentLower = current.toLowerCase();

  // Close on outside pointer down.
  useEffect(() => {
    if (!open) return;
    const onDown = (ev: MouseEvent) => {
      if (!wrapRef.current?.contains(ev.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // Move focus into the palette when it opens (selected swatch, else the first).
  useEffect(() => {
    if (!open) return;
    const pop = popRef.current;
    const target =
      pop?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]') ??
      pop?.querySelector<HTMLButtonElement>("button");
    target?.focus();
  }, [open]);

  const close = (refocusTrigger: boolean) => {
    setOpen(false);
    if (refocusTrigger) triggerRef.current?.focus();
  };

  const apply = (value: string | null) => {
    if (editor) {
      if (value) editor.chain().focus().setColor(value).run();
      else editor.chain().focus().unsetColor().removeEmptyTextStyle().run();
    }
    setOpen(false);
  };

  const onPopKeyDown = (ev: KeyboardEvent<HTMLDivElement>) => {
    if (ev.key === "Escape") {
      ev.preventDefault();
      ev.stopPropagation();
      close(true);
      return;
    }
    const keys = ["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp", "Home", "End"];
    if (!keys.includes(ev.key) || ev.ctrlKey || ev.altKey || ev.metaKey) return;
    const buttons = Array.from(popRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
    const idx = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (idx < 0) return;
    ev.preventDefault();
    const n = buttons.length;
    const next =
      ev.key === "Home"
        ? 0
        : ev.key === "End"
          ? n - 1
          : ev.key === "ArrowRight" || ev.key === "ArrowDown"
            ? (idx + 1) % n
            : (idx - 1 + n) % n;
    buttons[next]?.focus();
  };

  const activeName = TEXT_COLORS.find((c) => c.value.toLowerCase() === currentLower)?.name;

  return (
    <div className={styles.colorWrap} ref={wrapRef}>
      <button
        ref={triggerRef}
        type="button"
        className={styles.button}
        aria-label={activeName ? `Textfarbe (${activeName})` : "Textfarbe"}
        title="Textfarbe"
        aria-haspopup="true"
        aria-expanded={open}
        disabled={!editor}
        onMouseDown={keepSelection}
        onClick={() => setOpen((o) => !o)}
      >
        <TextColorIcon color={current || undefined} />
      </button>
      {open && (
        <div
          ref={popRef}
          className={styles.palette}
          role="group"
          aria-label="Textfarbe wählen"
          onKeyDown={onPopKeyDown}
          onBlur={(ev) => {
            // Tabbing out of the palette closes it.
            const next = ev.relatedTarget as Node | null;
            if (next && !wrapRef.current?.contains(next)) setOpen(false);
          }}
        >
          <div className={styles.swatches}>
            {TEXT_COLORS.map((c) => (
              <button
                key={c.value}
                type="button"
                className={styles.swatch}
                style={{ backgroundColor: c.value }}
                aria-label={c.name}
                title={c.name}
                aria-pressed={c.value.toLowerCase() === currentLower}
                onMouseDown={keepSelection}
                onClick={() => apply(c.value)}
              />
            ))}
          </div>
          <button
            type="button"
            className={styles.removeColor}
            aria-label="Farbe entfernen"
            onMouseDown={keepSelection}
            onClick={() => apply(null)}
          >
            Farbe entfernen
          </button>
        </div>
      )}
    </div>
  );
}
