import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  root: resolve(import.meta.dirname, "src/renderer"),
  base: "./",
  build: {
    emptyOutDir: true,
    outDir: resolve(import.meta.dirname, "dist/renderer"),
    sourcemap: false,
  },
});
