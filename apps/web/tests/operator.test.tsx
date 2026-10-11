import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OperatorOverview } from "../src/api/schemas.js";
import { fakeApi, ME, renderApp, type Answer } from "./helpers.js";

const OVERVIEW: OperatorOverview = {
  generatedAt: "2026-10-11T09:00:00.000Z",
  totals: { installations: 2, repositories: 5, people: 3 },
  reviews: {
    day: { completed: 4, skipped: 1, failed: 0 },
    week: { completed: 20, skipped: 3, failed: 2 },
    month: { completed: 61, skipped: 9, failed: 4 },
  },
  aiReviews: { completed: 12, skipped: 30, failed: 1 },
  pending: { count: 2, oldestRequestedAt: "2026-10-11T07:30:00.000Z" },
  queue: { running: 1, waiting: 3 },
  keysByProvider: [
    { provider: "anthropic", count: 1 },
    { provider: "bedrock", count: 2 },
  ],
  installations: [
    {
      installationId: 1001,
      account: "acme",
      repositoryCount: 3,
      reviewCount: 40,
      failedCount: 4,
      lastReviewAt: "2026-10-11T08:59:00.000Z",
      aiProvider: "bedrock",
    },
    {
      installationId: 9009,
      account: "rival",
      repositoryCount: 2,
      reviewCount: 0,
      failedCount: 0,
      lastReviewAt: null,
      aiProvider: null,
    },
  ],
};

const EMPTY_OVERVIEW = {
  since: "2026-09-10T00:00:00.000Z",
  repositoryCount: 0,
  reviewCount: 0,
  completedCount: 0,
  skippedCount: 0,
  failedCount: 0,
  findingCount: 0,
  recentReviews: [],
};

function open(
  options: { isOperator?: boolean; overview?: Answer; path?: string } = {},
): ReturnType<typeof fakeApi> {
  const api = fakeApi({
    "/api/me": { ...ME, isOperator: options.isOperator ?? true },
    "/auth/service": { appSlug: null },
    "/api/overview": EMPTY_OVERVIEW,
    "/api/installations": 404,
    "/api/operator/overview": options.overview ?? OVERVIEW,
  });
  renderApp(options.path ?? "/operator");
  return api;
}

const figures = (container: HTMLElement): Record<string, string> =>
  Object.fromEntries(
    [...container.querySelectorAll(".metric")].map((metric) => [
      metric.querySelector("dt")?.textContent ?? "",
      metric.querySelector("dd")?.textContent ?? "",
    ]),
  );

const rows = (table: HTMLElement): string[][] =>
  within(table)
    .getAllByRole("row")
    .slice(1)
    .map((row) => [...row.querySelectorAll("th, td")].map((cell) => cell.textContent));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the link to the operator's page", () => {
  it("is shown to an operator, after the ordinary pages", async () => {
    open({ path: "/" });

    const navigation = await screen.findByRole("navigation", { name: "Main" });
    const link = within(navigation).getByRole("link", { name: "Service" });
    expect(link.getAttribute("href")).toBe("/operator");
  });

  it("is not shown to anyone else, and the page is not there for them", async () => {
    const { requests } = open({ isOperator: false });

    expect(await screen.findByText("There is nothing at this address")).toBeDefined();
    expect(screen.queryByRole("link", { name: "Service" })).toBeNull();
    expect(requests).not.toContain("GET /api/operator/overview");
  });

  it("is not shown when the service does not say", async () => {
    fakeApi({
      "/api/me": { login: "octocat", installationCount: 1, expiresAt: ME.expiresAt },
      "/auth/service": { appSlug: null },
      "/api/overview": EMPTY_OVERVIEW,
    });

    renderApp("/");

    await screen.findByRole("navigation", { name: "Main" });
    expect(screen.queryByRole("link", { name: "Service" })).toBeNull();
  });
});

