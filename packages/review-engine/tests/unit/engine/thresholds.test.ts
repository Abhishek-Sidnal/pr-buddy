import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ConfigurationError,
  createReviewEngine,
  defineRule,
  RuleRegistry,
  type ReviewEngine,
} from "../../../src/index.js";
import { resolveReportThresholds } from "../../../src/config/resolve-config.js";
import { buildContext } from "../../helpers/builders.js";

const evidence = [{ label: "Reason", value: "Because" }];

/** A rule that reports one finding of each kind the thresholds can separate. */
const mixedRule = defineRule({
  id: "mixed-rule",
  version: "1.0.0",
  description: "Reports findings across severities and confidences.",
  defaultSeverity: "low",
  optionsSchema: z.strictObject({}),
  run: () => [
    { message: "critical and certain", evidence, severity: "critical", confidence: 1 },
    { message: "high but unsure", evidence, severity: "high", confidence: 0.4 },
    { message: "medium and fairly sure", evidence, severity: "medium", confidence: 0.8 },
    { message: "low and certain", evidence, severity: "low", confidence: 1 },
  ],
});

function engineWith(report?: unknown): ReviewEngine {
  return createReviewEngine({
    registry: new RuleRegistry([mixedRule]),
    config: report === undefined ? {} : { report },
  });
}

async function reported(report?: unknown): Promise<{ messages: string[]; suppressed: number }> {
  const result = await engineWith(report).review(buildContext());
  return {
    messages: result.findings.map((finding) => finding.message),
    suppressed: result.suppressedFindingCount,
  };
}

describe("reporting thresholds", () => {
  it("report everything by default", async () => {
    expect(engineWith().thresholds).toEqual({ minSeverity: "low", minConfidence: 0 });
    await expect(reported()).resolves.toEqual({
      messages: [
        "critical and certain",
        "high but unsure",
        "medium and fairly sure",
        "low and certain",
      ],
      suppressed: 0,
    });
  });

  it("hide findings below the minimum severity and count them", async () => {
    await expect(reported({ minSeverity: "high" })).resolves.toEqual({
      messages: ["critical and certain", "high but unsure"],
      suppressed: 2,
    });
  });

  it("hide findings below the minimum confidence and count them", async () => {
    await expect(reported({ minConfidence: 0.8 })).resolves.toEqual({
      messages: ["critical and certain", "medium and fairly sure", "low and certain"],
      suppressed: 1,
    });
  });

  it("apply both thresholds together", async () => {
    await expect(reported({ minSeverity: "medium", minConfidence: 0.5 })).resolves.toEqual({
      messages: ["critical and certain", "medium and fairly sure"],
      suppressed: 2,
    });
  });

  it("treat each threshold as inclusive", async () => {
    const { messages } = await reported({ minSeverity: "critical", minConfidence: 1 });

    expect(messages).toEqual(["critical and certain"]);
  });

  it("summarise only what is reported", async () => {
    const result = await engineWith({ minSeverity: "high" }).review(buildContext());

    expect(result.summary).toEqual({
      total: 2,
      bySeverity: { low: 0, medium: 0, high: 1, critical: 1 },
      highestSeverity: "critical",
    });
  });

  it("still run every rule and count what it found", async () => {
    const result = await engineWith({ minSeverity: "critical" }).review(buildContext());

    expect(result.rules).toEqual([
      expect.objectContaining({ ruleId: "mixed-rule", status: "completed", findingCount: 4 }),
    ]);
  });

  it("use the severity a configuration assigns to a rule", async () => {
    const engine = createReviewEngine({
      registry: new RuleRegistry([mixedRule]),
      config: { report: { minSeverity: "high" }, rules: { "mixed-rule": { severity: "low" } } },
    });

    const result = await engine.review(buildContext());

    expect(result.findings).toEqual([]);
    expect(result.suppressedFindingCount).toBe(4);
  });

  it.each([
    ["an unknown severity", { minSeverity: "urgent" }],
    ["a confidence above one", { minConfidence: 1.5 }],
    ["a negative confidence", { minConfidence: -0.1 }],
    ["a confidence that is not a number", { minConfidence: "high" }],
    ["an unknown setting", { minimumSeverity: "high" }],
    ["settings that are not an object", "high"],
  ])("reject %s", (_name, report) => {
    expect(() => engineWith(report)).toThrow(ConfigurationError);
  });

  it("are read from configuration on their own", () => {
    expect(resolveReportThresholds(undefined)).toEqual({ minSeverity: "low", minConfidence: 0 });
    expect(resolveReportThresholds({ report: { minConfidence: 0.7 } })).toEqual({
      minSeverity: "low",
      minConfidence: 0.7,
    });
    expect(() => resolveReportThresholds("nonsense")).toThrow(ConfigurationError);
  });
});
