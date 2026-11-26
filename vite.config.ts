import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";

// The app is served by server/main.ts (Vite runs inside it in dev), on 127.0.0.1:5190.
// `--mode static` (pnpm build:static) builds the server-less version: .env.static picks the
// local backend, and a relative base lets any static file server host it at any path.
//
// ORIGIN_TRIAL_TOKENS (comma-separated, build time only): Chrome origin-trial tokens for the
// address the build will be served from, each put in the page as a meta tag. This is how
// visitors' Chrome gets WebMCP (document.modelContext) without a flag while it is a trial;
// a token only works on the origin it was issued for.
const originTrials = (tokens: string | undefined): Plugin => ({
  name: "origin-trials",
  transformIndexHtml: () =>
    (tokens ?? "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean)
      .map((content) => ({
        tag: "meta",
        attrs: { "http-equiv": "origin-trial", content },
        injectTo: "head-prepend" as const,
      })),
});

export default defineConfig(({ mode }) => ({
  base: mode === "static" ? "./" : "/",
  plugins: [react(), originTrials(process.env.ORIGIN_TRIAL_TOKENS)],
  // Loaded on first use (Lay out); bundled up front so that first use doesn't reload the page in dev.
  optimizeDeps: { include: ["elkjs/lib/elk.bundled.js"] },
  test: {
    environment: "node",
    setupFiles: ["test/setup.ts"],
    include: ["src/**/*.test.ts", "server/**/*.test.ts", "shared/**/*.test.ts"],
  },
}));
