import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildDetails,
  buildSummary,
  fakeApi,
  FINDING,
  FIRST_PAGE,
  HEAD_SHA,
  HISTORY,
  ME,
  OVERVIEW,
  renderApp,
  REPOSITORIES,
  REVIEW_ID,
} from "./helpers.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});

/** A signed-in API with data for every page. */
function signedIn(extra: Parameters<typeof fakeApi>[0] = {}): ReturnType<typeof fakeApi> {
  return fakeApi({
    "/api/me": ME,
    "/api/overview": OVERVIEW,
    "/api/repositories": REPOSITORIES,
    "/api/repositories/2002/reviews": FIRST_PAGE,
    "/api/reviews": HISTORY,
    [`/api/reviews/${REVIEW_ID}`]: buildDetails(),
    ...extra,
  });
}

const hrefOf = (name: string | RegExp): string | null =>
  screen.getByRole("link", { name }).getAttribute("href");

/** The cells of the data rows of the table on screen, as text. */
async function tableRows(): Promise<string[][]> {
  const rows = within(await screen.findByRole("table"))
    .getAllByRole("row")
    .slice(1);
  return rows.map((row) =>
    within(row)
      .getAllByRole("cell")
      .map((cell) => cell.textContent),
  );
}

/** The value shown beside a label in a list of facts or metrics. */
const valueOf = (label: string): string | null | undefined =>
  screen.getByText(label, { selector: "dt" }).nextElementSibling?.textContent;

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

  it("says what GitHub will share before the person leaves for GitHub", async () => {
    fakeApi({ "/api/me": 401 });

    renderApp();

    expect(await screen.findByRole("heading", { name: "What GitHub will share" })).toBeDefined();
    expect(screen.getByText(/Your GitHub login and ID/)).toBeDefined();
    expect(screen.getByText(/PR Buddy keeps no GitHub token/)).toBeDefined();
  });

  it("says so, and how to recover, when sign-in did not complete", async () => {
    fakeApi({ "/api/me": 401 });

    renderApp("/?sign-in=failed");

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Sign-in did not complete");
    expect(alert.textContent).toContain("Start again with the button below.");
  });

  it("shows a loading label while the session is checked", () => {
    vi.stubGlobal("fetch", () => new Promise(() => undefined));

    renderApp();

    expect(screen.getByRole("status").textContent).toContain("Checking your session…");
  });

  it("offers to try again, not to sign in, when the service is failing", async () => {
    const api = fakeApi({ "/api/me": 500 });
    renderApp();
    expect((await screen.findByRole("alert")).textContent).toContain(
      "The data could not be loaded.",
    );
    expect(screen.queryByRole("link", { name: "Sign in with GitHub" })).toBeNull();

    api.set("/api/me", 401);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByRole("link", { name: "Sign in with GitHub" })).toBeDefined();
  });
});

