import { defineConfig } from "vitest/config";

export default defineConfig({
  // Keep the cache in the root node_modules volume rather than in the package folder.
  cacheDir: "../../node_modules/.vite/api",
  test: {
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // The entry point only wires real dependencies together; the container smoke test covers it.
      exclude: ["src/main.ts"],
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
