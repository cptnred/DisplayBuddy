import React from "react";
import ReactDOM from "react-dom/client";
import "../../styles/base.css";
import { NotesApp } from "./NotesApp";
// TEMPORARY: replaced by the TipTap NoteEditor (src/components/editor) during integration.
import { FallbackEditor } from "./FallbackEditor";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <NotesApp Editor={FallbackEditor} />
  </React.StrictMode>,
);
