import { defineConfig } from "vite";
import { crx } from "@crxjs/vite-plugin";
import manifest from "./manifest.prod.json" with { type: "json" };

export default defineConfig({
  plugins: [crx({ manifest })],
  build: {
    outDir: "build",
    emptyOutDir: true,
    sourcemap: false, // Disable source maps for production
    minify: "terser",
    terserOptions: {
      compress: {
        drop_console: false, // Keep console.log for extension debugging
      },
    },
    rollupOptions: {
      input: {
        inject_webapp: "src/injection/webapp.js",
        page_inject: "src/injection/page.js",
      },
    },
  },
  // Exclude test files from builds
  resolve: {
    alias: {
      // Prevent test files from being bundled
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  // Exclude test files and test setup
  optimizeDeps: {
    exclude: ['**/*.test.js', '**/*.spec.js', 'tests/**'],
  },
});
