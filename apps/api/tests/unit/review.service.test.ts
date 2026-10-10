import { SUMMARY_MARKER, type ReviewTrigger } from "@pr-buddy/github-client";
import { beforeEach, describe, expect, it } from "vitest";
import {
  CONFIGURATION_PATH,
  createReviewService,
  type ReviewService,
} from "../../src/modules/reviews/review.service.js";
import {
  BASE_SHA,
  FakeGitHub,
  HEAD_SHA,
  httpError,
  NEWER_HEAD_SHA,
} from "../helpers/fake-github.js";
import { createRecordingLogger, type RecordingLogger } from "../helpers/recording-logger.js";

const TRIGGER: ReviewTrigger = {
  action: "opened",
  installationId: 1001,
  repository: { id: 2002, owner: "acme", name: "widgets" },
  pullRequestNumber: 7,
};

let github: FakeGitHub;
let logger: RecordingLogger;
let service: ReviewService;

beforeEach(() => {
  github = new FakeGitHub();
  logger = createRecordingLogger();
  service = createReviewService({ clientFactory: github.clientFactory, logger });
});

/** Makes the fake pull request trip two rules: no description, and source without tests. */
function makeReviewable(): void {
  github.pullRequest = { ...github.pullRequest, body: null, changedFileCount: 1 };
  github.files = [{ path: "src/feature.ts", status: "added", additions: 10, deletions: 0 }];
}

describe("reviewing a pull request", () => {
  it("uses credentials scoped to the installation and repository that sent the event", async () => {
    await service.review(TRIGGER);

    expect(github.targets).toEqual([{ installationId: 1001, owner: "acme", repo: "widgets" }]);
  });

  it("publishes findings as one comment", async () => {
    makeReviewable();

    const outcome = await service.review(TRIGGER);

    expect(outcome).toEqual({
      status: "completed",
      headSha: HEAD_SHA,
      findingCount: 2,
      comment: "created",
    });
    expect(github.ownComments).toHaveLength(1);
    expect(github.ownComments[0]?.body).toContain(SUMMARY_MARKER);
    expect(github.ownComments[0]?.body).toContain("**2 findings**");
    expect(github.ownComments[0]?.body).toContain("` pr-description `");
    expect(github.ownComments[0]?.body).toContain("` missing-test-changes `");
  });

  it("posts nothing for a pull request with no findings", async () => {
    const outcome = await service.review(TRIGGER);

    expect(outcome).toEqual({
      status: "completed",
      headSha: HEAD_SHA,
      findingCount: 0,
      comment: "none",
    });
    expect(github.comments).toEqual([]);
  });

  it("updates its comment in place when the pull request is reviewed again", async () => {
    makeReviewable();
    await service.review(TRIGGER);
    const firstBody = github.ownComments[0]?.body;

    github.pullRequest = {
      ...github.pullRequest,
      body: "Now the author explains the change in enough detail.",
    };
    const outcome = await service.review(TRIGGER);

    expect(outcome).toMatchObject({ findingCount: 1, comment: "updated" });
    expect(github.ownComments).toHaveLength(1);
    expect(github.ownComments[0]?.body).not.toBe(firstBody);
    expect(github.ownComments[0]?.body).not.toContain("` pr-description `");
  });

  it("corrects its comment once every finding is resolved", async () => {
    makeReviewable();
    await service.review(TRIGGER);

    github.pullRequest = {
      ...github.pullRequest,
      body: "Now the author explains the change in enough detail.",
    };
    github.files = [
      ...github.files,
      { path: "src/feature.test.ts", status: "added", additions: 5, deletions: 0 },
    ];
    const outcome = await service.review(TRIGGER);

    expect(outcome).toMatchObject({ findingCount: 0, comment: "updated" });
    expect(github.ownComments).toHaveLength(1);
    expect(github.ownComments[0]?.body).toContain("**No findings**");
  });

  it("does not touch a comment that merely copies the marker", async () => {
    makeReviewable();
    github.comments = [
      { id: 1, body: `${SUMMARY_MARKER} pasted by a contributor`, byThisApp: false },
    ];

    await service.review(TRIGGER);

    expect(github.comments[0]?.body).toBe(`${SUMMARY_MARKER} pasted by a contributor`);
    expect(github.ownComments).toHaveLength(1);
  });

  it("reviews what the API returns, not what the webhook said", async () => {
    makeReviewable();

    await service.review({ ...TRIGGER, action: "edited" });

    expect(github.calls.slice(0, 2)).toEqual(["getPullRequest", "listPullRequestFiles"]);
  });
});

