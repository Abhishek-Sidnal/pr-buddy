import { cleanup, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api/client.js";
import type { InstallationList, Overview } from "../src/api/schemas.js";
import { appInstallUrl } from "../src/github-links.js";
import { buildSummary, fakeApi, ME, renderApp, type Answer } from "./helpers.js";

const INSTALL_URL = "https://github.com/apps/pr-buddy-acme/installations/new";
const SERVICE = { appSlug: "pr-buddy-acme" };

const EMPTY_OVERVIEW: Overview = {
  since: "2026-09-10T00:00:00.000Z",
  repositoryCount: 0,
  reviewCount: 0,
  completedCount: 0,
  findingCount: 0,
  skippedCount: 0,
  failedCount: 0,
  recentReviews: [],
};

function installations(
  overrides: Partial<InstallationList["installations"][number]> = {},
): InstallationList {
  return {
    installations: [{ id: 1001, account: "acme", canManage: true, aiKey: null, ...overrides }],
  };
}

const KEY = {
  provider: "anthropic",
  model: "claude-test-1",
  region: null,
  resource: null,
  keyHint: "abcd",
  updatedAt: "2026-10-10T10:00:00.000Z",
};

function signedOut(service: Answer = SERVICE): ReturnType<typeof fakeApi> {
  return fakeApi({ "/api/me": 401, "/auth/service": service });
}

function signedIn(extra: Record<string, Answer> = {}): ReturnType<typeof fakeApi> {
  return fakeApi({
    "/api/me": ME,
    "/auth/service": SERVICE,
    "/api/overview": EMPTY_OVERVIEW,
    "/api/installations": installations(),
    ...extra,
  });
}

const link = (name: string): HTMLAnchorElement => screen.getByRole("link", { name });
const steps = async (): Promise<string[]> => {
  const list = within(await screen.findByRole("region", { name: "Getting started" })).getAllByRole(
    "listitem",
  );
  return list.map((item) => item.textContent);
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the install link", () => {
  it.each(["pr-buddy", "a", "pr-buddy-2", "a".repeat(100)])("is built for the name %s", (slug) => {
    expect(appInstallUrl(slug)).toBe(`https://github.com/apps/${slug}/installations/new`);
  });

  it.each([
    null,
    undefined,
    "",
    "PR-Buddy",
    "-pr-buddy",
    "pr-buddy-",
    "pr buddy",
    "pr_buddy",
    "pr.buddy",
    "pr-buddy/installations",
    "../../settings",
    "pr-buddy?next=x",
    "pr-buddy#x",
    "evil.example/x",
    "javascript:alert(1)",
    "https://evil.example",
    "pr-buddy\n",
    "a".repeat(101),
  ])("is not built for %j", (slug) => {
    expect(appInstallUrl(slug)).toBeUndefined();
  });
});

