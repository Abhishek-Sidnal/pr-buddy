import { describe, expect, it } from "vitest";
import { prDescriptionRule } from "../../../src/rules/pr-description.rule.js";
import { buildContext, runRuleWith } from "../../helpers/builders.js";

const run = (body: string | null, options?: unknown): ReturnType<typeof runRuleWith> =>
  runRuleWith(prDescriptionRule, buildContext({ pullRequest: { body } }), options);

describe("pr-description", () => {
  it("reports nothing for a description that explains the change", async () => {
    const body = "Fixes the login redirect loop by clearing the stale session cookie.";

    await expect(run(body)).resolves.toEqual([]);
  });

  it.each([
    ["a missing description", null],
    ["an empty description", ""],
    ["a whitespace-only description", " \n\t \r\n"],
    ["a description holding only template headings", "## What\n\n## Why\n\n### Testing\n"],
    ["a description holding only comments", "<!-- Describe your change -->\n<!--\nChecklist\n-->"],
  ])("reports %s as having no description", async (_name, body) => {
    const findings = await run(body);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      message: "The pull request has no description.",
      evidence: [
        { label: "Description length", value: expect.stringContaining("0 characters") as string },
        { label: "Configured minimum", value: "30 characters" },
      ],
    });
  });

  it("reports a description that is too short", async () => {
    const findings = await run("Fix bug");

    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toBe(
      "The pull request description is too short to explain the change.",
    );
    expect(findings[0]?.evidence[0]?.value).toContain("7 characters");
  });

  it("counts only the text the author wrote", async () => {
    const template = "## Summary\n<!-- What does this change? -->\nFix bug\n## Testing\n";

    const findings = await run(template);

    expect(findings[0]?.evidence[0]?.value).toContain("7 characters");
  });

  it("applies the minimum length as an inclusive boundary", async () => {
    await expect(run("x".repeat(30))).resolves.toEqual([]);
    await expect(run("x".repeat(29))).resolves.toHaveLength(1);
  });

  it("honours a configured minimum length", async () => {
    await expect(run("Fix bug", { minLength: 7 })).resolves.toEqual([]);
    await expect(run("x".repeat(99), { minLength: 100 })).resolves.toHaveLength(1);
  });

  it("ignores text hidden by an unterminated comment", async () => {
    const body = `<!-- ${"This long text is never rendered by GitHub. ".repeat(5)}`;

    await expect(run(body)).resolves.toHaveLength(1);
  });

  it("never reports a file or line", async () => {
    const [finding] = await run(null);

    expect(finding).not.toHaveProperty("filePath");
    expect(finding).not.toHaveProperty("line");
  });

  it.each([
    ["zero", { minLength: 0 }],
    ["a negative number", { minLength: -5 }],
    ["a fraction", { minLength: 10.5 }],
    ["a string", { minLength: "30" }],
    ["a value above the maximum", { minLength: 5_001 }],
    ["an unknown option", { minimumLength: 30 }],
  ])("rejects options with %s", (_name, options) => {
    expect(prDescriptionRule.optionsSchema.safeParse(options).success).toBe(false);
  });
});
