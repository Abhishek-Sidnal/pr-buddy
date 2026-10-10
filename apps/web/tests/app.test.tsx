import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildDetails,
  buildSummary,
  fakeApi,
  FIRST_PAGE,
  HEAD_SHA,
  ME,
  OVERVIEW,
  renderApp,
  REPOSITORIES,
  REVIEW_ID,
} from "./helpers.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** A signed-in API with data for every page. */
function signedIn(extra: Parameters<typeof fakeApi>[0] = {}): ReturnType<typeof fakeApi> {
  return fakeApi({
    "/api/me": ME,
    "/api/overview": OVERVIEW,
    "/api/repositories": REPOSITORIES,
    "/api/repositories/2002/reviews": FIRST_PAGE,
    [`/api/reviews/${REVIEW_ID}`]: buildDetails(),
    ...extra,
  });
}

const hrefOf = (name: string | RegExp): string | null =>
  screen.getByRole("link", { name }).getAttribute("href");

describe("signed out", () => {
  it("shows the sign-in page, whatever address was opened", async () => {
    const { requests } = fakeApi({ "/api/me": 401 });

    renderApp("/reviews/anything");

    expect(await screen.findByRole("link", { name: "Sign in with GitHub" })).toBeDefined();
    expect(hrefOf("Sign in with GitHub")).toBe("/auth/login");
    expect(screen.queryByRole("navigation")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    // Nothing else is asked for until someone is signed in.
    expect(requests).toEqual(["GET /api/me"]);
  });

  it("says so when sign-in did not complete", async () => {
    fakeApi({ "/api/me": 401 });

    renderApp("/?sign-in=failed");

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Sign-in did not complete. Please try again.",
    );
  });

  it("shows an error, not the sign-in page, when the service is failing", async () => {
    fakeApi({ "/api/me": 500 });

    renderApp();

    expect((await screen.findByRole("alert")).textContent).toContain(
      "The data could not be loaded.",
    );
    expect(screen.queryByRole("link", { name: "Sign in with GitHub" })).toBeNull();
  });
});

describe("the overview", () => {
  it("shows who is signed in, the totals and recent reviews", async () => {
    signedIn();

    renderApp();

    expect(await screen.findByRole("heading", { name: "Overview" })).toBeDefined();
    expect(screen.getByText("octocat")).toBeDefined();
    const reviews = (await screen.findByText("Reviews")).closest("div");
    expect(reviews?.textContent).toBe("Reviews12");
    expect(screen.getByText("Failed reviews").closest("div")?.textContent).toBe("Failed reviews1");
    expect(hrefOf("acme/widgets")).toBe("/repositories/2002");
    expect(hrefOf("#7")).toBe("https://github.com/acme/widgets/pull/7");
    expect(hrefOf("9b8c7d6")).toBe(`https://github.com/acme/widgets/commit/${HEAD_SHA}`);
    expect(screen.getByRole("link", { name: "#7" }).getAttribute("rel")).toBe(
      "noopener noreferrer",
    );
  });

  it("links each review by its time", async () => {
    signedIn();

    renderApp();

    const time = (await screen.findByRole("table")).querySelector("time");
    expect(time?.getAttribute("datetime")).toBe("2026-10-10T10:00:00.000Z");
    expect(time?.closest("a")?.getAttribute("href")).toBe(`/reviews/${REVIEW_ID}`);
  });

  it("describes reviews that were skipped, failed early or included AI suggestions", async () => {
    signedIn({
      "/api/overview": {
        ...OVERVIEW,
        recentReviews: [
          buildSummary({ id: "a", status: "skipped", skipReason: "draft", findingCount: 0 }),
          buildSummary({ id: "b", status: "failed", headSha: null, findingCount: 0 }),
          buildSummary({ id: "c", aiFindingCount: 3 }),
        ],
      },
    });

    renderApp();

    const rows = within(await screen.findByRole("table"))
      .getAllByRole("row")
      .slice(1);
    expect(rows.map((row) => row.lastElementChild?.textContent)).toEqual([
      "draft",
      "—",
      "2 + 3 AI",
    ]);
    expect(within(rows[1] as HTMLElement).getAllByRole("cell")[3]?.textContent).toBe("—");
  });

  it("says when there are no reviews", async () => {
    signedIn({ "/api/overview": { ...OVERVIEW, recentReviews: [] } });

    renderApp();

    expect(await screen.findByText("No reviews yet.")).toBeDefined();
  });

  it("explains an account with no installations", async () => {
    signedIn({ "/api/me": { ...ME, installationCount: 0 } });

    renderApp();

    expect(
      await screen.findByText(/GitHub lists no installation of PR Buddy that you can access/),
    ).toBeDefined();
  });

  it("offers to sign in again when the session ends while browsing", async () => {
    signedIn({ "/api/overview": 401 });

    renderApp();

    expect((await screen.findByRole("alert")).textContent).toContain("Your session has ended.");
    expect(hrefOf("Sign in again")).toBe("/auth/login");
  });
});

