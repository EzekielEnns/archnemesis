import { Profiler, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles/index.css";
import { takeShareFromHash } from "./share";
import { countCommit, installPerf } from "./ui/Perf";

// Frame stalls, React commits and page errors: for the performance meter and bug reports.
installPerf();
// A share link in the address: keep its token for that design, and take it out of the address bar.
takeShareFromHash();
window.addEventListener("hashchange", takeShareFromHash);

// Browsers offer saved names and addresses in any text box they can guess a meaning for (an
// arrow's name, a box's). Nothing here is a form about you: only a box that asks for it by
// saying what it holds (autocomplete set, a password, an email) gets suggestions.
document.addEventListener(
  "focusin",
  (e) => {
    const el = e.target;
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return;
    if (el.hasAttribute("autocomplete") || el.type === "password" || el.type === "email") return;
    el.setAttribute("autocomplete", "off");
    el.setAttribute("data-1p-ignore", "");
    el.setAttribute("data-lpignore", "true");
    el.setAttribute("data-form-type", "other");
  },
  true,
);

const root = document.getElementById("root");
if (!root) throw new Error("no #root element");

createRoot(root).render(
  <StrictMode>
    <Profiler id="app" onRender={countCommit}>
      <App />
    </Profiler>
  </StrictMode>,
);
