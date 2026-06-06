import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// opencascade.js ships a large .wasm that Vite must not try to pre-bundle.
// We load the wasm via `?url` + locateFile in src/cad/occt.ts.
export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    exclude: ["opencascade.js"],
  },
  server: {
    // Allow serving the wasm asset from node_modules.
    fs: { allow: [".."] },
  },
  // Large wasm: don't inline, and don't warn at our expected size.
  build: {
    chunkSizeWarningLimit: 50_000,
  },
});
