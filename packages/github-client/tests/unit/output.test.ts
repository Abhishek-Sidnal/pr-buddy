import { createReviewEngine, type ReviewFinding, type ReviewResult } from "@pr-buddy/review-engine";
import { describe, expect, it } from "vitest";
import type { RepositoryClient } from "../../src/api/repository-client.js";
import { escapeMarkdown, inlineCode } from "../../src/output/markdown.js";
import { publishReviewSummary } from "../../src/output/publish-summary.js";
import {
  renderReviewSummary,
  SUMMARY_MARKER,
  type SummaryNotes,
} from "../../src/output/render-summary.js";

const HEAD_SHA = "9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0c";
const NO_NOTES: SummaryNotes = {
  skippedFileCount: 0,
  unlistedFileCount: 0,
  configurationIssues: [],
  configurationPath: ".github/pr-buddy.json",
};

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

function buildResult(
  findings: ReviewFinding[] = [],
  ruleStatuses: ("completed" | "disabled" | "failed")[] = ["completed", "completed", "completed"],
): ReviewResult {
  const bySeverity = { low: 0, medium: 0, high: 0, critical: 0 };
  for (const finding of findings) {
    bySeverity[finding.severity] += 1;
  }
  return {
    pullRequest: { number: 5, baseSha: "a".repeat(40), headSha: HEAD_SHA },
    findings,
    rules: ruleStatuses.map((status, index) => ({
      ruleId: `rule-${index}`,
      ruleVersion: "1.0.0",
      status,
      findingCount: 0,
      durationMs: 1,
      ...(status === "failed" ? { error: "SECRET INTERNAL DETAIL at /srv/app/rule.js:10" } : {}),
    })),
    diagnostics: [],
    summary: { total: findings.length, bySeverity },
  };
}

describe("escapeMarkdown", () => {
  it("leaves plain words readable", () => {
    expect(escapeMarkdown("The pull request has no description")).toBe(
      "The pull request has no description",
    );
  });

  it("neutralises formatting, links and HTML", () => {
    expect(escapeMarkdown("**bold** [link](https://evil.example) <img src=x>")).toBe(
      "\\*\\*bold\\*\\* \\[link\\]\\(https://evil\\.example\\) \\<img src=x\\>",
    );
  });

  it("stops a mention from notifying anyone", () => {
    const escaped = escapeMarkdown("thanks @octocat and @acme/team");

    expect(escaped).not.toMatch(/@[A-Za-z]/);
    expect(escaped).toContain("@​octocat");
  });

  it("neutralises HTML entities and collapses whitespace", () => {
    expect(escapeMarkdown("a &lt; b\n\n  c\t d ")).toBe("a &amp;lt; b c d");
  });
});

describe("inlineCode", () => {
  it("wraps text in a code span", () => {
    expect(inlineCode("src/index.ts")).toBe("` src/index.ts `");
  });

  it("uses a fence longer than any run of backticks in the text", () => {
    expect(inlineCode("a`b")).toBe("`` a`b ``");
    expect(inlineCode("a```b``c")).toBe("```` a```b``c ````");
  });

  it("keeps the text on one line so it cannot end the span or start a block", () => {
    expect(inlineCode("first\n\n# heading\r\n- item")).toBe("` first # heading - item `");
  });
});

