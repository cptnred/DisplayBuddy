/**
 * TEMPORARY plain-textarea editor so the notes window works before the real TipTap
 * `NoteEditor` (src/components/editor) is wired in by the orchestrator.
 * Same props contract: uncontrolled after mount, parent remounts it with `key={note.id}`.
 */
import { useState } from "react";
import type { NoteEditorProps } from "./NoteCard";
import { docToPlainText, plainTextToDoc } from "./docText";
import styles from "./FallbackEditor.module.css";

export function FallbackEditor({ content, onChange, autoFocus, placeholder }: NoteEditorProps) {
  const [initial] = useState(() => docToPlainText(content));
  return (
    <textarea
      className={styles.textarea}
      aria-label="Notizinhalt"
      defaultValue={initial}
      placeholder={placeholder}
      autoFocus={autoFocus}
      onChange={(e) => onChange(plainTextToDoc(e.target.value))}
    />
  );
}