describe("the operator's page", () => {
  it("says what it is and who can open it", async () => {
    open();

    expect(await screen.findByRole("heading", { level: 1, name: "Service" })).toBeDefined();
    expect(screen.getByText(/Only people this deployment lists as its operators/)).toBeDefined();
  });

  it("shows the totals, with stored keys added up and listed by provider", async () => {
    open();

    const totals = await screen.findByRole("region", { name: "Totals" });
    expect(figures(totals)).toEqual({
      "Installations reviewed": "2",
      "Repositories reviewed": "5",
      "People signed in": "3",
      "Stored AI keys": "3",
    });
    expect(totals.textContent).toContain("Keys by provider: anthropic 1, bedrock 2.");
  });

  it("shows what is running, waiting and unfinished, and since when", async () => {
    open();

    const now = await screen.findByRole("region", { name: "Right now" });
    expect(figures(now)).toEqual({
      "Reviews running": "1",
      "Reviews waiting": "3",
      "Requested, not finished": "2",
    });
    expect(now.textContent).toContain("The oldest unfinished request is from");
    expect(now.querySelector("time")?.getAttribute("datetime")).toBe("2026-10-11T07:30:00.000Z");
    expect(now.textContent).toContain("Figures as of");
  });

  it("says so when nothing is unfinished", async () => {
    open({ overview: { ...OVERVIEW, pending: { count: 0, oldestRequestedAt: null } } });

    const now = await screen.findByRole("region", { name: "Right now" });
    expect(now.textContent).toContain("No review is waiting to be finished.");
  });

  it("shows reviews by outcome for each period, with a total", async () => {
    open();

    const table = await screen.findByRole("table", { name: "Reviews by outcome" });
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((header) => header.textContent),
    ).toEqual(["Period", "All", "Completed", "Skipped", "Failed"]);
    expect(rows(table)).toEqual([
      ["Reviews, last 24 hours", "5", "4", "1", "0"],
      ["Reviews, last 7 days", "25", "20", "3", "2"],
      ["Reviews, last 30 days", "74", "61", "9", "4"],
      ["AI reviews, last 30 days", "43", "12", "30", "1"],
    ]);
  });

  it("lists each installation with its account, counts, last review and AI provider", async () => {
    open();

    const table = await screen.findByRole("table", {
      name: "Installations, most recently active first",
    });
    const body = rows(table);
    expect(body[0]?.slice(0, 4)).toEqual(["acme 1001", "3", "40", "4"]);
    expect(body[0]?.[5]).toBe("bedrock");
    expect(table.querySelector("time")?.getAttribute("datetime")).toBe("2026-10-11T08:59:00.000Z");
    expect(body[1]).toEqual(["rival 9009", "2", "0", "0", "Never", "None"]);
  });

  it("says so when no installation has been reviewed", async () => {
    open({ overview: { ...OVERVIEW, installations: [], keysByProvider: [] } });

    expect(await screen.findByText("No installation has been reviewed yet")).toBeDefined();
    expect(screen.queryByText(/Keys by provider/)).toBeNull();
  });

  it("says that it leaves out what customers reviewed", async () => {
    open();

    const section = await screen.findByRole("region", { name: "Installations" });
    expect(section.textContent).toContain(
      "Repository names, pull requests and findings are not shown here, by design.",
    );
  });

  it("shows an account name as text, whatever it holds", async () => {
    open({
      overview: {
        ...OVERVIEW,
        installations: [
          {
            ...OVERVIEW.installations[1],
            account: '<img src=x onerror="alert(1)">',
            aiProvider: "<b>x</b>",
          },
        ],
      },
    });

    const table = await screen.findByRole("table", {
      name: "Installations, most recently active first",
    });
    expect(table.textContent).toContain('<img src=x onerror="alert(1)">');
    expect(table.querySelector("img")).toBeNull();
    expect(table.querySelector("b")).toBeNull();
  });

  it("asks again when the operator refreshes", async () => {
    const api = open();
    await screen.findByRole("region", { name: "Totals" });
    api.set("/api/operator/overview", {
      ...OVERVIEW,
      totals: { ...OVERVIEW.totals, installations: 7 },
    });

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    await waitFor(() => {
      expect(
        figures(screen.getByRole("region", { name: "Totals" }))["Installations reviewed"],
      ).toBe("7");
    });
    expect(api.requests.filter((request) => request === "GET /api/operator/overview")).toHaveLength(
      2,
    );
  });

  it.each<[string, Answer, string]>([
    [
      "the service says there is nothing there",
      404,
      "This page does not exist, or you do not have access to it.",
    ],
    ["the service fails", 500, "The data could not be loaded."],
    ["the answer has another shape", { totals: "many" }, "The data could not be loaded."],
    [
      "the answer holds a negative count",
      { ...OVERVIEW, queue: { running: -1, waiting: 0 } },
      "The data could not be loaded.",
    ],
  ])("shows no figures when %s", async (_name, answer, message) => {
    open({ overview: answer });

    expect((await screen.findByRole("alert")).textContent).toContain(message);
    expect(screen.queryByRole("region", { name: "Totals" })).toBeNull();
  });

  it("drops anything the service sends beyond what the page is meant to show", async () => {
    open({
      overview: {
        ...OVERVIEW,
        installations: [
          { ...OVERVIEW.installations[0], repositories: ["REPO-CANARY"], login: "LOGIN-CANARY" },
        ],
        secrets: "KEY-CANARY",
      },
    });

    await screen.findByRole("table", { name: "Installations, most recently active first" });
    expect(document.body.textContent).not.toContain("CANARY");
  });
});
