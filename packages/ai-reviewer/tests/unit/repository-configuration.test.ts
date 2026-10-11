import { describe, expect, it } from "vitest";
import {
  CONFIGURATION_PATH,
  parseRepositoryConfiguration,
  type ConfigurationLookup,
} from "../../src/repository-configuration.js";

const found = (config: unknown): ConfigurationLookup => ({
  status: "found",
  text: typeof config === "string" ? config : JSON.stringify(config),
});

describe("a repository's configuration", () => {
  it("lives at one path", () => {
    expect(CONFIGURATION_PATH).toBe(".github/pr-buddy.json");
  });

  it("means hosted mode, no AI and no issues when there is no file", () => {
    const configuration = parseRepositoryConfiguration({ status: "missing" });

    expect(configuration).toMatchObject({ mode: "hosted", isAiEnabled: false, issues: [] });
  });

  it.each<[string, unknown]>([
    ["an empty file", {}],
    ["rules only", { rules: { "pr-description": { enabled: false } } }],
    ["an empty review section", { review: {} }],
    ["hosted, said out loud", { review: { mode: "hosted" } }],
  ])("means hosted mode for %s", (_name, config) => {
    expect(parseRepositoryConfiguration(found(config))).toMatchObject({
      mode: "hosted",
      issues: [],
    });
  });

  it("means runner mode only when the file says so and is valid as a whole", () => {
    const configuration = parseRepositoryConfiguration(
      found({ review: { mode: "runner" }, ai: { enabled: true } }),
    );

    expect(configuration).toMatchObject({ mode: "runner", isAiEnabled: true, issues: [] });
  });

  it("uses the engine the file configures", async () => {
    const configuration = parseRepositoryConfiguration(
      found({ review: { mode: "runner" }, rules: { "pr-description": { enabled: false } } }),
    );

    const result = await configuration.engine.review({
      pullRequest: {
        number: 1,
        title: "T",
        body: null,
        baseSha: "a".repeat(40),
        headSha: "b".repeat(40),
      },
      files: [],
    });
    expect(result.findings.map((finding) => finding.ruleId)).not.toContain("pr-description");
  });
});

describe("a configuration that is wrong in any part", () => {
  // Each of these asks for runner mode, or for AI, and is broken somewhere. None may get either.
  it.each<[string, ConfigurationLookup, RegExp]>([
    ["is too large", { status: "too-large" }, /larger than 64 KB/],
    ["is not JSON", found('{ "review": { "mode": "runner" }'), /not valid JSON/],
    ["has an unknown mode", found({ review: { mode: "both" } }), /^review\.mode: /],
    ["has a mode of the wrong type", found({ review: { mode: true } }), /^review\.mode: /],
    ["has a mode in another case", found({ review: { mode: "Runner" } }), /^review\.mode: /],
    [
      "has an unknown key beside the mode",
      found({ review: { mode: "runner", also: "hosted" } }),
      /^review: /,
    ],
    ["has a review section that is not an object", found({ review: "runner" }), /^review: /],
    [
      "is valid about the mode and wrong about AI",
      found({ review: { mode: "runner" }, ai: { enabled: "yes" } }),
      /^ai\.enabled: /,
    ],
    [
      "is valid about the mode and wrong about a rule",
      found({ review: { mode: "runner" }, rules: { "no-such-rule": {} } }),
      /no-such-rule/,
    ],
    [
      "is valid about the mode and has an unknown top-level key",
      found({ review: { mode: "runner" }, surprise: 1 }),
      /surprise/,
    ],
  ])("is not used at all when it %s", (_name, lookup, issue) => {
    const configuration = parseRepositoryConfiguration(lookup);

    expect(configuration.mode).toBe("hosted");
    expect(configuration.isAiEnabled).toBe(false);
    expect(configuration.issues.length).toBeGreaterThan(0);
    expect(configuration.issues.some((text) => issue.test(text))).toBe(true);
  });

  it.each([[[1, 2]], ["runner"], [null], [42]])(
    "is not used when the file holds %j and not an object",
    (config) => {
      const configuration = parseRepositoryConfiguration(found(config));

      expect(configuration.mode).toBe("hosted");
      expect(configuration.isAiEnabled).toBe(false);
    },
  );

  it("reports every part that is wrong, not only the first", () => {
    const { issues } = parseRepositoryConfiguration(
      found({ review: { mode: "both" }, ai: { enabled: "yes" } }),
    );

    expect(issues.some((text) => text.startsWith("review.mode: "))).toBe(true);
    expect(issues.some((text) => text.startsWith("ai.enabled: "))).toBe(true);
  });

  it("keeps an issue short, whatever the file held", () => {
    const { issues } = parseRepositoryConfiguration(found({ review: { mode: "x".repeat(5_000) } }));

    expect(issues.every((text) => text.length <= 300)).toBe(true);
  });

  it("falls back to the engine it was given", () => {
    const fallback = parseRepositoryConfiguration({ status: "missing" }).engine;

    expect(parseRepositoryConfiguration(found("not json"), fallback).engine).toBe(fallback);
    expect(parseRepositoryConfiguration({ status: "missing" }, fallback).engine).toBe(fallback);
  });
});
