import js from "@eslint/js";
import tseslint from "typescript-eslint";

// Node.js modules the review engine must never use: it performs no I/O and never executes code.
const FORBIDDEN_ENGINE_MODULES = [
  "child_process",
  "cluster",
  "dgram",
  "dns",
  "fs",
  "fs/promises",
  "http",
  "http2",
  "https",
  "inspector",
  "module",
  "net",
  "os",
  "process",
  "repl",
  "tls",
  "vm",
  "worker_threads",
];

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/coverage/**", "**/node_modules/**"],
  },
  js.configs.recommended,
  {
    files: ["**/*.ts"],
    extends: [...tseslint.configs.strictTypeChecked, ...tseslint.configs.stylisticTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      eqeqeq: ["error", "always"],
      "no-console": "error",
      "no-eval": "error",
      "no-new-func": "error",
      "no-param-reassign": "error",
      "@typescript-eslint/no-implied-eval": "error",
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/explicit-module-boundary-types": "error",
      // Conflicts with no-non-null-assertion, which stays on: "!" is easier to overlook than "as".
      "@typescript-eslint/non-nullable-type-assertion-style": "off",
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
    },
  },
  {
    files: ["packages/review-engine/src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: FORBIDDEN_ENGINE_MODULES.flatMap((name) => [name, `node:${name}`]).map((name) => ({
            name,
            message: "The review engine performs no I/O and never executes code.",
          })),
        },
      ],
      "no-restricted-globals": [
        "error",
        { name: "process", message: "The review engine does not read the environment." },
        { name: "fetch", message: "The review engine performs no network I/O." },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "ImportExpression",
          message: "Dynamic import is forbidden: the engine never loads code at runtime.",
        },
      ],
    },
  },
);
