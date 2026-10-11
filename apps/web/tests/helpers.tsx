import { render, type RenderResult } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { vi } from "vitest";
import type {
  Finding,
  Me,
  Overview,
  RepositoryList,
  ReviewDetails,
  ReviewListing,
  ReviewPage,
  ReviewSummary,
} from "../src/api/schemas.js";
import { App } from "../src/app.js";

export const HEAD_SHA = "9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0c";
export const REVIEW_ID = "11111111-1111-4111-8111-111111111111";

export const ME: Me = {
  login: "octocat",
  installationCount: 1,
  expiresAt: "2026-10-10T18:00:00.000Z",
  isOperator: false,
};

export function buildSummary(overrides: Partial<ReviewSummary> = {}): ReviewSummary {
  return {
    id: REVIEW_ID,
    repository: { id: 2002, owner: "acme", name: "widgets" },
    pullRequestNumber: 7,
    headSha: HEAD_SHA,
    status: "completed",
    skipReason: null,
    findingCount: 2,
    suppressedFindingCount: 0,
    aiFindingCount: null,
    startedAt: "2026-10-10T10:00:00.000Z",
    durationMs: 1_500,
    ...overrides,
  };
}

export const FINDING: Finding = {
  ruleId: "debug-statements",
  severity: "low",
  confidence: 0.9,
  message: "A debugging statement was added.",
  filePath: "src/service.ts",
  line: 12,
  suggestion: "Remove it before merging.",
  evidence: [{ label: "Statement", value: "console.log" }],
};

export function buildDetails(overrides: Partial<ReviewDetails> = {}): ReviewDetails {
  return {
    ...buildSummary(),
    baseSha: "a".repeat(40),
    commentAction: "created",
    skippedFileCount: 0,
    omittedPatchCount: 0,
    errorName: null,
    errorStatus: null,
    findings: [FINDING],
    rules: [
      {
        ruleId: "debug-statements",
        ruleVersion: "1.0.0",
        status: "completed",
        findingCount: 1,
        durationMs: 3,
      },
    ],
    aiReview: null,
    newerReviewId: null,
    ...overrides,
  };
}

export const OVERVIEW: Overview = {
  since: "2026-09-10T10:00:00.000Z",
  repositoryCount: 1,
  reviewCount: 12,
  completedCount: 9,
  skippedCount: 2,
  failedCount: 1,
  findingCount: 31,
  recentReviews: [buildSummary()],
};

export const REPOSITORIES: RepositoryList = {
  repositories: [
    {
      id: 2002,
      owner: "acme",
      name: "widgets",
      reviewCount: 12,
      lastReviewedAt: "2026-10-10T10:00:00.000Z",
      lastStatus: "completed",
    },
  ],
};

export const HISTORY: ReviewListing = { reviews: [buildSummary()], nextCursor: null };

export const FIRST_PAGE: ReviewPage = {
  repository: { id: 2002, owner: "acme", name: "widgets" },
  reviews: [buildSummary()],
  nextCursor: null,
};

/** What the fake API answers for a path: a body (status 200), a status alone, or a function. */
export type Answer = number | object | ((url: URL, init?: RequestInit) => Response);

export interface FakeApi {
  /** Every request made, as "METHOD /path?query". */
  readonly requests: string[];
  /** Replaces or adds the answer for a path. */
  set(path: string, answer: Answer): void;
}

/**
 * Replaces `fetch` with an in-memory API. Paths without an answer get 404, as the real API
 * gives for something that does not exist.
 */
export function fakeApi(answers: Record<string, Answer> = {}): FakeApi {
  const table = new Map(Object.entries(answers));
  const requests: string[] = [];
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(
      input instanceof Request ? input.url : input.toString(),
      "http://localhost",
    );
    requests.push(`${init?.method ?? "GET"} ${url.pathname}${url.search}`);
    const answer = table.get(url.pathname) ?? 404;
    if (typeof answer === "function") {
      return Promise.resolve(answer(url, init));
    }
    return Promise.resolve(
      typeof answer === "number"
        ? Response.json({ error: "error" }, { status: answer })
        : Response.json(answer),
    );
  });
  return {
    requests,
    set(path, answer) {
      table.set(path, answer);
    },
  };
}

/** Renders the whole application at a path, as the browser would open it. */
export function renderApp(path = "/"): RenderResult {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}
