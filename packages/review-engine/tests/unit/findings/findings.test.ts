import { describe, expect, it } from "vitest";
import { parseReviewContext } from "../../../src/context/parse-context.js";
import { createLocationValidator } from "../../../src/findings/finding-location.js";
import { dedupeFindings, sortFindings } from "../../../src/findings/finding-order.js";
import {
  findingDraftSchema,
  findingSchema,
  type ReviewFinding,
} from "../../../src/findings/finding.schema.js";
import { ruleIdSchema } from "../../../src/findings/rule-id.js";
import { compareSeverity, highestSeverity } from "../../../src/findings/severity.js";
import { MAX_EVIDENCE_ITEMS, MAX_MESSAGE_LENGTH } from "../../../src/limits.js";
import { buildContext, buildFile } from "../../helpers/builders.js";

function buildFinding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    ruleId: "example-rule",
    severity: "medium",
    confidence: 1,
    message: "Something needs attention.",
    evidence: [{ label: "Reason", value: "Because" }],
    ...overrides,
  };
}

describe("severity", () => {
  it("orders severities from low to critical", () => {
    expect(compareSeverity("low", "critical")).toBeLessThan(0);
    expect(compareSeverity("high", "medium")).toBeGreaterThan(0);
    expect(compareSeverity("medium", "medium")).toBe(0);
  });

  it("finds the highest severity", () => {
    expect(highestSeverity(["low", "high", "medium"])).toBe("high");
    expect(highestSeverity([])).toBeUndefined();
  });
});

describe("ruleIdSchema", () => {
  it.each(["a", "pr-description", "max-changed-files", "rule2", "no-console-2"])(
    "accepts %s",
    (id) => {
      expect(ruleIdSchema.safeParse(id).success).toBe(true);
    },
  );

  it.each([
    "",
    "PR-Description",
    "-leading",
    "trailing-",
    "double--hyphen",
    "has space",
    "2fast",
    "under_score",
    "a".repeat(65),
  ])("rejects %j", (id) => {
    expect(ruleIdSchema.safeParse(id).success).toBe(false);
  });
});

describe("finding schemas", () => {
  const draft = { message: "A message.", evidence: [{ label: "Fact", value: "Value" }] };

  it("accepts a minimal draft and a full finding", () => {
    expect(findingDraftSchema.safeParse(draft).success).toBe(true);
    expect(
      findingSchema.safeParse(
        buildFinding({ filePath: "src/a.ts", line: 3, suggestion: "Do this." }),
      ).success,
    ).toBe(true);
  });

  it.each([
    ["no evidence", { ...draft, evidence: [] }],
    [
      "too much evidence",
      {
        ...draft,
        evidence: Array.from({ length: MAX_EVIDENCE_ITEMS + 1 }, () => draft.evidence[0]),
      },
    ],
    ["an empty message", { ...draft, message: "" }],
    ["an oversized message", { ...draft, message: "x".repeat(MAX_MESSAGE_LENGTH + 1) }],
    ["a confidence above one", { ...draft, confidence: 1.1 }],
    ["a negative confidence", { ...draft, confidence: -0.1 }],
    ["an unknown severity", { ...draft, severity: "urgent" }],
    ["line zero", { ...draft, filePath: "src/a.ts", line: 0 }],
    ["a fractional line", { ...draft, filePath: "src/a.ts", line: 1.5 }],
    ["an unsafe file path", { ...draft, filePath: "../a.ts" }],
    ["an unknown field", { ...draft, ruleId: "spoofed-rule" }],
    [
      "evidence with an unknown field",
      { ...draft, evidence: [{ label: "a", value: "b", extra: 1 }] },
    ],
  ])("rejects a draft with %s", (_name, candidate) => {
    expect(findingDraftSchema.safeParse(candidate).success).toBe(false);
  });
});

