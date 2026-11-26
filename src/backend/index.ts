// The backend this build talks to, picked when it's built: VITE_BACKEND=server (the default,
// the Node server) or VITE_BACKEND=local (everything in this browser, no server at all).
// The other one isn't bundled.
import { createLocalBackend } from "./local.ts";
import { createServerBackend } from "./server.ts";
import type { Backend } from "./types.ts";

export const backend: Backend =
  import.meta.env.VITE_BACKEND === "local" ? createLocalBackend() : createServerBackend();