describe("a visitor who is not signed in", () => {
  it("is told what PR Buddy does and never does", async () => {
    signedOut();

    renderApp("/reviews/anything");

    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Pull request review that shows its evidence",
      }),
    ).toBeDefined();
    expect(screen.getByText(/It never merges, approves or changes code\./)).toBeDefined();
    expect(screen.queryByRole("navigation")).toBeNull();
  });

  it("is offered the install button first and sign-in second, when the app is named", async () => {
    signedOut();

    renderApp();

    const install = await screen.findByRole("link", { name: "Install on GitHub" });
    expect(install.getAttribute("href")).toBe(INSTALL_URL);
    expect(install.className).toContain("button-primary");
    expect(link("Sign in with GitHub").getAttribute("href")).toBe("/auth/login");
    expect(link("Sign in with GitHub").className).toContain("button-secondary");
    expect(screen.getByText(/New here\? Install the app first\./)).toBeDefined();
  });

  it.each<[string, Answer]>([
    ["the operator has not named the app", { appSlug: null }],
    ["the name is not one GitHub allows", { appSlug: "evil.example/x" }],
    ["the name tries to choose the address", { appSlug: "https://evil.example" }],
    ["the service does not answer", 500],
    ["the answer has another shape", { slug: "pr-buddy-acme" }],
    ["the route does not exist", 404],
  ])("gets sign-in alone and no dead button when %s", async (_name, service) => {
    const { requests } = signedOut(service);

    renderApp();

    const signIn = await screen.findByRole("link", { name: "Sign in with GitHub" });
    await waitFor(() => {
      expect(requests).toContain("GET /auth/service");
    });
    expect(signIn.className).toContain("button-primary");
    expect(screen.queryByRole("link", { name: "Install on GitHub" })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(document.querySelector('a[href*="evil"]')).toBeNull();
  });

  it("is shown the steps in order", async () => {
    signedOut();

    renderApp();

    const list = within(await screen.findByRole("region", { name: "How to start" }));
    expect(list.getAllByRole("listitem").map((item) => item.textContent.slice(0, 29))).toEqual([
      "Install the app on your accou",
      "Open or update a pull request",
      "Sign in here to see the histo",
      "Optional: AI suggestions. The",
    ]);
  });

  it("is told what is stored, what never is, and where code may be sent", async () => {
    signedOut();

    renderApp();

    const section = within(await screen.findByRole("region", { name: "What it stores" }));
    expect(section.getByText(/^Stored: repository names/)).toBeDefined();
    expect(section.getByText(/^Never stored: pull request titles/)).toBeDefined();
    expect(
      section.getByText(/Code is sent to an AI provider only for a repository that opted in/),
    ).toBeDefined();
  });

  it("is told what GitHub shares at sign-in", async () => {
    signedOut();

    renderApp();

    const section = within(
      await screen.findByRole("region", { name: "What GitHub shares when you sign in" }),
    );
    expect(section.getByText(/Your GitHub login and ID/)).toBeDefined();
    expect(section.getByText(/PR Buddy keeps no GitHub token/)).toBeDefined();
  });

  it("asks only for what a visitor may know", async () => {
    const { requests } = signedOut();

    renderApp();

    await screen.findByRole("link", { name: "Install on GitHub" });
    expect(requests).toEqual(["GET /api/me", "GET /auth/service"]);
  });

  it("still sees the page when sign-in did not complete, with the reason", async () => {
    signedOut();

    renderApp("/?sign-in=failed");

    expect((await screen.findByRole("alert")).textContent).toContain("Sign-in did not complete");
    expect(await screen.findByRole("link", { name: "Install on GitHub" })).toBeDefined();
  });
});

describe("the settings page", () => {
  it("shows the same data-handling list as the page for visitors", async () => {
    signedIn();

    renderApp("/settings");

    const section = within(await screen.findByRole("region", { name: "Data handling" }));
    expect(section.getByText(/^Stored: repository names/)).toBeDefined();
    expect(section.getByText(/^Never stored: pull request titles/)).toBeDefined();
    expect(
      section.getByText(/is stored encrypted and is never sent back to a browser/),
    ).toBeDefined();
  });
});

