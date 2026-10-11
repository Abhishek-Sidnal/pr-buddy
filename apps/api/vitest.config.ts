import { defineConfig } from "vitest/config";

export default defineConfig({
  // Keep the cache in the root node_modules volume rather than in the package folder.
  cacheDir: "../../node_modules/.vite/api",
  test: {
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // The entry points only wire real dependencies together: the container smoke test covers the
      // service, and registering an app needs GitHub and a person.
      exclude: ["src/main.ts", "src/cli/**"],
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
