import { defineConfig } from "vite";
import { crx } from "@crxjs/vite-plugin";
import manifest from "./manifest.dev.json" with { type: "json" };

export default defineConfig({
  plugins: [crx({ manifest })],
  build: {
    outDir: "build",
    emptyOutDir: true,
    sourcemap: true, // Enable source maps for debugging
    rollupOptions: {
      input: {
        // injection/webapp.js and injection/page.js need to be separate (not bundled with content)
        inject_webapp: "src/injection/webapp.js",
        page_inject: "src/injection/page.js",
      },
    },
  },
  // Ensure consistent output structure
  server: {
    port: 5173,
    strictPort: true,
  },
});