describe("signing out", () => {
  it("ends the session and returns to the sign-in page", async () => {
    const api = signedIn({ "/auth/logout": () => new Response(null, { status: 204 }) });
    renderApp();

    fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));
    api.set("/api/me", 401);

    expect(await screen.findByRole("link", { name: "Sign in with GitHub" })).toBeDefined();
    expect(api.requests).toContain("POST /auth/logout");
  });

  it("still asks who is signed in when the sign-out request fails", async () => {
    signedIn();
    renderApp();
    await screen.findByRole("button", { name: "Sign out" });
    const requests: string[] = [];
    vi.stubGlobal("fetch", (input: string, init?: RequestInit) => {
      requests.push(`${init?.method ?? "GET"} ${input}`);
      return init?.method === "POST"
        ? Promise.reject(new TypeError("offline"))
        : Promise.resolve(Response.json({ error: "unauthenticated" }, { status: 401 }));
    });

    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));

    expect(await screen.findByRole("link", { name: "Sign in with GitHub" })).toBeDefined();
    expect(requests.slice(0, 2)).toEqual(["POST /auth/logout", "GET /api/me"]);
  });
});

describe("repositories", () => {
  it("lists them with their latest review", async () => {
    signedIn();

    renderApp("/repositories");

    expect(await screen.findByRole("heading", { name: "Repositories" })).toBeDefined();
    const row = within(await screen.findByRole("table")).getAllByRole("row")[1] as HTMLElement;
    expect(
      within(row)
        .getAllByRole("cell")
        .map((cell) => cell.textContent),
    ).toEqual(["acme/widgets", "12", expect.stringContaining("2026") as string, "Completed"]);
    expect(hrefOf("acme/widgets")).toBe("/repositories/2002");
  });

  it("shows a repository that has never been reviewed", async () => {
    signedIn({
      "/api/repositories": {
        repositories: [{ ...REPOSITORIES.repositories[0], lastReviewedAt: null, lastStatus: null }],
      },
    });

    renderApp("/repositories");

    const row = within(await screen.findByRole("table")).getAllByRole("row")[1] as HTMLElement;
    expect(
      within(row)
        .getAllByRole("cell")
        .slice(2)
        .map((cell) => cell.textContent),
    ).toEqual(["—", "—"]);
  });

  it("explains an empty list", async () => {
    signedIn({ "/api/repositories": { repositories: [] } });

    renderApp("/repositories");

    expect(
      await screen.findByText(/No repository you can access has been reviewed yet/),
    ).toBeDefined();
  });

  it("opens a repository from the list", async () => {
    signedIn();
    renderApp("/repositories");

    fireEvent.click(await screen.findByRole("link", { name: "acme/widgets" }));

    expect(await screen.findByRole("heading", { name: "acme/widgets" })).toBeDefined();
  });
});

