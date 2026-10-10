import type { ReviewFinding } from "@pr-buddy/review-engine";
import { describe, expect, it } from "vitest";
import type {
  NewLineComment,
  RepositoryClient,
  ReviewComment,
} from "../../src/api/repository-client.js";
import {
  fingerprintOf,
  MAX_INLINE_COMMENTS,
  planInlineComments,
  publishInlineComments,
  renderInlineComment,
} from "../../src/output/inline-comments.js";

type LocatedFinding = ReviewFinding & { filePath: string; line: number };

function located(overrides: Partial<LocatedFinding> = {}): LocatedFinding {
  return {
    ruleId: "debug-statements",
    severity: "low",
    confidence: 0.9,
    message: "A console.log statement was added.",
    evidence: [{ label: "Statement", value: "console.log" }],
    filePath: "src/service.ts",
    line: 12,
    suggestion: "Remove it before merging.",
    ...overrides,
  };
}

function unlocated(): ReviewFinding {
  return {
    ruleId: "pr-description",
    severity: "low",
    confidence: 1,
    message: "The pull request has no description.",
    evidence: [{ label: "Description length", value: "0 characters" }],
  };
}

/** A comment as PR Buddy would have left it for a finding. */
function commentFor(finding: LocatedFinding, id: number): ReviewComment {
  return { id, body: renderInlineComment(finding) };
}

describe("fingerprintOf", () => {
  it("is the same for the same finding at the same place", () => {
    expect(fingerprintOf(located())).toBe(fingerprintOf(located()));
    expect(fingerprintOf(located())).toMatch(/^[0-9a-f]{16}$/);
  });

  it.each([
    ["line", { line: 13 }],
    ["file", { filePath: "src/other.ts" }],
    ["rule", { ruleId: "other-rule" }],
    ["message", { message: "A debugger statement was added." }],
  ])("changes with the %s", (_name, change) => {
    expect(fingerprintOf(located(change))).not.toBe(fingerprintOf(located()));
  });

  it("does not change with severity, confidence or suggestion", () => {
    const restyled = located({ severity: "high", confidence: 1, suggestion: "Something else." });

    expect(fingerprintOf(restyled)).toBe(fingerprintOf(located()));
  });
});

describe("renderInlineComment", () => {
  it("renders the finding with its fingerprint hidden at the end", () => {
    const finding = located();

    expect(renderInlineComment(finding)).toBe(
      [
        "**Low** · ` debug-statements `",
        "A console\\.log statement was added\\.",
        "**Suggested action:** Remove it before merging\\.",
        "_Confidence 90%: a signal to check, not a certainty._",
        `<!-- pr-buddy:finding:${fingerprintOf(finding)} -->`,
      ].join("\n\n"),
    );
  });

  it("leaves out the suggestion and the confidence note when there is nothing to say", () => {
    const certain = located({ confidence: 1 });
    const withoutSuggestion: LocatedFinding = {
      ruleId: certain.ruleId,
      severity: certain.severity,
      confidence: certain.confidence,
      message: certain.message,
      evidence: certain.evidence,
      filePath: certain.filePath,
      line: certain.line,
    };

    const body = renderInlineComment(withoutSuggestion);

    expect(body).not.toContain("Suggested action");
    expect(body).not.toContain("Confidence");
  });

  it("escapes text that could mention people or inject markup", () => {
    const body = renderInlineComment(located({ message: "Ask @octocat <b>now</b>" }));

    expect(body).not.toMatch(/@octocat/);
    expect(body).not.toContain("<b>");
  });
});

