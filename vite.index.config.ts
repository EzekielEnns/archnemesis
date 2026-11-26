import { defineConfig } from "vite";

// The repo script (cli/index-main.ts) as one CommonJS file, so `curl … | node -` runs it.
export default defineConfig({
  ssr: { noExternal: true, target: "node" },
  build: {
    ssr: "cli/index-main.ts",
    outDir: "dist",
    emptyOutDir: false,
    target: "node20",
    minify: true,
    rollupOptions: {
      output: { entryFileNames: "archnm-index.cjs", format: "cjs", inlineDynamicImports: true },
    },
  },
});
