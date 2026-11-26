import { defineConfig } from "vite";

// The channel (cli/channel-main.ts) as one self-contained file for node, served by Archnemesis.
export default defineConfig({
  ssr: { noExternal: true, target: "node" },
  build: {
    ssr: "cli/channel-main.ts",
    outDir: "dist",
    emptyOutDir: false,
    target: "node20",
    minify: true,
    rollupOptions: {
      output: { entryFileNames: "archnm-channel.mjs", format: "es", inlineDynamicImports: true },
    },
  },
});
