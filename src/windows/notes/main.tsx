import React from "react";
import ReactDOM from "react-dom/client";
import "../../styles/base.css";
import { NoteEditor } from "../../components/editor/NoteEditor";
import { NotesApp } from "./NotesApp";

// Suppress the WebView's native context menu outside editable fields.
window.addEventListener("contextmenu", (e) => {
  const t = e.target as HTMLElement | null;
  if (!t?.closest('input, textarea, [contenteditable="true"]')) e.preventDefault();
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <NotesApp Editor={NoteEditor} />
  </React.StrictMode>,
);