describe("renderReviewSummary", () => {
  it("starts with the hidden marker", () => {
    expect(renderReviewSummary(buildResult(), NO_NOTES).startsWith(SUMMARY_MARKER)).toBe(true);
  });

  it("says when there are no findings and how many checks ran", () => {
    const body = renderReviewSummary(
      buildResult([], ["completed", "completed", "disabled"]),
      NO_NOTES,
    );

    expect(body).toContain("**No findings** for commit ` 9b8c7d6 `. 2 checks ran.");
    expect(body).not.toContain("###");
    expect(body).not.toContain("#### Notes");
  });

  it("uses the singular for one check and one finding", () => {
    expect(renderReviewSummary(buildResult([], ["completed"]), NO_NOTES)).toContain("1 check ran.");
    expect(renderReviewSummary(buildResult([buildFinding()]), NO_NOTES)).toContain(
      "**1 finding** for commit ` 9b8c7d6 `: 1 medium.",
    );
  });

  it("counts findings by severity, most severe first", () => {
    const findings = [
      buildFinding({ severity: "critical" }),
      buildFinding({ severity: "low" }),
      buildFinding({ severity: "low" }),
      buildFinding({ severity: "high" }),
    ];

    expect(renderReviewSummary(buildResult(findings), NO_NOTES)).toContain(
      "**4 findings** for commit ` 9b8c7d6 `: 1 critical, 1 high, 2 low.",
    );
  });

  it("renders a finding with its evidence and suggestion", () => {
    const finding = buildFinding({
      ruleId: "max-changed-files",
      evidence: [
        { label: "Changed files counted", value: "42" },
        { label: "Configured maximum", value: "30" },
      ],
      suggestion: "Split the change.",
    });

    expect(renderReviewSummary(buildResult([finding]), NO_NOTES)).toContain(
      [
        "### Medium · ` max-changed-files `",
        "",
        "Something needs attention\\.",
        "",
        "- **Changed files counted:** ` 42 `",
        "- **Configured maximum:** ` 30 `",
        "",
        "**Suggested action:** Split the change\\.",
      ].join("\n"),
    );
  });

  it("shows a verified location", () => {
    const withLine = buildFinding({ filePath: "src/a.ts", line: 14 });
    const withoutLine = buildFinding({ filePath: "src/b.ts" });

    const body = renderReviewSummary(buildResult([withLine, withoutLine]), NO_NOTES);

    expect(body).toContain("- **Location:** ` src/a.ts `, line 14");
    expect(body).toContain("- **Location:** ` src/b.ts `\n");
  });

  it("explains a confidence below one and stays silent at one", () => {
    const uncertain = renderReviewSummary(
      buildResult([buildFinding({ confidence: 0.6 })]),
      NO_NOTES,
    );
    const certain = renderReviewSummary(buildResult([buildFinding()]), NO_NOTES);

    expect(uncertain).toContain("_Confidence 60%: a signal to check, not a certainty._");
    expect(certain).not.toContain("Confidence");
  });

  it("renders contributor-chosen file names so they cannot mention, link or inject HTML", () => {
    const hostileName = "@octocat [click](https://evil.example) <img src=x onerror=alert(1)> `x`";
    const finding = buildFinding({
      filePath: hostileName,
      evidence: [{ label: "Edited source files", value: hostileName }],
    });

    const body = renderReviewSummary(buildResult([finding]), NO_NOTES);

    expect(body).toContain(`- **Edited source files:** \`\` ${hostileName} \`\``);
    expect(body).toContain(`- **Location:** \`\` ${hostileName} \`\``);
    // Outside the two code spans the hostile text never appears.
    expect(body.split(`\`\` ${hostileName} \`\``).join("")).not.toContain("octocat");
  });

  it("escapes rule messages, labels and suggestions", () => {
    const finding = buildFinding({
      message: "See [docs](https://evil.example) @team",
      evidence: [{ label: "A *label*", value: "v" }],
      suggestion: "<b>Do it</b>",
    });

    const body = renderReviewSummary(buildResult([finding]), NO_NOTES);

    expect(body).not.toContain("[docs](https://evil.example)");
    expect(body).not.toContain("<b>");
    expect(body).toContain("- **A \\*label\\*:** ` v `");
  });

  it("reports how many checks failed without publishing their error text", () => {
    const body = renderReviewSummary(buildResult([], ["completed", "failed", "failed"]), NO_NOTES);

    expect(body).toContain("#### Notes");
    expect(body).toContain("- 2 checks could not run.");
    expect(body).not.toContain("SECRET INTERNAL DETAIL");
  });

  it("reports skipped and unlisted files", () => {
    const body = renderReviewSummary(buildResult(), {
      ...NO_NOTES,
      skippedFileCount: 1,
      unlistedFileCount: 250,
    });

    expect(body).toContain("- 1 file could not be reviewed because of an unusual path or format.");
    expect(body).toContain("- 250 files beyond the first listed by GitHub were not reviewed.");
  });

  it("uses the singular for one unlisted file", () => {
    const body = renderReviewSummary(buildResult(), { ...NO_NOTES, unlistedFileCount: 1 });

    expect(body).toContain("- 1 file beyond the first listed by GitHub was not reviewed.");
  });

  it("reports configuration problems as code", () => {
    const body = renderReviewSummary(buildResult(), {
      ...NO_NOTES,
      configurationIssues: ["rules.@everyone: unknown rule", "rules.pr-description.options: bad"],
    });

    expect(body).toContain(
      "- The configuration in ` .github/pr-buddy.json ` is invalid, so default settings were used:",
    );
    expect(body).toContain("  - ` rules.@everyone: unknown rule `");
    expect(body).toContain("  - ` rules.pr-description.options: bad `");
  });

  it("stays below GitHub's comment size limit and says how many findings were left out", () => {
    const large = buildFinding({
      message: "m".repeat(2_000),
      evidence: Array.from({ length: 20 }, (_unused, index) => ({
        label: `Evidence ${index}`,
        value: "v".repeat(1_000),
      })),
    });
    const findings = Array.from({ length: 10 }, () => large);

    const body = renderReviewSummary(buildResult(findings), NO_NOTES);

    expect(body.length).toBeLessThan(65_536);
    expect(body).toContain("**10 findings**");
    expect(body).toMatch(/_\d more findings? not shown to keep this comment readable\._/);
  });

  it("renders the findings of a real review", async () => {
    const result = await createReviewEngine().review({
      pullRequest: {
        number: 5,
        title: "Add lookup",
        body: null,
        baseSha: "a".repeat(40),
        headSha: HEAD_SHA,
      },
      files: [{ path: "src/user.service.ts", status: "added", additions: 10, deletions: 0 }],
    });

    const body = renderReviewSummary(result, NO_NOTES);

    expect(body).toContain("**2 findings** for commit ` 9b8c7d6 `: 2 low.");
    expect(body).toContain("### Low · ` missing-test-changes `");
    expect(body).toContain("### Low · ` pr-description `");
    expect(body).toContain("- **Edited source files:** ` src/user.service.ts `");
    expect(body).toContain("_Confidence 60%: a signal to check, not a certainty._");
    expect(body.endsWith("</sub>")).toBe(true);
  });
});

