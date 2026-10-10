import { readFileSync } from "node:fs";

function readJson(url: URL): unknown {
  return JSON.parse(readFileSync(url, "utf8")) as unknown;
}

export type ContextFixtureName =
  "added-files" | "empty-diff" | "feature-with-tests" | "removed-files" | "renamed-files";

/** Loads a review context from `tests/fixtures/contexts`. It is untrusted input, hence `unknown`. */
export function loadContextFixture(name: ContextFixtureName): unknown {
  return readJson(new URL(`../fixtures/contexts/${name}.json`, import.meta.url));
}

/** Loads the example configuration published in the repository's `examples` folder. */
export function loadExampleConfig(): unknown {
  return readJson(new URL("../../../../examples/prbuddy.config.json", import.meta.url));
}