describe("createLocationValidator", () => {
  const patch = "@@ -4,3 +4,4 @@\n four\n-five\n+FIVE\n+five and a half\n six";
  const { files } = parseReviewContext(
    buildContext({
      files: [
        buildFile({ path: "src/edited.ts", additions: 2, deletions: 1, patch }),
        buildFile({ path: "src/removed.ts", status: "removed", additions: 0, deletions: 3 }),
        buildFile({ path: "assets/logo.png", status: "added", additions: 0, deletions: 0 }),
      ],
    }),
  );
  const validate = createLocationValidator(files);

  it("keeps a finding without a location", () => {
    const finding = buildFinding();

    expect(validate(finding)).toEqual({ finding });
  });

  it("keeps a file that is part of the diff", () => {
    const finding = buildFinding({ filePath: "src/edited.ts" });

    expect(validate(finding)).toEqual({ finding });
  });

  it.each([4, 5, 6, 7])("keeps line %i, which is on the new side of the patch", (line) => {
    const finding = buildFinding({ filePath: "src/edited.ts", line });

    expect(validate(finding)).toEqual({ finding });
  });

  it.each([1, 3, 8, 999])("removes line %i, which is outside the patch", (line) => {
    const result = validate(buildFinding({ filePath: "src/edited.ts", line }));

    expect(result.finding).toEqual(buildFinding({ filePath: "src/edited.ts" }));
    expect(result.removalReason).toBe(`line ${line} of "src/edited.ts" is not part of the diff`);
  });

  it("removes the file and line when the file is not in the diff", () => {
    const result = validate(buildFinding({ filePath: "src/elsewhere.ts", line: 4 }));

    expect(result.finding).toEqual(buildFinding());
    expect(result.removalReason).toBe('"src/elsewhere.ts" is not one of the changed files');
  });

  it("removes a line given without a file", () => {
    const result = validate(buildFinding({ line: 4 }));

    expect(result.finding).toEqual(buildFinding());
    expect(result.removalReason).toBe("a line was given without a file");
  });

  it("removes a line in a removed file but keeps the file", () => {
    const result = validate(buildFinding({ filePath: "src/removed.ts", line: 1 }));

    expect(result.finding).toEqual(buildFinding({ filePath: "src/removed.ts" }));
    expect(result.removalReason).toContain("was removed");
  });

  it("removes a line in a file without a patch but keeps the file", () => {
    const result = validate(buildFinding({ filePath: "assets/logo.png", line: 1 }));

    expect(result.finding).toEqual(buildFinding({ filePath: "assets/logo.png" }));
    expect(result.removalReason).toContain("has no patch");
  });
});

describe("finding order", () => {
  it("sorts by severity, then file, line, rule and message", () => {
    const findings = [
      buildFinding({ message: "g", severity: "low" }),
      buildFinding({ message: "f", severity: "high", filePath: "b.ts", line: 9 }),
      buildFinding({ message: "e", severity: "high", filePath: "b.ts", line: 2, ruleId: "z-rule" }),
      buildFinding({ message: "d", severity: "high", filePath: "b.ts", line: 2, ruleId: "a-rule" }),
      buildFinding({ message: "c", severity: "high", filePath: "a.ts", line: 50 }),
      buildFinding({ message: "b", severity: "high" }),
      buildFinding({ message: "a", severity: "critical", filePath: "z.ts" }),
      buildFinding({ message: "b", severity: "high" }),
      buildFinding({ message: "a2", severity: "high" }),
    ];

    expect(sortFindings(findings).map((finding) => finding.message)).toEqual([
      "a",
      "a2",
      "b",
      "b",
      "c",
      "d",
      "e",
      "f",
      "g",
    ]);
  });

  it("does not modify the array it sorts", () => {
    const findings = [buildFinding({ severity: "low" }), buildFinding({ severity: "high" })];

    sortFindings(findings);

    expect(findings.map((finding) => finding.severity)).toEqual(["low", "high"]);
  });

  it("removes findings with the same rule, location and message", () => {
    const findings = [
      buildFinding({ filePath: "a.ts", line: 1 }),
      buildFinding({ filePath: "a.ts", line: 1, severity: "critical" }),
      buildFinding({ filePath: "a.ts", line: 2 }),
      buildFinding({ filePath: "a.ts", line: 1, ruleId: "other-rule" }),
      buildFinding({ filePath: "a.ts", line: 1, message: "Different." }),
      buildFinding(),
      buildFinding(),
    ];

    expect(dedupeFindings(findings)).toEqual([
      findings[0],
      findings[2],
      findings[3],
      findings[4],
      findings[5],
    ]);
  });
});