describe("pull requests that are not reviewed", () => {
  it("skips a closed pull request without reading its files", async () => {
    github.pullRequest = { ...github.pullRequest, state: "closed" };

    await expect(service.review(TRIGGER)).resolves.toEqual({ status: "skipped", reason: "closed" });
    expect(github.calls).toEqual(["getPullRequest"]);
  });

  it("skips a draft", async () => {
    makeReviewable();
    github.pullRequest = { ...github.pullRequest, isDraft: true };

    await expect(service.review(TRIGGER)).resolves.toEqual({ status: "skipped", reason: "draft" });
    expect(github.comments).toEqual([]);
  });

  it("reviews a draft once it is marked ready", async () => {
    makeReviewable();
    github.pullRequest = { ...github.pullRequest, isDraft: true };
    await service.review(TRIGGER);

    github.pullRequest = { ...github.pullRequest, isDraft: false };
    const outcome = await service.review({ ...TRIGGER, action: "ready_for_review" });

    expect(outcome).toMatchObject({ status: "completed", comment: "created" });
  });
});

describe("stale results", () => {
  it("discards the review when a new commit arrives while it runs", async () => {
    makeReviewable();
    github.beforeCall = (method, callNumber) => {
      if (method === "getPullRequest" && callNumber === 2) {
        github.pullRequest = { ...github.pullRequest, headSha: NEWER_HEAD_SHA };
      }
    };

    await expect(service.review(TRIGGER)).resolves.toEqual({ status: "skipped", reason: "stale" });
    expect(github.comments).toEqual([]);
    expect(github.calls).not.toContain("createComment");
  });

  it("discards the review when the pull request is closed while it runs", async () => {
    makeReviewable();
    github.beforeCall = (method, callNumber) => {
      if (method === "getPullRequest" && callNumber === 2) {
        github.pullRequest = { ...github.pullRequest, state: "closed" };
      }
    };

    await expect(service.review(TRIGGER)).resolves.toEqual({ status: "skipped", reason: "stale" });
    expect(github.comments).toEqual([]);
  });

  it("does not overwrite a newer review with an older one", async () => {
    makeReviewable();
    await service.review(TRIGGER);
    const published = github.ownComments[0]?.body;
    github.beforeCall = (method, callNumber) => {
      if (method === "getPullRequest" && callNumber === 4) {
        github.pullRequest = { ...github.pullRequest, headSha: NEWER_HEAD_SHA };
      }
    };

    await service.review(TRIGGER);

    expect(github.ownComments[0]?.body).toBe(published);
  });
});

describe("repository configuration", () => {
  it("reads the configuration file at the base commit, never at the head", async () => {
    await service.review(TRIGGER);

    expect(github.configurationRefs).toEqual([BASE_SHA]);
  });

  it("applies the repository's settings", async () => {
    makeReviewable();
    github.setConfiguration({
      rules: {
        "pr-description": { enabled: false },
        "missing-test-changes": { severity: "high" },
      },
    });

    const outcome = await service.review(TRIGGER);

    expect(outcome).toMatchObject({ findingCount: 1 });
    expect(github.ownComments[0]?.body).toContain("### High · ` missing-test-changes `");
    expect(github.ownComments[0]?.body).not.toContain("#### Notes");
  });

  it("can switch every rule off", async () => {
    makeReviewable();
    github.setConfiguration({
      rules: {
        "pr-description": { enabled: false },
        "max-changed-files": { enabled: false },
        "missing-test-changes": { enabled: false },
      },
    });

    await expect(service.review(TRIGGER)).resolves.toMatchObject({
      findingCount: 0,
      comment: "none",
    });
  });

  it.each([
    ["is not JSON", { status: "found", text: "rules: {}" } as const, "The file is not valid JSON."],
    ["is too large", { status: "too-large" } as const, "The file is larger than 64 KB."],
    [
      "names an unknown rule",
      { status: "found", text: '{"rules":{"no-such-rule":{}}}' } as const,
      "rules.no-such-rule: unknown rule.",
    ],
    [
      "has an invalid option",
      {
        status: "found",
        text: '{"rules":{"pr-description":{"options":{"minLength":0}}}}',
      } as const,
      "rules.pr-description.options.minLength:",
    ],
    ["is not an object", { status: "found", text: "[]" } as const, "expected object"],
  ])(
    "falls back to defaults and says so when the file %s",
    async (_name, configuration, expectedNote) => {
      makeReviewable();
      github.configuration = configuration;

      const outcome = await service.review(TRIGGER);

      expect(outcome).toMatchObject({ status: "completed", findingCount: 2 });
      const body = github.ownComments[0]?.body ?? "";
      expect(body).toContain(`The configuration in \` ${CONFIGURATION_PATH} \` is invalid`);
      expect(body).toContain(expectedNote);
    },
  );

  it("comments about invalid configuration even when there are no findings", async () => {
    github.configuration = { status: "found", text: "{" };

    const outcome = await service.review(TRIGGER);

    expect(outcome).toMatchObject({ findingCount: 0, comment: "created" });
    expect(github.ownComments[0]?.body).toContain("**No findings**");
    expect(github.ownComments[0]?.body).toContain("The file is not valid JSON.");
  });
});

