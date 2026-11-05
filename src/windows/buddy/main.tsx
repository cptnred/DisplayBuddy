import React from "react";
import ReactDOM from "react-dom/client";
import "../../styles/base.css";
import { BuddyApp } from "./BuddyApp";

// Transparent window: no page background may shine through.
document.documentElement.style.background = "transparent";
document.body.style.background = "transparent";

// Suppress the native WebView2 context menu everywhere in this window;
// BuddyApp opens the native buddy menu itself.
window.addEventListener("contextmenu", (e) => e.preventDefault(), { capture: true });

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <BuddyApp />
  </React.StrictMode>,
);