describe("one repository", () => {
  it("shows its reviews without a repository column, and a link to GitHub", async () => {
    signedIn();

    renderApp("/repositories/2002");

    expect(await screen.findByRole("heading", { name: "acme/widgets" })).toBeDefined();
    expect(hrefOf("Open on GitHub")).toBe("https://github.com/acme/widgets");
    expect(screen.queryByRole("columnheader", { name: "Repository" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Show older reviews" })).toBeNull();
  });

  it("adds older reviews below when asked", async () => {
    const api = signedIn({
      "/api/repositories/2002/reviews": (url) =>
        Response.json(
          url.searchParams.get("cursor") === "cursor-1"
            ? { ...FIRST_PAGE, reviews: [buildSummary({ id: "older", pullRequestNumber: 3 })] }
            : { ...FIRST_PAGE, nextCursor: "cursor-1" },
        ),
    });
    renderApp("/repositories/2002");

    fireEvent.click(await screen.findByRole("button", { name: "Show older reviews" }));

    expect(await screen.findByRole("link", { name: "#3" })).toBeDefined();
    expect(screen.getByRole("link", { name: "#7" })).toBeDefined();
    expect(api.requests).toContain("GET /api/repositories/2002/reviews?cursor=cursor-1");
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Show older reviews" })).toBeNull();
    });
  });

  it("keeps what is shown and reports it when older reviews cannot be loaded", async () => {
    signedIn({
      "/api/repositories/2002/reviews": (url) =>
        url.searchParams.has("cursor")
          ? Response.json({ error: "internal_error" }, { status: 500 })
          : Response.json({ ...FIRST_PAGE, nextCursor: "cursor-1" }),
    });
    renderApp("/repositories/2002");

    fireEvent.click(await screen.findByRole("button", { name: "Show older reviews" }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "The data could not be loaded.",
    );
    expect(screen.getByRole("link", { name: "#7" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Show older reviews" })).toBeDefined();
  });

  it("says the same for a repository that is hidden as for one that does not exist", async () => {
    signedIn();

    renderApp("/repositories/9999");

    expect((await screen.findByRole("alert")).textContent).toBe(
      "This page does not exist, or you do not have access to it.",
    );
  });
});

describe("one review", () => {
  it("shows the outcome, the finding with its evidence, and the rules", async () => {
    signedIn();

    renderApp(`/reviews/${REVIEW_ID}`);

    expect(await screen.findByRole("heading", { name: "Review of pull request #7" })).toBeDefined();
    expect(screen.getByText(/A summary comment was posted/)).toBeDefined();
    expect(screen.getByRole("heading", { name: "1 finding" })).toBeDefined();
    const finding = screen.getByText("A debugging statement was added.").closest("li");
    expect(finding?.textContent).toContain("Location: src/service.ts, line 12");
    expect(finding?.textContent).toContain("Statement: console.log");
    expect(finding?.textContent).toContain("Suggested action: Remove it before merging.");
    expect(finding?.textContent).toContain("Confidence 90%");
    expect(screen.getByRole("heading", { name: "Rules" })).toBeDefined();
    expect(screen.queryByRole("heading", { name: "AI review" })).toBeNull();
    expect(hrefOf("acme/widgets")).toBe("/repositories/2002");
  });

  it("renders stored text as text, never as markup or as a link", async () => {
    signedIn({
      [`/api/reviews/${REVIEW_ID}`]: buildDetails({
        repository: { id: 2002, owner: "javascript:alert(1)//", name: "x" },
        findings: [
          {
            ruleId: "<b>rule</b>",
            severity: "<i>high</i>",
            confidence: 1,
            message: '<img src=x onerror="alert(1)"> <script>alert(2)</script>',
            filePath: "src/<svg onload=alert(3)>.ts",
            line: null,
            suggestion: "[click](javascript:alert(4))",
            evidence: [{ label: "<u>l</u>", value: "<a href='https://evil.example'>v</a>" }],
          },
        ],
      }),
    });

    const { container } = renderApp(`/reviews/${REVIEW_ID}`);

    const message = await screen.findByText(
      '<img src=x onerror="alert(1)"> <script>alert(2)</script>',
    );
    const finding = message.closest("li");
    expect(finding?.querySelector("img, script, svg, b, i, u, a")).toBeNull();
    expect(container.querySelector("script, img, svg")).toBeNull();
    // An owner that is not a GitHub name gets no link to GitHub at all.
    expect(screen.getByText("#7").closest("a")).toBeNull();
    expect(screen.getByText("9b8c7d6").closest("a")).toBeNull();
    for (const link of screen.getAllByRole("link")) {
      expect(link.getAttribute("href")).toMatch(/^\//);
    }
    expect(finding?.querySelector(".severity-unknown")?.textContent).toBe("<i>high</i>");
  });

  it("shows a finding with nothing optional, and no rule table without rules", async () => {
    signedIn({
      [`/api/reviews/${REVIEW_ID}`]: buildDetails({
        findings: [
          {
            ruleId: "pr-description",
            severity: "medium",
            confidence: 1,
            message: "The description is empty.",
            filePath: "README.md",
            line: null,
            suggestion: null,
            evidence: [],
          },
        ],
        rules: [],
      }),
    });

    renderApp(`/reviews/${REVIEW_ID}`);

    const finding = (await screen.findByText("The description is empty.")).closest("li");
    expect(finding?.textContent).toContain("Location: README.md");
    expect(finding?.textContent).not.toContain("line");
    expect(finding?.textContent).not.toContain("Confidence");
    expect(finding?.textContent).not.toContain("Suggested action");
    expect(screen.queryByRole("heading", { name: "Rules" })).toBeNull();
  });

  it("shows what was hidden or left out, and a clean review", async () => {
    signedIn({
      [`/api/reviews/${REVIEW_ID}`]: buildDetails({
        findings: [],
        commentAction: "none",
        suppressedFindingCount: 2,
        skippedFileCount: 3,
        omittedPatchCount: 4,
      }),
    });

    renderApp(`/reviews/${REVIEW_ID}`);

    expect(await screen.findByText("Nothing was reported.")).toBeDefined();
    expect(screen.getByText(/No comment was needed/)).toBeDefined();
    expect(screen.getByText("Hidden by thresholds").parentElement?.textContent).toContain(
      "2 findings",
    );
    expect(screen.getByText("Files not reviewed").parentElement?.textContent).toContain("3");
    expect(screen.getByText("Diffs too large to load").parentElement?.textContent).toContain("4");
  });

  it.each([
    [{ status: "skipped", skipReason: "draft" } as const, "Skipped: draft"],
    [{ status: "skipped", skipReason: null } as const, "Skipped: no reason recorded"],
    [
      { status: "failed", errorName: "HttpError", errorStatus: 502, headSha: null } as const,
      "Failed: HttpError, HTTP 502",
    ],
    [{ status: "failed", errorName: null } as const, "Failed: unknown error"],
    [{ commentAction: "updated" } as const, "The summary comment was updated"],
    [{ commentAction: "something-new" } as const, "Completed"],
    [{ commentAction: null } as const, "Completed"],
  ])("describes the outcome %o", async (overrides, text) => {
    signedIn({
      [`/api/reviews/${REVIEW_ID}`]: buildDetails({ findings: [], rules: [], ...overrides }),
    });

    renderApp(`/reviews/${REVIEW_ID}`);

    const outcome = (await screen.findByText("Outcome")).parentElement;
    expect(outcome?.textContent).toContain(text);
  });

  it("says when the commit is not known", async () => {
    signedIn({
      [`/api/reviews/${REVIEW_ID}`]: buildDetails({ status: "failed", headSha: null }),
    });

    renderApp(`/reviews/${REVIEW_ID}`);

    expect(
      await screen.findByText("Not known: the review failed before the pull request was read"),
    ).toBeDefined();
  });

  it("shows the AI review record and says its text is not stored", async () => {
    const aiReview = {
      provider: "example",
      model: "model-1",
      status: "completed",
      failureReason: null,
      findingCount: 2,
      suppressedFindingCount: 0,
      rejectedFindingCount: 1,
      sentFileCount: 4,
      omittedFileCount: 1,
      inputTokens: 1_200,
      outputTokens: 80,
      durationMs: 2_400,
    };
    signedIn({ [`/api/reviews/${REVIEW_ID}`]: buildDetails({ aiReview, rules: [] }) });

    renderApp(`/reviews/${REVIEW_ID}`);

    expect(await screen.findByRole("heading", { name: "AI review" })).toBeDefined();
    expect(screen.getByText("Model").parentElement?.textContent).toBe("Modelexample/model-1");
    expect(screen.getByText("Result").parentElement?.textContent).toBe("Resultcompleted");
    expect(screen.getByText("Files sent").parentElement?.textContent).toBe(
      "Files sent4, 1 left out",
    );
    expect(screen.getByText("Tokens").parentElement?.textContent).toBe("Tokens1200 in, 80 out");
    expect(screen.getByText(/The text of AI suggestions is not stored/)).toBeDefined();
  });

  it("shows why an AI review failed, without token counts", async () => {
    const aiReview = {
      provider: "example",
      model: "model-1",
      status: "failed",
      failureReason: "timeout",
      findingCount: 0,
      suppressedFindingCount: 0,
      rejectedFindingCount: 0,
      sentFileCount: 1,
      omittedFileCount: 0,
      inputTokens: null,
      outputTokens: null,
      durationMs: 60_000,
    };
    signedIn({ [`/api/reviews/${REVIEW_ID}`]: buildDetails({ aiReview, rules: [] }) });

    renderApp(`/reviews/${REVIEW_ID}`);

    expect((await screen.findByText("Result")).parentElement?.textContent).toBe(
      "Resultfailed (timeout)",
    );
    expect(screen.queryByText("Tokens")).toBeNull();
  });

  it("reports a review that does not exist or is hidden", async () => {
    signedIn();

    renderApp("/reviews/00000000-0000-4000-8000-000000000000");

    expect((await screen.findByRole("alert")).textContent).toBe(
      "This page does not exist, or you do not have access to it.",
    );
  });
});

describe("navigation", () => {
  it("shows a not-found page for an unknown address", async () => {
    signedIn();

    renderApp("/no/such/page");

    expect(await screen.findByRole("heading", { name: "Page not found" })).toBeDefined();
  });

  it("moves between pages without reloading, and loads each page's data", async () => {
    const api = signedIn();
    renderApp();

    fireEvent.click(await screen.findByRole("link", { name: "Repositories" }));
    expect(await screen.findByRole("heading", { name: "Repositories" })).toBeDefined();
    fireEvent.click(screen.getByRole("link", { name: "Overview" }));
    expect(await screen.findByRole("heading", { name: "Overview" })).toBeDefined();

    expect(api.requests.filter((request) => request === "GET /api/me")).toHaveLength(1);
    expect(api.requests).toContain("GET /api/repositories");
  });

  it("ignores an answer that arrives after the page was left", async () => {
    let release: (response: Response) => void = () => undefined;
    signedIn({
      "/api/repositories": () => {
        // The answer is held back until the test lets it through.
        throw new Error("replaced below");
      },
    });
    const original = globalThis.fetch;
    vi.stubGlobal("fetch", (input: string, init?: RequestInit) =>
      input === "/api/repositories"
        ? new Promise<Response>((resolve) => {
            release = resolve;
          })
        : original(input, init),
    );
    renderApp("/repositories");
    await screen.findByRole("heading", { name: "Repositories" });

    fireEvent.click(screen.getByRole("link", { name: "Overview" }));
    await screen.findByRole("heading", { name: "Last 30 days" });
    release(Response.json({ repositories: [] }));

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Last 30 days" })).toBeDefined();
    });
    expect(screen.queryByText(/No repository you can access/)).toBeNull();
  });
});
