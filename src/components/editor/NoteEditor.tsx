import { useEffect, useRef } from "react";
import type { Editor, JSONContent } from "@tiptap/core";
import { EditorContent, useEditor } from "@tiptap/react";
import { createExtensions, EMPTY_DOC } from "./extensions";
import { EmptyPlaceholder } from "./placeholder";
import { Toolbar } from "./Toolbar";
import styles from "./editor.module.css";

export const DEFAULT_PLACEHOLDER = "Notiz schreiben …";

export interface NoteEditorProps {
  /** Initial document. Read ONLY on mount – remount (`key={note.id}`) to load another note. */
  content: JSONContent | null;
  /** Called with `editor.getJSON()` after every document change (not on selection changes). */
  onChange: (doc: JSONContent) => void;
  autoFocus?: boolean;
  placeholder?: string;
  /**
   * Optional: receives the editor instance once it exists (tests, imperative focus).
   * Not part of the original contract; purely additive.
   */
  onReady?: (editor: Editor) => void;
}

export function NoteEditor({
  content,
  onChange,
  autoFocus = false,
  placeholder = DEFAULT_PLACEHOLDER,
  onReady,
}: NoteEditorProps) {
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  const editor = useEditor(
    {
      extensions: [...createExtensions(), EmptyPlaceholder.configure({ text: placeholder })],
      content: content ?? EMPTY_DOC,
      autofocus: autoFocus ? "end" : false,
      immediatelyRender: true,
      shouldRerenderOnTransaction: false,
      editorProps: {
        attributes: {
          "aria-label": "Notizinhalt",
          "aria-multiline": "true",
          role: "textbox",
          spellcheck: "true",
        },
      },
      onUpdate: ({ editor: e }) => onChangeRef.current(e.getJSON()),
    },
    // Content/placeholder are mount-only by contract; never recreate the editor.
    [],
  );

  useEffect(() => {
    if (editor) onReadyRef.current?.(editor);
  }, [editor]);

  return (
    <div className={styles.root}>
      <Toolbar editor={editor} />
      <EditorContent editor={editor} className={styles.content} />
    </div>
  );
}