describe("getting started", () => {
  it("puts installing first for someone with no installation, with the button", async () => {
    signedIn({
      "/api/me": { ...ME, installationCount: 0 },
      "/api/installations": { installations: [] },
    });

    renderApp();

    const list = await steps();
    expect(list).toHaveLength(2);
    expect(list[0]).toMatch(/^NextInstall the app/);
    expect(list[1]).toMatch(/^LaterGet a first review/);
    const region = within(screen.getByRole("region", { name: "Getting started" }));
    expect(region.getByRole("link", { name: "Install on GitHub" }).getAttribute("href")).toBe(
      INSTALL_URL,
    );
  });

  it("has no install button when the service does not know its app", async () => {
    signedIn({ "/api/me": { ...ME, installationCount: 0 }, "/auth/service": { appSlug: null } });

    renderApp();

    expect((await steps())[0]).toMatch(/^NextInstall the app/);
    expect(screen.queryByRole("link", { name: "Install on GitHub" })).toBeNull();
  });

  it("offers the install button in the notice for someone with no installation, on any page", async () => {
    signedIn({ "/api/me": { ...ME, installationCount: 0 } });

    renderApp("/settings");

    const notice = within(await screen.findByRole("note"));
    expect(notice.getByText("GitHub lists no installation of PR Buddy for you")).toBeDefined();
    expect(
      (await notice.findByRole("link", { name: "Install on GitHub" })).getAttribute("href"),
    ).toBe(INSTALL_URL);
  });

  it("marks installing done and the first review next, once the app is installed", async () => {
    signedIn();

    renderApp();

    await screen.findByText("Turn on AI suggestions");
    const list = await steps();
    expect(list[0]).toMatch(/^DoneInstall the app/);
    expect(list[1]).toMatch(/^NextGet a first review/);
    expect(list[2]).toMatch(/^OptionalTurn on AI suggestions/);
    expect(screen.queryByRole("link", { name: "Install on GitHub" })).toBeNull();
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("sends an owner to the settings for the AI key", async () => {
    signedIn();

    renderApp();

    const step = (await screen.findByText("Turn on AI suggestions")).closest("li");
    expect(step?.textContent).toContain("Store an AI key for your installation");
    expect(
      within(step as HTMLElement)
        .getByRole("link")
        .getAttribute("href"),
    ).toBe("/settings");
  });

  it("tells someone who is not an owner who can set the AI key", async () => {
    signedIn({ "/api/installations": installations({ canManage: false }) });

    renderApp();

    const step = (await screen.findByText("Turn on AI suggestions")).closest("li");
    expect(step?.textContent).toContain("An owner of the account can store an AI key");
  });

  it("marks the AI step done when a key is stored, and says a repository must still opt in", async () => {
    signedIn({ "/api/installations": installations({ aiKey: KEY }) });

    renderApp();

    const step = (await screen.findByText("Turn on AI suggestions")).closest("li");
    expect(step?.textContent).toMatch(/^DoneTurn on AI suggestions/);
    expect(step?.textContent).toContain('"ai": { "enabled": true }');
    expect(step?.textContent).not.toContain("abcd");
  });

  it.each<[string, Answer]>([
    ["the service does not offer installation keys", 404],
    ["the keys cannot be loaded", 500],
  ])("leaves the AI step out when %s", async (_name, answer) => {
    const { requests } = signedIn({ "/api/installations": answer });

    renderApp();

    const list = await steps();
    await waitFor(() => {
      expect(requests).toContain("GET /api/installations");
    });
    expect(list).toHaveLength(2);
    expect(screen.queryByText("Turn on AI suggestions")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("does not ask about AI keys before the app is installed", async () => {
    const { requests } = signedIn({ "/api/me": { ...ME, installationCount: 0 } });

    renderApp();

    await steps();
    expect(requests).not.toContain("GET /api/installations");
  });

  it("is gone once a review exists, whatever else is true", async () => {
    signedIn({
      "/api/overview": { ...EMPTY_OVERVIEW, reviewCount: 1, recentReviews: [buildSummary()] },
    });

    renderApp();

    expect(await screen.findByRole("heading", { name: "Recent reviews" })).toBeDefined();
    expect(screen.queryByRole("heading", { name: "Getting started" })).toBeNull();
    expect(screen.queryByText("Install the app")).toBeNull();
  });

  it("is on the overview only", async () => {
    signedIn({ "/api/reviews": { reviews: [], nextCursor: null } });

    renderApp("/history");

    expect(await screen.findByText("No reviews yet")).toBeDefined();
    expect(screen.queryByRole("heading", { name: "Getting started" })).toBeNull();
  });
});

describe("the service client", () => {
  it("reads the app's name from the route that needs no session", async () => {
    const { requests } = fakeApi({ "/auth/service": SERVICE });

    expect(await api.service()).toEqual({
      ...SERVICE,
      operator: { name: null, contact: null, privacyUrl: null, termsUrl: null },
      retentionDays: null,
    });
    expect(requests).toEqual(["GET /auth/service"]);
  });
});
