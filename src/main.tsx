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

const root = document.getElementById("root");
if (!root) throw new Error("no #root element");

createRoot(root).render(
  <StrictMode>
    <Profiler id="app" onRender={countCommit}>
      <App />
    </Profiler>
  </StrictMode>,
);
