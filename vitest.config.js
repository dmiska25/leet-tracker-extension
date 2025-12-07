import { defineConfig } from "vite";

export default defineConfig({
  test: {
    globals: true,
    environment: "happy-dom",
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["src/**/*.js"],
      exclude: [
        "src/injection/**", // Integration-heavy, requires full browser
        "src/ui/**", // Visual components, manual testing preferred
        "**/*.test.js", // Don't include test files in coverage
        "**/*.spec.js",
      ],
      // Global thresholds - relaxed since we're excluding integration code
      // These represent current baseline - improve over time
      thresholds: {
        lines: 9,
        functions: 14,
        branches: 6,
        statements: 9,
        // Per-file thresholds for tested modules
        "src/core/config.js": {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        "src/core/utils.js": {
          lines: 90,
          functions: 100,
          branches: 75,
          statements: 90,
        },
        "src/tracking/snapshots.js": {
          lines: 19,
          functions: 30,
          branches: 12,
          statements: 19,
        },
        "src/leetcode/sync.js": {
          lines: 7,
          functions: 19,
          branches: 11,
          statements: 9,
        },
        "src/core/locks.js": {
          lines: 18,
          functions: 11,
          branches: 25,
          statements: 18,
        },
      },
    },
    setupFiles: ["./vitest.setup.js"],
  },
});