interface StoredComment {
  id: number;
  body: string;
}

function fakeClient(comments: StoredComment[]): RepositoryClient {
  const unsupported = (): never => {
    throw new Error("Not used by this test.");
  };
  return {
    getPullRequest: unsupported,
    listPullRequestFiles: unsupported,
    getFileText: unsupported,
    findOwnComment: (_number, marker) =>
      Promise.resolve(comments.find((comment) => comment.body.includes(marker))?.id),
    createComment: (_number, body) => {
      comments.push({ id: comments.length + 1, body });
      return Promise.resolve();
    },
    updateComment: (commentId, body) => {
      for (const comment of comments) {
        if (comment.id === commentId) {
          comment.body = body;
        }
      }
      return Promise.resolve();
    },
  };
}

describe("publishReviewSummary", () => {
  const body = `${SUMMARY_MARKER}\nNew summary`;

  it("creates the comment when there is none", async () => {
    const comments: StoredComment[] = [];

    const action = await publishReviewSummary(fakeClient(comments), 5, body, {
      createIfMissing: true,
    });

    expect(action).toBe("created");
    expect(comments).toEqual([{ id: 1, body }]);
  });

  it("updates the existing comment instead of adding another", async () => {
    const comments = [{ id: 1, body: `${SUMMARY_MARKER}\nOld summary` }];

    const action = await publishReviewSummary(fakeClient(comments), 5, body, {
      createIfMissing: true,
    });

    expect(action).toBe("updated");
    expect(comments).toEqual([{ id: 1, body }]);
  });

  it("is idempotent", async () => {
    const comments: StoredComment[] = [];
    const client = fakeClient(comments);

    await publishReviewSummary(client, 5, body, { createIfMissing: true });
    await publishReviewSummary(client, 5, body, { createIfMissing: true });

    expect(comments).toHaveLength(1);
  });

  it("stays quiet when there is nothing to say and no earlier comment", async () => {
    const comments: StoredComment[] = [];

    const action = await publishReviewSummary(fakeClient(comments), 5, body, {
      createIfMissing: false,
    });

    expect(action).toBe("none");
    expect(comments).toEqual([]);
  });

  it("still corrects an earlier comment when there is nothing new to say", async () => {
    const comments = [{ id: 1, body: `${SUMMARY_MARKER}\nOld findings` }];

    const action = await publishReviewSummary(fakeClient(comments), 5, body, {
      createIfMissing: false,
    });

    expect(action).toBe("updated");
    expect(comments[0]?.body).toBe(body);
  });
});
