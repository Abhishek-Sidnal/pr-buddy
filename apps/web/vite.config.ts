import { defineConfig } from "vitest/config";

export default defineConfig({
  // Keep the cache in the root node_modules volume rather than in the package folder.
  cacheDir: "../../node_modules/.vite/web",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // The polyfill is an inline script, which the Content-Security-Policy forbids.
    modulePreload: { polyfill: false },
    // Source maps would publish the source next to the bundle; the repository is the place for it.
    sourcemap: false,
  },
  test: {
    environment: "jsdom",
    include: ["tests/**/*.test.{ts,tsx}"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      // The entry point only mounts the application; the image build covers it.
      exclude: ["src/main.tsx"],
      reporter: ["text", "html"],
      thresholds: {
        statements: 95,
        branches: 90,
        functions: 95,
        lines: 95,
      },
    },
  },
});
