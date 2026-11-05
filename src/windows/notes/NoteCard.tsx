import { useRef, type ComponentType, type KeyboardEvent, type ReactNode } from "react";
import type { JSONContent } from "@tiptap/core";
import { NOTE_COLORS, type Note, type NoteColor } from "../../types";
import { docToPlainText } from "./docText";
import styles from "./NoteCard.module.css";

/** Props of the injected rich-text editor (mirrors `components/editor/NoteEditor`). */
export interface NoteEditorProps {
  content: JSONContent | null;
  onChange: (doc: JSONContent) => void;
  autoFocus?: boolean;
  placeholder?: string;
}

export const UNTITLED = "Ohne Titel";
const COLOR_KEYS = Object.keys(NOTE_COLORS) as NoteColor[];

export function noteColorValue(color: NoteColor): string {
  return (NOTE_COLORS[color] ?? NOTE_COLORS.yellow).value;
}

export function ColorPicker({ value, onChange }: { value: NoteColor; onChange: (c: NoteColor) => void }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKeyDown = (e: KeyboardEvent, i: number) => {
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    const delta = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!delta) return;
    e.preventDefault();
    const j = (i + delta + COLOR_KEYS.length) % COLOR_KEYS.length;
    onChange(COLOR_KEYS[j]);
    refs.current[j]?.focus();
  };
  return (
    <div className={styles.colors} role="radiogroup" aria-label="Notizfarbe">
      {COLOR_KEYS.map((key, i) => {
        const checked = key === value;
        return (
          <button
            key={key}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={NOTE_COLORS[key].label}
            title={NOTE_COLORS[key].label}
            tabIndex={checked ? 0 : -1}
            className={`${styles.swatch} ${checked ? styles.swatchChecked : ""}`}
            style={{ background: NOTE_COLORS[key].value }}
            onClick={() => onChange(key)}
            onKeyDown={(e) => onKeyDown(e, i)}
          />
        );
      })}
    </div>
  );
}

export interface ActiveNoteCardProps {
  note: Note;
  Editor: ComponentType<NoteEditorProps>;
  autoFocusEditor: boolean;
  onTitleChange: (title: string) => void;
  onColorChange: (color: NoteColor) => void;
  onContentChange: (doc: JSONContent) => void;
  /** Rendered in the header between title and colour picker (reminder bell). */
  headerExtra?: ReactNode;
  /** Rendered above the header (due-reminder banner). */
  banner?: ReactNode;
}

export function ActiveNoteCard({
  note,
  Editor,
  autoFocusEditor,
  onTitleChange,
  onColorChange,
  onContentChange,
  headerExtra,
  banner,
}: ActiveNoteCardProps) {
  return (
    <div className={styles.face} style={{ background: noteColorValue(note.color) }} data-note-id={note.id}>
      {banner}
      <div className={styles.header}>
        <input
          className={styles.title}
          aria-label="Titel"
          placeholder="Titel (optional)"
          value={note.title}
          maxLength={200}
          spellCheck={false}
          onChange={(e) => onTitleChange(e.target.value)}
        />
        {headerExtra}
        <ColorPicker value={note.color} onChange={onColorChange} />
      </div>
      <div className={styles.editor} data-editor-slot="">
        <Editor
          key={note.id}
          content={note.content}
          onChange={onContentChange}
          autoFocus={autoFocusEditor}
          placeholder="Schreib etwas …"
        />
      </div>
    </div>
  );
}

/** Default side-card content: title + first lines of plain text. */
export function DefaultPreview({ note }: { note: Note }) {
  const text = docToPlainText(note.content, 600);
  return (
    <>
      <div className={`${styles.previewTitle} ${note.title ? "" : styles.untitled}`}>{note.title || UNTITLED}</div>
      {text && <div className={styles.previewText}>{text}</div>}
    </>
  );
}

export function PreviewNoteCard({ note, children, badge }: { note: Note; children: ReactNode; badge?: ReactNode }) {
  return (
    <div className={`${styles.face} ${styles.preview}`} style={{ background: noteColorValue(note.color) }}>
      {badge && <div className={styles.previewBadge}>{badge}</div>}
      {children}
    </div>
  );
}