describe("the application shell", () => {
  it("lists only routes that exist, and marks the current one", async () => {
    signedIn();

    renderApp("/repositories");

    const navigation = await screen.findByRole("navigation", { name: "Main" });
    const links = within(navigation).getAllByRole("link");
    expect(links.map((link) => `${link.textContent} ${link.getAttribute("href") ?? ""}`)).toEqual([
      "Overview /",
      "Repositories /repositories",
      "Review history /history",
      "Settings /settings",
    ]);
    expect(links.filter((link) => link.getAttribute("aria-current") === "page")).toHaveLength(1);
    expect(within(navigation).getByRole("link", { current: "page" }).textContent).toBe(
      "Repositories",
    );
  });

  it("shows who is signed in and how many installations GitHub listed", async () => {
    signedIn();

    renderApp();

    expect(await screen.findByText("octocat")).toBeDefined();
    expect(screen.getByText("GitHub: 1 installation visible")).toBeDefined();
  });

  it("has a skip link to the content for keyboard users", async () => {
    signedIn();

    renderApp();

    await screen.findByRole("navigation", { name: "Main" });
    expect(screen.getByRole("main").id).toBe("content");
    expect(hrefOf("Skip to content")).toBe("#content");
  });

  it("hides every icon from assistive technology", async () => {
    signedIn();

    const { container } = renderApp();
    await screen.findByRole("table");

    const icons = [...container.querySelectorAll("svg")];
    expect(icons.length).toBeGreaterThan(5);
    expect(icons.every((icon) => icon.getAttribute("aria-hidden") === "true")).toBe(true);
  });

  it("explains an account with no installations", async () => {
    signedIn({ "/api/me": { ...ME, installationCount: 0 } });

    renderApp();

    expect(
      await screen.findByText("GitHub lists no installation of PR Buddy for you"),
    ).toBeDefined();
    expect(screen.getByText("GitHub: 0 installations visible")).toBeDefined();
  });

  it("shows a not-found page with a way back", async () => {
    signedIn();

    renderApp("/no/such/page");

    expect(await screen.findByRole("heading", { name: "Page not found" })).toBeDefined();
    expect(hrefOf("Go to the overview")).toBe("/");
  });

  it("moves between pages without asking again who is signed in", async () => {
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
    signedIn();
    const original = globalThis.fetch;
    vi.stubGlobal("fetch", (input: string, init?: RequestInit) =>
      input === "/api/repositories"
        ? new Promise<Response>((resolve) => {
            release = resolve;
          })
        : original(input, init),
    );
    renderApp("/repositories");
    expect(await screen.findByText("Loading repositories…")).toBeDefined();

    fireEvent.click(screen.getByRole("link", { name: "Overview" }));
    await screen.findByRole("heading", { name: "Last 30 days" });
    release(Response.json({ repositories: [] }));

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Last 30 days" })).toBeDefined();
    });
    expect(screen.queryByText("No reviewed repositories yet")).toBeNull();
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

describe("the overview", () => {
  it("shows totals that come from the API, linked to the history they count", async () => {
    signedIn();

    renderApp();

    expect(await screen.findByRole("heading", { name: "Last 30 days" })).toBeDefined();
    expect(valueOf("Reviews")).toBe("12");
    expect(valueOf("Findings")).toBe("31");
    expect(valueOf("Skipped reviews")).toBe("2");
    expect(valueOf("Failed reviews")).toBe("1");
    expect(hrefOf("12")).toBe("/history");
    expect(hrefOf("2")).toBe("/history?status=skipped");
    expect(hrefOf("1")).toBe("/history?status=failed");
  });

  it("lists recent reviews with links to the review, the repository and GitHub", async () => {
    signedIn();

    renderApp();

    const time = (await screen.findByRole("table")).querySelector("time");
    expect(time?.getAttribute("datetime")).toBe("2026-10-10T10:00:00.000Z");
    expect(time?.closest("a")?.getAttribute("href")).toBe(`/reviews/${REVIEW_ID}`);
    expect(hrefOf("acme/widgets")).toBe("/repositories/2002");
    expect(hrefOf("#7")).toBe("https://github.com/acme/widgets/pull/7");
    expect(hrefOf("9b8c7d6")).toBe(`https://github.com/acme/widgets/commit/${HEAD_SHA}`);
    expect(screen.getByRole("link", { name: "#7" }).getAttribute("rel")).toBe(
      "noopener noreferrer",
    );
    expect(hrefOf("See the full review history")).toBe("/history");
  });

  it("describes reviews that were skipped, failed early or included AI suggestions", async () => {
    signedIn({
      "/api/overview": {
        ...OVERVIEW,
        recentReviews: [
          buildSummary({ id: "a", status: "skipped", skipReason: "draft", findingCount: 0 }),
          buildSummary({ id: "b", status: "skipped", skipReason: "paused", findingCount: 0 }),
          buildSummary({ id: "c", status: "skipped", skipReason: null, findingCount: 0 }),
          buildSummary({ id: "d", status: "failed", headSha: null, findingCount: 0 }),
          buildSummary({ id: "e", aiFindingCount: 3 }),
        ],
      },
    });

    renderApp();

    const rows = await tableRows();
    expect(rows.map((row) => row.at(-1))).toEqual(["Draft", "paused", "—", "—", "2 + 3 AI"]);
    expect(rows.map((row) => row.at(-2))).toEqual([
      "Skipped",
      "Skipped",
      "Skipped",
      "Failed",
      "Completed",
    ]);
    expect(rows[3]?.[3]).toBe("—");
  });

  it("explains what to do when nothing has been reviewed", async () => {
    signedIn({ "/api/overview": { ...OVERVIEW, recentReviews: [] } });

    renderApp();

    expect(await screen.findByText("No reviews yet")).toBeDefined();
    expect(screen.getByText(/Open or push to a pull request there/)).toBeDefined();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("offers to sign in again when the session ends while browsing", async () => {
    signedIn({ "/api/overview": 401 });

    renderApp();

    expect((await screen.findByRole("alert")).textContent).toContain("Your session has ended.");
    expect(hrefOf("Sign in again")).toBe("/auth/login");
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("loads again when asked after a failure", async () => {
    const api = signedIn({ "/api/overview": 503 });
    renderApp();
    await screen.findByRole("alert");

    api.set("/api/overview", OVERVIEW);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByRole("heading", { name: "Last 30 days" })).toBeDefined();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("repositories", () => {
  it("lists them with their latest review", async () => {
    signedIn();

    renderApp("/repositories");

    expect(await tableRows()).toEqual([
      ["acme/widgets", "12", expect.stringContaining("2026") as string, "Completed"],
    ]);
    expect(hrefOf("acme/widgets")).toBe("/repositories/2002");
  });

  it("shows a repository that has never been reviewed", async () => {
    signedIn({
      "/api/repositories": {
        repositories: [{ ...REPOSITORIES.repositories[0], lastReviewedAt: null, lastStatus: null }],
      },
    });

    renderApp("/repositories");

    expect((await tableRows())[0]?.slice(2)).toEqual(["—", "—"]);
  });

  it("explains an empty list and where repositories are chosen", async () => {
    signedIn({ "/api/repositories": { repositories: [] } });

    renderApp("/repositories");

    expect(await screen.findByText("No reviewed repositories yet")).toBeDefined();
    expect(screen.getByText(/chosen on GitHub, in the app's installation settings/)).toBeDefined();
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
    expect(hrefOf(/Open on GitHub/)).toBe("https://github.com/acme/widgets");
    expect(screen.queryByRole("columnheader", { name: "Repository" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Show older reviews" })).toBeNull();
    expect(screen.getByText("1 review, all shown.")).toBeDefined();
    expect(
      within(screen.getByRole("navigation", { name: "Breadcrumb" }))
        .getByRole("link", { name: "Repositories" })
        .getAttribute("href"),
    ).toBe("/repositories");
  });

  it("offers no link to GitHub for a name GitHub could not have", async () => {
    signedIn({
      "/api/repositories/2002/reviews": {
        ...FIRST_PAGE,
        repository: { id: 2002, owner: "evil.example/x", name: "y" },
      },
    });

    renderApp("/repositories/2002");

    expect(await screen.findByRole("heading", { name: "evil.example/x/y" })).toBeDefined();
    expect(screen.queryByRole("link", { name: /Open on GitHub/ })).toBeNull();
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
    expect(await screen.findByText("2 reviews, all shown.")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Show older reviews" })).toBeNull();
  });

  it("says that older reviews are loading, and disables the button meanwhile", async () => {
    let release: (response: Response) => void = () => undefined;
    signedIn({
      "/api/repositories/2002/reviews": { ...FIRST_PAGE, nextCursor: "cursor-1" },
    });
    renderApp("/repositories/2002");
    const button = await screen.findByRole("button", { name: "Show older reviews" });
    vi.stubGlobal(
      "fetch",
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );

    fireEvent.click(button);

    const busy = await screen.findByRole("button", { name: "Loading older reviews…" });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    release(Response.json({ ...FIRST_PAGE, reviews: [] }));
    expect(await screen.findByText("1 review, all shown.")).toBeDefined();
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

  it("explains a repository without reviews", async () => {
    signedIn({ "/api/repositories/2002/reviews": { ...FIRST_PAGE, reviews: [] } });

    renderApp("/repositories/2002");

    expect(await screen.findByText("No reviews yet")).toBeDefined();
  });

  it("says the same for a repository that is hidden as for one that does not exist", async () => {
    signedIn();

    renderApp("/repositories/9999");

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(
      "This page does not exist, or you do not have access to it.",
    );
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });
});

describe("review history", () => {
  it("lists every review, with the repository and the reviewed commit", async () => {
    const api = signedIn();

    renderApp("/history");

    expect(await screen.findByRole("heading", { name: "Review history" })).toBeDefined();
    expect((await tableRows())[0]?.slice(1)).toEqual([
      "acme/widgets",
      "#7",
      "9b8c7d6",
      "Completed",
      "2",
    ]);
    expect(api.requests).toContain("GET /api/reviews");
    expect(screen.getByText(/there is no automatic retention limit yet/)).toBeDefined();
  });

  it("filters by outcome through the address", async () => {
    const api = signedIn({
      "/api/reviews": (url) =>
        Response.json(
          url.searchParams.get("status") === "failed"
            ? { reviews: [buildSummary({ id: "f", status: "failed" })], nextCursor: null }
            : HISTORY,
        ),
    });
    renderApp("/history");
    const filters = await screen.findByRole("navigation", { name: "Filter by outcome" });
    expect(within(filters).getByRole("link", { current: true }).textContent).toBe("All");

    fireEvent.click(within(filters).getByRole("link", { name: "Failed" }));

    await waitFor(() => {
      expect(api.requests).toContain("GET /api/reviews?status=failed");
    });
    expect((await tableRows())[0]?.at(-2)).toBe("Failed");
    expect(within(filters).getByRole("link", { current: true }).textContent).toBe("Failed");
    expect(within(filters).getByRole("link", { name: "Failed" }).getAttribute("href")).toBe(
      "/history?status=failed",
    );
  });

  it("restores the filter from a shared address", async () => {
    const api = signedIn();

    renderApp("/history?status=skipped");

    await screen.findByRole("table");
    expect(api.requests).toContain("GET /api/reviews?status=skipped");
  });

  it("ignores a filter value that is not an outcome", async () => {
    const api = signedIn();

    renderApp("/history?status=%27%20OR%201=1");

    await screen.findByRole("table");
    expect(api.requests).toContain("GET /api/reviews");
    expect(
      within(screen.getByRole("navigation", { name: "Filter by outcome" })).getByRole("link", {
        current: true,
      }).textContent,
    ).toBe("All");
  });

  it("says when a filter matches nothing and offers the way out", async () => {
    signedIn({ "/api/reviews": { reviews: [], nextCursor: null } });

    renderApp("/history?status=failed");

    expect(await screen.findByText("No failed reviews")).toBeDefined();
    expect(hrefOf("Show all reviews")).toBe("/history");
  });

  it("says when there is no history at all", async () => {
    signedIn({ "/api/reviews": { reviews: [], nextCursor: null } });

    renderApp("/history");

    expect(await screen.findByText("No reviews yet")).toBeDefined();
  });

  it("pages with the filter kept", async () => {
    const api = signedIn({
      "/api/reviews": (url) =>
        Response.json(
          url.searchParams.has("cursor")
            ? { reviews: [buildSummary({ id: "old", pullRequestNumber: 2 })], nextCursor: null }
            : { reviews: [buildSummary()], nextCursor: "c1" },
        ),
    });
    renderApp("/history?status=completed");

    fireEvent.click(await screen.findByRole("button", { name: "Show older reviews" }));

    expect(await screen.findByRole("link", { name: "#2" })).toBeDefined();
    expect(api.requests).toContain("GET /api/reviews?status=completed&cursor=c1");
  });
});

describe("one review", () => {
  const open = (path = `/reviews/${REVIEW_ID}`): ReturnType<typeof renderApp> => renderApp(path);

  it("identifies the pull request, the commit and the repository", async () => {
    signedIn();

    open();

    expect(await screen.findByRole("heading", { name: "Pull request #7" })).toBeDefined();
    const breadcrumb = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(
      within(breadcrumb).getByRole("link", { name: "acme/widgets" }).getAttribute("href"),
    ).toBe("/repositories/2002");
    expect(hrefOf(/Open on GitHub/)).toBe("https://github.com/acme/widgets/pull/7");
    expect(hrefOf("9b8c7d6")).toBe(`https://github.com/acme/widgets/commit/${HEAD_SHA}`);
    expect(document.querySelector(".page-description")?.textContent).toMatch(
      /^Reviewed .*2026.* in 1\.5 s at commit 9b8c7d6\.$/,
    );
  });

  it("summarises the outcome and counts findings by severity", async () => {
    signedIn({
      [`/api/reviews/${REVIEW_ID}`]: buildDetails({
        findings: [
          { ...FINDING, severity: "critical" },
          { ...FINDING, severity: "high" },
          { ...FINDING, severity: "high" },
          { ...FINDING, severity: "low" },
        ],
      }),
    });

    open();

    const summary = await screen.findByRole("region", { name: "Summary" });
    const cells = [...summary.querySelectorAll("dl > div")].map((cell) => cell.textContent);
    expect(cells).toEqual(["OutcomeCompleted", "Critical1", "High2", "Medium0", "Low1"]);
    expect(
      within(summary).getByText("A summary comment was posted on the pull request."),
    ).toBeDefined();
  });

  it("shows the selected finding with its rule, source, location, evidence and action", async () => {
    signedIn();

    open();

    const detail = await screen.findByRole("article", { name: "Selected finding" });
    expect(within(detail).getByRole("heading").textContent).toBe(
      "A debugging statement was added.",
    );
    expect(detail.querySelector(".finding-meta")?.textContent).toBe(
      "Lowdebug-statementsDeterministic rule",
    );
    const fact = (label: string): string | null | undefined =>
      within(detail).getByText(label, { selector: "dt" }).nextElementSibling?.textContent;
    expect(fact("Location")).toContain("src/service.ts, line 12");
    expect(fact("Statement")).toBe("console.log");
    expect(fact("Suggested action")).toBe("Remove it before merging.");
    expect(fact("Confidence")).toBe("90%: a signal to check, not a certainty.");
    expect(within(detail).getByText(/PR Buddy stores no source code/)).toBeDefined();
  });

  it("groups findings by severity and selects one through the address", async () => {
    const base = FINDING;
    signedIn({
      [`/api/reviews/${REVIEW_ID}`]: buildDetails({
        findings: [
          { ...base, severity: "high", message: "First.", ruleId: "rule-a" },
          { ...base, severity: "low", message: "Second.", ruleId: "rule-b", filePath: null },
          { ...base, severity: "low", message: "Third.", ruleId: "rule-c", line: null },
        ],
      }),
    });
    open();
    const list = await screen.findByRole("navigation", { name: "Findings" });
    expect(
      within(list)
        .getAllByRole("heading")
        .map((heading) => heading.textContent),
    ).toEqual(["High1", "Low2"]);
    expect(within(list).getByRole("link", { current: true }).textContent).toContain("First.");
    expect(
      within(list)
        .getAllByRole("link")
        .map((link) => link.getAttribute("href")),
    ).toEqual([
      "/reviews/" + REVIEW_ID + "?finding=1",
      "/reviews/" + REVIEW_ID + "?finding=2",
      "/reviews/" + REVIEW_ID + "?finding=3",
    ]);

    fireEvent.click(within(list).getByRole("link", { name: /Third\./ }));

    const detail = screen.getByRole("article", { name: "Selected finding" });
    expect(within(detail).getByRole("heading").textContent).toBe("Third.");
    expect(within(list).getByRole("link", { current: true }).textContent).toBe(
      "rule-cThird.src/service.ts",
    );
  });

  it("restores the selected finding from a shared address", async () => {
    const base = FINDING;
    signedIn({
      [`/api/reviews/${REVIEW_ID}`]: buildDetails({
        findings: [base, { ...base, message: "The second one.", filePath: null, line: null }],
      }),
    });

    open(`/reviews/${REVIEW_ID}?finding=2`);

    const detail = await screen.findByRole("article", { name: "Selected finding" });
    expect(within(detail).getByRole("heading").textContent).toBe("The second one.");
    expect(
      within(detail).getByText("Location", { selector: "dt" }).nextElementSibling?.textContent,
    ).toBe("The pull request as a whole");
    expect(within(detail).queryByRole("button", { name: "Copy path" })).toBeNull();
  });

  it.each(["0", "9", "-1", "abc", "1.5"])(
    "selects the first finding for the address value %s",
    async (value) => {
      signedIn();

      open(`/reviews/${REVIEW_ID}?finding=${value}`);

      const detail = await screen.findByRole("article", { name: "Selected finding" });
      expect(within(detail).getByRole("heading").textContent).toBe(
        "A debugging statement was added.",
      );
    },
  );

  it("copies a file path and says so", async () => {
    const written: string[] = [];
    signedIn();
    vi.stubGlobal("navigator", {
      clipboard: {
        writeText: (text: string) => {
          written.push(text);
          return Promise.resolve();
        },
      },
    });
    open();

    fireEvent.click(await screen.findByRole("button", { name: "Copy path" }));

    expect(await screen.findByRole("button", { name: "Path copied" })).toBeDefined();
    expect(written).toEqual(["src/service.ts"]);
  });

  it("says when a path could not be copied", async () => {
    signedIn();
    vi.stubGlobal("navigator", {
      clipboard: { writeText: () => Promise.reject(new Error("denied")) },
    });
    open();

    fireEvent.click(await screen.findByRole("button", { name: "Copy path" }));

    expect(await screen.findByRole("button", { name: "Could not copy" })).toBeDefined();
  });

  it("renders stored text as text, never as markup or as a link", async () => {
    signedIn({
      [`/api/reviews/${REVIEW_ID}`]: buildDetails({
        repository: { id: 2002, owner: "javascript:alert(1)//", name: "x" },
        findings: [
          {
            ruleId: "<b>rule</b>",
            severity: "<i>urgent</i>",
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

    const { container } = open();

    const detail = await screen.findByRole("article", { name: "Selected finding" });
    expect(within(detail).getByRole("heading").textContent).toBe(
      '<img src=x onerror="alert(1)"> <script>alert(2)</script>',
    );
    expect(detail.querySelector("img, script, b, i, u, a")).toBeNull();
    expect(container.querySelector("script, img, b, i, u")).toBeNull();
    // An owner that is not a GitHub name gets no link to GitHub at all.
    expect(screen.queryByRole("link", { name: /Open on GitHub/ })).toBeNull();
    expect(screen.getByText("9b8c7d6").closest("a")).toBeNull();
    for (const link of screen.getAllByRole("link")) {
      expect(link.getAttribute("href")).toMatch(/^[/#]/);
    }
    // A severity that is not one of the four is shown as written, under "Other".
    expect(detail.querySelector(".severity-unknown")?.textContent).toBe("<i>urgent</i>");
    expect(
      within(screen.getByRole("navigation", { name: "Findings" })).getByRole("heading").textContent,
    ).toBe("Other1");
  });

  it("shows a finding with nothing optional", async () => {
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

    open();

    const detail = await screen.findByRole("article", { name: "Selected finding" });
    expect(
      within(detail).getByText("Location", { selector: "dt" }).nextElementSibling?.textContent,
    ).toBe("README.mdCopy path");
    expect(within(detail).queryByText("Confidence")).toBeNull();
    expect(within(detail).queryByText("Suggested action")).toBeNull();
    expect(screen.queryByText(/Rules that ran/)).toBeNull();
  });

  it("describes a review with no findings accurately, and what was left out", async () => {
    signedIn({
      [`/api/reviews/${REVIEW_ID}`]: buildDetails({
        findings: [],
        commentAction: "none",
        suppressedFindingCount: 2,
        skippedFileCount: 1,
        omittedPatchCount: 1,
      }),
    });

    open();

    expect(await screen.findByText("No findings from the enabled checks.")).toBeDefined();
    const notes = [...document.querySelectorAll(".summary-notes li")].map(
      (note) => note.textContent,
    );
    expect(notes).toEqual([
      "There was nothing to report, so no comment was posted.",
      "2 findings below this repository's reporting thresholds are not shown.",
      "1 file could not be reviewed because of an unusual path or format.",
      "1 diff was too large to load; those files were checked by name only.",
    ]);
  });

  it("uses the singular and plural correctly in what was left out", async () => {
    signedIn({
      [`/api/reviews/${REVIEW_ID}`]: buildDetails({
        commentAction: "something-new",
        suppressedFindingCount: 1,
        omittedPatchCount: 3,
      }),
    });

    open();

    await screen.findByRole("region", { name: "Summary" });
    const notes = [...document.querySelectorAll(".summary-notes li")].map(
      (note) => note.textContent,
    );
    expect(notes).toEqual([
      "The review completed.",
      "1 finding below this repository's reporting thresholds is not shown.",
      "3 diffs were too large to load; those files were checked by name only.",
    ]);
  });

  it("marks a review of an older commit as out of date and links to the latest", async () => {
    signedIn({
      [`/api/reviews/${REVIEW_ID}`]: buildDetails({ newerReviewId: "newer-review" }),
    });

    open();

    expect(await screen.findByText("This review is out of date")).toBeDefined();
    expect(hrefOf("View the latest review")).toBe("/reviews/newer-review");
  });

  it("explains a failed review and that running it again is safe", async () => {
    signedIn({
      [`/api/reviews/${REVIEW_ID}`]: buildDetails({
        status: "failed",
        headSha: null,
        errorName: "HttpError",
        errorStatus: 502,
        commentAction: null,
        findings: [],
        rules: [],
      }),
    });

    open();

    const notice = (await screen.findByText("This review did not finish")).closest(".notice");
    expect(notice?.textContent).toContain("Reason recorded: HttpError, HTTP 502.");
    expect(notice?.textContent).toContain("Running it again is safe");
    expect(document.querySelector(".page-description")?.textContent).toContain(
      "The commit is not known",
    );
    // No counts and no findings section are shown for a review that produced none.
    expect(screen.queryByText("Critical")).toBeNull();
    expect(screen.queryByText(/Findings from deterministic rules/)).toBeNull();
  });

  it("explains a failure with no recorded details", async () => {
    signedIn({
      [`/api/reviews/${REVIEW_ID}`]: buildDetails({ status: "failed", findings: [] }),
    });

    open();

    const notice = (await screen.findByText("This review did not finish")).closest(".notice");
    expect(notice?.textContent).toContain("Reason recorded: unknown error.");
  });

  it.each([
    ["draft", "It is reviewed when it is marked ready for review."],
    ["closed", "closed or merged"],
    ["stale", "That commit has its own review."],
    ["paused", "Reason recorded: paused."],
    [null, "Reason recorded: none."],
  ])("explains a review skipped for the reason %s", async (skipReason, text) => {
    signedIn({
      [`/api/reviews/${REVIEW_ID}`]: buildDetails({ status: "skipped", skipReason, findings: [] }),
    });

    open();

    const notice = (await screen.findByText("This review was skipped")).closest(".notice");
    expect(notice?.textContent).toContain(text);
  });

  it("keeps AI suggestions apart, labelled as unverified, without their text", async () => {
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
    signedIn({ [`/api/reviews/${REVIEW_ID}`]: buildDetails({ aiReview }) });

    open();

    const section = await screen.findByRole("region", { name: /AI suggestions/ });
    expect(within(section).getByRole("heading").textContent).toBe(
      "AI suggestions AI suggestion, not verified",
    );
    expect(section.textContent).toContain("2 suggestions from a language model were published");
    expect(section.textContent).toContain("Their text is not stored here");
    const fact = (label: string): string | null | undefined =>
      within(section).getByText(label, { selector: "dt" }).nextElementSibling?.textContent;
    expect(fact("Model")).toBe("example/model-1");
    expect(fact("Files sent")).toBe("4, 1 left out");
    expect(fact("Tokens")).toBe("1200 in, 80 out");
    expect(fact("Time")).toBe("2.4 s");
    // The summary counts them separately from the rules' findings.
    expect(valueOf("AI suggestions")).toBe("2");
    expect(
      screen.getByRole("article", { name: "Selected finding" }).querySelector(".source-label")
        ?.textContent,
    ).toBe("Deterministic rule");
  });

  it("says one suggestion in the singular", async () => {
    const aiReview = {
      provider: "example",
      model: "model-1",
      status: "completed",
      failureReason: null,
      findingCount: 1,
      suppressedFindingCount: 0,
      rejectedFindingCount: 0,
      sentFileCount: 1,
      omittedFileCount: 0,
      inputTokens: null,
      outputTokens: null,
      durationMs: 900,
    };
    signedIn({ [`/api/reviews/${REVIEW_ID}`]: buildDetails({ aiReview }) });

    open();

    const section = await screen.findByRole("region", { name: /AI suggestions/ });
    expect(section.textContent).toContain("1 suggestion from a language model was published");
    expect(within(section).queryByText("Tokens")).toBeNull();
  });

  it.each([
    ["timeout", "could not be completed (timeout)"],
    [null, "could not be completed (no reason recorded)"],
  ])("says why an AI review failed: %s", async (failureReason, text) => {
    const aiReview = {
      provider: "example",
      model: "model-1",
      status: "failed",
      failureReason,
      findingCount: 0,
      suppressedFindingCount: 0,
      rejectedFindingCount: 0,
      sentFileCount: 1,
      omittedFileCount: 0,
      inputTokens: null,
      outputTokens: null,
      durationMs: 60_000,
    };
    signedIn({ [`/api/reviews/${REVIEW_ID}`]: buildDetails({ aiReview }) });

    open();

    const section = await screen.findByRole("region", { name: /AI suggestions/ });
    expect(section.textContent).toContain(text);
    expect(section.textContent).toContain("The deterministic checks above were not affected.");
  });

  it("keeps the rules that ran behind a disclosure", async () => {
    signedIn();

    open();

    const summary = await screen.findByText("Rules that ran (1)");
    const disclosure = summary.closest("details");
    expect(disclosure?.open).toBe(false);
    expect(disclosure?.querySelector("tbody")?.textContent).toBe(
      "debug-statements1.0.0completed13 ms",
    );
  });

  it("reports a review that does not exist or is hidden", async () => {
    signedIn();

    open("/reviews/00000000-0000-4000-8000-000000000000");

    expect((await screen.findByRole("alert")).textContent).toContain(
      "This page does not exist, or you do not have access to it.",
    );
  });
});

describe("settings", () => {
  it("shows the account, the session and what is stored", async () => {
    signedIn();

    renderApp("/settings");

    expect(await screen.findByRole("heading", { name: "Settings" })).toBeDefined();
    expect(valueOf("Signed in as")).toBe("octocat");
    expect(valueOf("Access")).toContain("1 installation of the app");
    expect(
      screen
        .getByText("Session ends", { selector: "dt" })
        .nextElementSibling?.querySelector("time")
        ?.getAttribute("datetime"),
    ).toBe(ME.expiresAt);
    expect(screen.getByText(/Never stored: pull request titles and descriptions/)).toBeDefined();
    expect(screen.getByText(/This dashboard is read-only and cannot change them/)).toBeDefined();
  });

  it("switches the theme at once and remembers it", async () => {
    signedIn();
    renderApp("/settings");
    const group = await screen.findByRole("group", { name: "Theme" });
    const option = (name: string): HTMLInputElement =>
      within(group).getByRole<HTMLInputElement>("radio", { name });
    expect(option("System").checked).toBe(true);
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);

    fireEvent.click(option("Dark"));

    expect(option("Dark").checked).toBe(true);
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(window.localStorage.getItem("prbuddy.theme")).toBe("dark");

    fireEvent.click(option("Light"));
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");

    fireEvent.click(option("System"));
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    expect(window.localStorage.getItem("prbuddy.theme")).toBe("system");
  });

  it("shows the remembered theme as selected", async () => {
    window.localStorage.setItem("prbuddy.theme", "light");
    signedIn();

    renderApp("/settings");

    const group = await screen.findByRole("group", { name: "Theme" });
    expect(within(group).getByRole<HTMLInputElement>("radio", { name: "Light" }).checked).toBe(
      true,
    );
  });

  it("signs out from the settings page as well", async () => {
    const api = signedIn({ "/auth/logout": () => new Response(null, { status: 204 }) });
    renderApp("/settings");
    await screen.findByRole("heading", { name: "Settings" });
    const main = screen.getByRole("main");

    fireEvent.click(within(main).getByRole("button", { name: "Sign out" }));
    api.set("/api/me", 401);

    expect(await screen.findByRole("link", { name: "Sign in with GitHub" })).toBeDefined();
  });
});
