import React from "react";
import ReactDOM from "react-dom/client";
import "../../styles/base.css";

function Placeholder() {
  return <div>notes</div>;
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Placeholder />
  </React.StrictMode>,
);
