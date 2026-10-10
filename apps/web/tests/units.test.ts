import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "../src/api/client.js";
import {
  formatDateTime,
  formatDuration,
  formatPercent,
  plural,
  shortCommit,
} from "../src/format.js";
import { commitUrl, pullRequestUrl, repositoryUrl } from "../src/github-links.js";
import { fakeApi, HEAD_SHA, ME, OVERVIEW } from "./helpers.js";

const REPOSITORY = { id: 1, owner: "acme", name: "widgets" };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("links to GitHub", () => {
  it("are built from the owner, name, number and commit", () => {
    expect(repositoryUrl(REPOSITORY)).toBe("https://github.com/acme/widgets");
    expect(pullRequestUrl(REPOSITORY, 7)).toBe("https://github.com/acme/widgets/pull/7");
    expect(commitUrl(REPOSITORY, HEAD_SHA)).toBe(
      `https://github.com/acme/widgets/commit/${HEAD_SHA}`,
    );
  });

  it("accept the names GitHub allows", () => {
    expect(repositoryUrl({ id: 1, owner: "a-b-1", name: "my.repo_name-2" })).toBe(
      "https://github.com/a-b-1/my.repo_name-2",
    );
  });

  it.each([
    ["an owner that is a URL", { owner: "javascript:alert(1)//", name: "x" }],
    ["an owner with a slash", { owner: "evil.example/acme", name: "x" }],
    ["an owner with a dot", { owner: "evil.example", name: "x" }],
    ["an owner that starts with a hyphen", { owner: "-acme", name: "x" }],
    ["an empty owner", { owner: "", name: "x" }],
    ["a name with a slash", { owner: "acme", name: "x/../../settings" }],
    ["a name that is two dots", { owner: "acme", name: ".." }],
    ["a name that is one dot", { owner: "acme", name: "." }],
    ["a name with a query", { owner: "acme", name: "x?tab=security" }],
    ["a name with a fragment", { owner: "acme", name: "x#y" }],
    ["a name with a space", { owner: "acme", name: "x y" }],
    ["a name with a line break", { owner: "acme", name: "x\nname" }],
    ["an empty name", { owner: "acme", name: "" }],
  ])("are not built for %s", (_name, parts) => {
    const repository = { id: 1, ...parts };

    expect(repositoryUrl(repository)).toBeUndefined();
    expect(pullRequestUrl(repository, 7)).toBeUndefined();
    expect(commitUrl(repository, HEAD_SHA)).toBeUndefined();
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "are not built for pull request number %s",
    (number) => {
      expect(pullRequestUrl(REPOSITORY, number)).toBeUndefined();
    },
  );

  it.each([null, "", "abc", `${HEAD_SHA}/../..`, HEAD_SHA.toUpperCase(), `${HEAD_SHA}0`])(
    "are not built for commit %s",
    (commitId) => {
      expect(commitUrl(REPOSITORY, commitId)).toBeUndefined();
    },
  );
});

describe("formatting", () => {
  it("shows short durations in milliseconds and long ones in seconds", () => {
    expect(formatDuration(3.4)).toBe("3 ms");
    expect(formatDuration(999)).toBe("999 ms");
    expect(formatDuration(1_500)).toBe("1.5 s");
  });

  it("shortens a commit ID, rounds a percentage and counts", () => {
    expect(shortCommit(HEAD_SHA)).toBe("9b8c7d6");
    expect(formatPercent(0.6)).toBe("60%");
    expect(plural(1, "finding")).toBe("1 finding");
    expect(plural(0, "finding")).toBe("0 findings");
    expect(plural(2, "entry", "entries")).toBe("2 entries");
  });

  it("formats a time, and returns text that is not a time unchanged", () => {
    expect(formatDateTime("2026-10-10T10:00:00.000Z")).toContain("2026");
    expect(formatDateTime("not a time")).toBe("not a time");
  });
});

describe("the API client", () => {
  async function kindOf(promise: Promise<unknown>): Promise<string> {
    const error: unknown = await promise.then(
      () => undefined,
      (reason: unknown) => reason,
    );
    return error instanceof ApiError ? error.kind : "no ApiError";
  }

  it("returns a checked answer", async () => {
    fakeApi({ "/api/me": ME });

    expect(await api.me()).toEqual(ME);
  });

  it("asks its own origin, with the cookie and for JSON", async () => {
    const seen: RequestInit[] = [];
    fakeApi({
      "/api/overview": (_url, init) => {
        seen.push(init ?? {});
        return Response.json(OVERVIEW);
      },
    });

    await api.overview();

    expect(seen[0]).toMatchObject({
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
  });

  it("encodes IDs and cursors into the path", async () => {
    const { requests } = fakeApi();

    await kindOf(api.reviews("2002/../../x", "2026-10-10T10:00:00.000Z~a&b"));
    await kindOf(api.review("../me"));

    expect(requests).toEqual([
      "GET /api/repositories/2002%2F..%2F..%2Fx/reviews?cursor=2026-10-10T10%3A00%3A00.000Z~a%26b",
      "GET /api/reviews/..%2Fme",
    ]);
  });

  it.each([
    [401, "unauthenticated"],
    [404, "not-found"],
    [500, "failed"],
    [429, "failed"],
  ])("maps status %s to %s", async (status, kind) => {
    fakeApi({ "/api/me": status });

    expect(await kindOf(api.me())).toBe(kind);
  });

  it("fails on an answer of the wrong shape", async () => {
    fakeApi({ "/api/me": { login: 42 } });

    expect(await kindOf(api.me())).toBe("failed");
  });

  it("fails on an answer that is not JSON", async () => {
    fakeApi({ "/api/me": () => new Response("<html>") });

    expect(await kindOf(api.me())).toBe("failed");
  });

  it("fails when the network does", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("offline")));

    expect(await kindOf(api.me())).toBe("failed");
  });

  it("passes a cancellation on instead of reporting a failure", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new DOMException("stop", "AbortError")));

    expect(await kindOf(api.me(new AbortController().signal))).toBe("no ApiError");
  });

  it("signs out with a POST", async () => {
    const { requests } = fakeApi({ "/auth/logout": () => new Response(null, { status: 204 }) });

    await api.signOut();

    expect(requests).toEqual(["POST /auth/logout"]);
  });
});