describe("planInlineComments", () => {
  it("posts a comment for each finding that has a file and a line", () => {
    const withoutLine: ReviewFinding = { ...unlocated(), filePath: "src/service.ts" };

    const plan = planInlineComments([located(), unlocated(), withoutLine], []);

    expect(plan.toDelete).toEqual([]);
    expect(plan.toCreate).toEqual([
      { path: "src/service.ts", line: 12, body: renderInlineComment(located()) },
    ]);
  });

  it("posts nothing when every finding already has its comment", () => {
    const findings = [located(), located({ line: 30 })];
    const existing = [commentFor(located(), 1), commentFor(located({ line: 30 }), 2)];

    expect(planInlineComments(findings, existing)).toEqual({ toCreate: [], toDelete: [] });
  });

  it("posts only the comments that are new", () => {
    const plan = planInlineComments([located(), located({ line: 30 })], [commentFor(located(), 1)]);

    expect(plan.toCreate.map((comment) => comment.line)).toEqual([30]);
    expect(plan.toDelete).toEqual([]);
  });

  it("removes a comment whose finding is gone", () => {
    const plan = planInlineComments([], [commentFor(located(), 7)]);

    expect(plan).toEqual({ toCreate: [], toDelete: [7] });
  });

  it("replaces a comment when its line moved", () => {
    const plan = planInlineComments(
      [located({ line: 14 })],
      [commentFor(located({ line: 12 }), 7)],
    );

    expect(plan.toDelete).toEqual([7]);
    expect(plan.toCreate.map((comment) => comment.line)).toEqual([14]);
  });

  it("removes a repeated comment and keeps one", () => {
    const plan = planInlineComments(
      [located()],
      [commentFor(located(), 1), commentFor(located(), 2)],
    );

    expect(plan).toEqual({ toCreate: [], toDelete: [2] });
  });

  it("never touches a comment that does not carry its marker", () => {
    const others = [
      { id: 50, body: "A reply the bot wrote for another purpose" },
      { id: 51, body: "<!-- pr-buddy:finding:not-a-fingerprint -->" },
    ];

    expect(planInlineComments([], others)).toEqual({ toCreate: [], toDelete: [] });
  });

  it("posts at most the limit, and removes comments for findings beyond it", () => {
    const findings = Array.from({ length: MAX_INLINE_COMMENTS + 5 }, (_unused, index) =>
      located({ line: index + 1 }),
    );
    const beyondLimit = commentFor(located({ line: MAX_INLINE_COMMENTS + 3 }), 9);

    const plan = planInlineComments(findings, [beyondLimit]);

    expect(plan.toCreate).toHaveLength(MAX_INLINE_COMMENTS);
    expect(plan.toDelete).toEqual([9]);
  });

  it("honours a smaller limit", () => {
    const findings = [located({ line: 1 }), located({ line: 2 }), located({ line: 3 })];

    expect(planInlineComments(findings, [], 2).toCreate.map((comment) => comment.line)).toEqual([
      1, 2,
    ]);
  });
});

interface Recorded {
  comments: ReviewComment[];
  reviews: { commitId: string; comments: readonly NewLineComment[] }[];
  deleted: number[];
}

function fakeClient(existing: ReviewComment[]): { client: RepositoryClient; recorded: Recorded } {
  const recorded: Recorded = { comments: existing, reviews: [], deleted: [] };
  const unsupported = (): never => {
    throw new Error("Not used by this test.");
  };
  const client: RepositoryClient = {
    getPullRequest: unsupported,
    listPullRequestFiles: unsupported,
    getFileText: unsupported,
    findOwnComment: unsupported,
    createComment: unsupported,
    updateComment: unsupported,
    listOwnReviewComments: () => Promise.resolve(recorded.comments),
    createReviewWithComments: (_number, commitId, comments) => {
      recorded.reviews.push({ commitId, comments });
      return Promise.resolve();
    },
    deleteReviewComment: (commentId) => {
      recorded.deleted.push(commentId);
      return Promise.resolve();
    },
  };
  return { client, recorded };
}

describe("publishInlineComments", () => {
  const HEAD_SHA = "b".repeat(40);

  it("posts new comments as one review on the reviewed commit", async () => {
    const { client, recorded } = fakeClient([]);

    const result = await publishInlineComments(client, 7, HEAD_SHA, [
      located(),
      located({ line: 30 }),
      unlocated(),
    ]);

    expect(result).toEqual({ created: 2, deleted: 0 });
    expect(recorded.reviews).toHaveLength(1);
    expect(recorded.reviews[0]?.commitId).toBe(HEAD_SHA);
    expect(recorded.reviews[0]?.comments.map((comment) => comment.line)).toEqual([12, 30]);
  });

  it("creates no review when there is nothing new to say", async () => {
    const { client, recorded } = fakeClient([commentFor(located(), 1)]);

    const result = await publishInlineComments(client, 7, HEAD_SHA, [located()]);

    expect(result).toEqual({ created: 0, deleted: 0 });
    expect(recorded.reviews).toEqual([]);
    expect(recorded.deleted).toEqual([]);
  });

  it("removes comments that no longer apply", async () => {
    const { client, recorded } = fakeClient([
      commentFor(located(), 1),
      commentFor(located({ line: 30 }), 2),
    ]);

    const result = await publishInlineComments(client, 7, HEAD_SHA, [located()]);

    expect(result).toEqual({ created: 0, deleted: 1 });
    expect(recorded.deleted).toEqual([2]);
  });

  it("does nothing for a review without located findings and without earlier comments", async () => {
    const { client, recorded } = fakeClient([]);

    await expect(publishInlineComments(client, 7, HEAD_SHA, [unlocated()])).resolves.toEqual({
      created: 0,
      deleted: 0,
    });
    expect(recorded.reviews).toEqual([]);
  });
});