describe("unusual diffs", () => {
  it("reviews an empty diff", async () => {
    github.files = [];
    github.pullRequest = { ...github.pullRequest, changedFileCount: 0 };

    await expect(service.review(TRIGGER)).resolves.toMatchObject({
      status: "completed",
      findingCount: 0,
    });
  });

  it("handles removed, binary, renamed and patch-less files", async () => {
    github.files = [
      { path: "src/old.ts", status: "removed", additions: 0, deletions: 40 },
      { path: "assets/logo.png", status: "added", additions: 0, deletions: 0 },
      {
        path: "src/moved.ts",
        previousPath: "src/original.ts",
        status: "renamed",
        additions: 0,
        deletions: 0,
      },
      { path: "package-lock.json", status: "modified", additions: 900, deletions: 850 },
    ];
    github.pullRequest = { ...github.pullRequest, changedFileCount: 4 };

    await expect(service.review(TRIGGER)).resolves.toMatchObject({
      status: "completed",
      findingCount: 0,
    });
  });

  it("skips a file with an unsafe path, reviews the rest and says so", async () => {
    makeReviewable();
    github.files = [
      ...github.files,
      { path: "../../etc/passwd", status: "added", additions: 1, deletions: 0 },
    ];
    github.pullRequest = { ...github.pullRequest, changedFileCount: 2 };

    const outcome = await service.review(TRIGGER);

    expect(outcome).toMatchObject({ status: "completed", findingCount: 2 });
    expect(github.ownComments[0]?.body).toContain("1 file could not be reviewed");
    expect(github.ownComments[0]?.body).not.toContain("etc/passwd");
  });

  it("says when a pull request has more files than can be listed", async () => {
    makeReviewable();
    github.pullRequest = { ...github.pullRequest, changedFileCount: 3_500 };

    await service.review(TRIGGER);

    expect(github.ownComments[0]?.body).toContain(
      "3499 files beyond the first listed by GitHub were not reviewed.",
    );
  });

  it("reports a very large pull request", async () => {
    github.files = Array.from({ length: 45 }, (_unused, index) => ({
      path: `src/file-${index}.test.ts`,
      status: "modified",
      additions: 1,
      deletions: 1,
    }));
    github.pullRequest = { ...github.pullRequest, changedFileCount: 45 };

    await service.review(TRIGGER);

    expect(github.ownComments[0]?.body).toContain("### Medium · ` max-changed-files `");
  });
});

describe("failures", () => {
  it.each([
    ["the pull request cannot be fetched", "getPullRequest", 404],
    ["the app lacks permission to list files", "listPullRequestFiles", 403],
    ["the configuration cannot be read", "getFileText", 403],
    ["GitHub's rate limit is reached while publishing", "createComment", 429],
    ["GitHub stays unavailable", "findOwnComment", 503],
  ] as const)("rejects when %s", async (_name, failingMethod, status) => {
    makeReviewable();
    github.beforeCall = (method) => {
      if (method === failingMethod) {
        throw httpError(status);
      }
    };

    await expect(service.review(TRIGGER)).rejects.toMatchObject({ status });
  });

  it("publishes nothing when the review fails before publishing", async () => {
    makeReviewable();
    github.beforeCall = (method) => {
      if (method === "listPullRequestFiles") {
        throw httpError(500);
      }
    };

    await expect(service.review(TRIGGER)).rejects.toThrow();
    expect(github.comments).toEqual([]);
  });

  it("rejects a pull request the engine cannot represent, such as one with an invalid commit ID", async () => {
    github.pullRequest = { ...github.pullRequest, headSha: "not-a-sha" };

    await expect(service.review(TRIGGER)).rejects.toMatchObject({ code: "INVALID_CONTEXT" });
    expect(github.comments).toEqual([]);
  });
});

describe("logging", () => {
  it("records the outcome with identifiers and counts", async () => {
    makeReviewable();

    await service.review(TRIGGER);

    expect(logger.entries).toEqual([
      {
        level: "info",
        message: "Review completed",
        fields: {
          repositoryId: 2002,
          pullRequestNumber: 7,
          headSha: HEAD_SHA,
          findingCount: 2,
          failedRuleCount: 0,
          skippedFileCount: 0,
          comment: "created",
        },
      },
    ]);
  });

  it("records why a review was skipped", async () => {
    github.pullRequest = { ...github.pullRequest, isDraft: true };

    await service.review(TRIGGER);

    expect(logger.entries[0]).toMatchObject({
      message: "Review skipped",
      fields: { reason: "draft" },
    });
  });

  it("never logs the title, description, file names or patches of a pull request", async () => {
    github.pullRequest = {
      ...github.pullRequest,
      title: "TITLE-CANARY",
      body: "BODY-CANARY",
    };
    github.files = [
      {
        path: "src/PATH-CANARY.ts",
        status: "added",
        additions: 1,
        deletions: 0,
        patch: "@@ -0,0 +1 @@\n+PATCH-CANARY",
      },
    ];

    await service.review(TRIGGER);

    expect(logger.text()).not.toMatch(/CANARY/);
  });
});
