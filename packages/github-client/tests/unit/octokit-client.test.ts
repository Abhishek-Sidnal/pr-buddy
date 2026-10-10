import { generateKeyPairSync } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { createRepositoryClientFactory } from "../../src/api/octokit-client.js";
import type { RepositoryClient } from "../../src/api/repository-client.js";

const APP_ID = 4242;
const OTHER_APP_ID = 9999;
const MARKER = "<!-- marker -->";

/** A throwaway key in the PKCS#1 format GitHub issues. It signs nothing outside these tests. */
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
});

interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly query: URLSearchParams;
  readonly authorization: string | null;
  readonly body: unknown;
}

type Reply =
  | { status?: number; body: unknown }
  | ((request: RecordedRequest) => { status?: number; body: unknown });

/** Stands in for the GitHub REST API: replies from a table of routes and records every request. */
class FakeGitHubApi {
  readonly requests: RecordedRequest[] = [];
  readonly #routes = new Map<string, Reply[]>();

  /** Queues a reply for `METHOD /path`. The last queued reply repeats once the queue runs out. */
  on(route: string, ...replies: Reply[]): this {
    this.#routes.set(route, replies);
    return this;
  }

  requestsTo(route: string): RecordedRequest[] {
    return this.requests.filter((request) => `${request.method} ${request.path}` === route);
  }

  readonly fetch: typeof fetch = (input, init) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    const headers = new Headers(init?.headers);
    const rawBody = init?.body;
    const request: RecordedRequest = {
      method: init?.method ?? "GET",
      path: url.pathname,
      query: url.searchParams,
      authorization: headers.get("authorization"),
      body: typeof rawBody === "string" ? (JSON.parse(rawBody) as unknown) : undefined,
    };
    this.requests.push(request);

    if (
      request.method === "POST" &&
      /^\/app\/installations\/\d+\/access_tokens$/.test(request.path)
    ) {
      const installationId = request.path.split("/")[3] ?? "";
      return Promise.resolve(
        Response.json(
          {
            token: `installation-token-${installationId}`,
            expires_at: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
            permissions: { pull_requests: "write" },
            repository_selection: "selected",
          },
          { status: 201 },
        ),
      );
    }

    const replies = this.#routes.get(`${request.method} ${request.path}`);
    const reply =
      replies === undefined ? undefined : replies.length > 1 ? replies.shift() : replies[0];
    if (reply === undefined) {
      return Promise.resolve(Response.json({ message: "Not Found" }, { status: 404 }));
    }
    const { status = 200, body } = typeof reply === "function" ? reply(request) : reply;
    return Promise.resolve(Response.json(body, { status }));
  };
}

const PULL_PATH = "/repos/acme/widgets/pulls/7";
const FILES_PATH = "/repos/acme/widgets/pulls/7/files";
const COMMENTS_PATH = "/repos/acme/widgets/issues/7/comments";
const CONTENT_PATH = "/repos/acme/widgets/contents/.github%2Fpr-buddy.json";

let api: FakeGitHubApi;
let sleeps: number[];

function clientFor(installationId = 1001): RepositoryClient {
  return factory({ installationId, owner: "acme", repo: "widgets" });
}

let factory: ReturnType<typeof createRepositoryClientFactory>;

beforeEach(() => {
  api = new FakeGitHubApi();
  sleeps = [];
  factory = createRepositoryClientFactory({
    credentials: { appId: APP_ID, privateKey },
    fetch: api.fetch,
    retry: {
      attempts: 3,
      baseDelayMs: 10,
      sleep: (delayMs) => {
        sleeps.push(delayMs);
        return Promise.resolve();
      },
    },
  });
});

function pullRequestBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 7,
    title: "Add a feature",
    body: "A description.",
    state: "open",
    draft: false,
    changed_files: 3,
    base: { sha: "a".repeat(40) },
    head: { sha: "b".repeat(40) },
    ...overrides,
  };
}

function fileBody(index: number): Record<string, unknown> {
  return {
    filename: `src/file-${index}.ts`,
    status: "modified",
    additions: 1,
    deletions: 0,
    changes: 1,
  };
}

function commentBody(id: number, body: string, appId: number | null): Record<string, unknown> {
  return { id, body, performed_via_github_app: appId === null ? null : { id: appId } };
}

describe("authentication", () => {
  it("uses a token issued for the installation and reuses it", async () => {
    api.on(`GET ${PULL_PATH}`, { body: pullRequestBody() });
    const client = clientFor(1001);

    await client.getPullRequest(7);
    await client.getPullRequest(7);

    expect(api.requestsTo("POST /app/installations/1001/access_tokens")).toHaveLength(1);
    expect(api.requestsTo(`GET ${PULL_PATH}`).map((request) => request.authorization)).toEqual([
      "token installation-token-1001",
      "token installation-token-1001",
    ]);
  });

  it("authenticates the token request as the app, with a signed JWT", async () => {
    api.on(`GET ${PULL_PATH}`, { body: pullRequestBody() });

    await clientFor().getPullRequest(7);

    const [tokenRequest] = api.requestsTo("POST /app/installations/1001/access_tokens");
    expect(tokenRequest?.authorization).toMatch(/^bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  });

  it("uses a separate token for each installation", async () => {
    api.on(`GET ${PULL_PATH}`, { body: pullRequestBody() });

    await clientFor(1001).getPullRequest(7);
    await clientFor(2002).getPullRequest(7);

    expect(api.requestsTo(`GET ${PULL_PATH}`).map((request) => request.authorization)).toEqual([
      "token installation-token-1001",
      "token installation-token-2002",
    ]);
  });
});

describe("getPullRequest", () => {
  it("maps GitHub's pull request to a snapshot", async () => {
    api.on(`GET ${PULL_PATH}`, { body: pullRequestBody({ draft: true, body: null }) });

    await expect(clientFor().getPullRequest(7)).resolves.toEqual({
      number: 7,
      title: "Add a feature",
      body: null,
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      state: "open",
      isDraft: true,
      changedFileCount: 3,
    });
  });

  it("treats a missing draft flag as not a draft", async () => {
    api.on(`GET ${PULL_PATH}`, { body: pullRequestBody({ draft: undefined }) });

    await expect(clientFor().getPullRequest(7)).resolves.toMatchObject({ isDraft: false });
  });

  it("retries a server error and then succeeds", async () => {
    api.on(
      `GET ${PULL_PATH}`,
      { status: 502, body: { message: "Bad Gateway" } },
      { body: pullRequestBody() },
    );

    await expect(clientFor().getPullRequest(7)).resolves.toMatchObject({ number: 7 });
    expect(sleeps).toEqual([10]);
  });

  it("gives up on a persistent server error after three attempts", async () => {
    api.on(`GET ${PULL_PATH}`, { status: 503, body: { message: "Unavailable" } });

    await expect(clientFor().getPullRequest(7)).rejects.toMatchObject({ status: 503 });
    expect(api.requestsTo(`GET ${PULL_PATH}`)).toHaveLength(3);
    expect(sleeps).toEqual([10, 20]);
  });

  it.each([403, 404, 422])("does not retry HTTP %i", async (status) => {
    api.on(`GET ${PULL_PATH}`, { status, body: { message: "No" } });

    await expect(clientFor().getPullRequest(7)).rejects.toMatchObject({ status });
    expect(api.requestsTo(`GET ${PULL_PATH}`)).toHaveLength(1);
  });
});

describe("listPullRequestFiles", () => {
  it("maps file fields, keeping optional ones only when present", async () => {
    api.on(`GET ${FILES_PATH}`, {
      body: [
        {
          filename: "src/new.ts",
          previous_filename: "src/old.ts",
          status: "renamed",
          additions: 1,
          deletions: 2,
          changes: 3,
          patch: "@@ -1 +1 @@\n-a\n+b",
        },
        { filename: "logo.png", status: "added", additions: 0, deletions: 0, changes: 0 },
      ],
    });

    await expect(clientFor().listPullRequestFiles(7, 100)).resolves.toEqual([
      {
        path: "src/new.ts",
        previousPath: "src/old.ts",
        status: "renamed",
        additions: 1,
        deletions: 2,
        patch: "@@ -1 +1 @@\n-a\n+b",
      },
      { path: "logo.png", status: "added", additions: 0, deletions: 0 },
    ]);
  });

  it("follows pages until a short page", async () => {
    api.on(`GET ${FILES_PATH}`, (request) => ({
      body:
        request.query.get("page") === "1"
          ? Array.from({ length: 100 }, (_unused, index) => fileBody(index))
          : [fileBody(100), fileBody(101)],
    }));

    const files = await clientFor().listPullRequestFiles(7, 3_000);

    expect(files).toHaveLength(102);
    expect(api.requestsTo(`GET ${FILES_PATH}`).map((request) => request.query.get("page"))).toEqual(
      ["1", "2"],
    );
  });

  it("stops at the limit without fetching further pages", async () => {
    api.on(`GET ${FILES_PATH}`, {
      body: Array.from({ length: 100 }, (_unused, index) => fileBody(index)),
    });

    const files = await clientFor().listPullRequestFiles(7, 150);

    expect(files).toHaveLength(150);
    expect(api.requestsTo(`GET ${FILES_PATH}`)).toHaveLength(2);
  });

  it("returns an empty list for an empty diff", async () => {
    api.on(`GET ${FILES_PATH}`, { body: [] });

    await expect(clientFor().listPullRequestFiles(7, 100)).resolves.toEqual([]);
  });
});

describe("getFileText", () => {
  const read = (): Promise<unknown> =>
    clientFor().getFileText(".github/pr-buddy.json", "a".repeat(40), 1_000);
  const fileContent = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    type: "file",
    size: 12,
    encoding: "base64",
    content: Buffer.from('{"rules":{}}', "utf8").toString("base64"),
    ...overrides,
  });

  it("decodes a file and asks for it at the given commit", async () => {
    api.on(`GET ${CONTENT_PATH}`, { body: fileContent() });

    await expect(read()).resolves.toEqual({ status: "found", text: '{"rules":{}}' });
    expect(api.requestsTo(`GET ${CONTENT_PATH}`)[0]?.query.get("ref")).toBe("a".repeat(40));
  });

  it("reports a file that does not exist", async () => {
    await expect(read()).resolves.toEqual({ status: "missing" });
  });

  it("reports a directory or a symlink as missing", async () => {
    api.on(
      `GET ${CONTENT_PATH}`,
      { body: [fileContent()] },
      { body: fileContent({ type: "symlink" }) },
    );

    await expect(read()).resolves.toEqual({ status: "missing" });
    await expect(read()).resolves.toEqual({ status: "missing" });
  });

  it("does not decode a file above the size limit", async () => {
    api.on(`GET ${CONTENT_PATH}`, { body: fileContent({ size: 1_001 }) });

    await expect(read()).resolves.toEqual({ status: "too-large" });
  });

  it("rejects when GitHub refuses access", async () => {
    api.on(`GET ${CONTENT_PATH}`, {
      status: 403,
      body: { message: "Resource not accessible by integration" },
    });

    await expect(read()).rejects.toMatchObject({ status: 403 });
  });
});

describe("findOwnComment", () => {
  it("finds the comment written by this app that contains the marker", async () => {
    api.on(`GET ${COMMENTS_PATH}`, {
      body: [
        commentBody(1, "An ordinary comment", null),
        commentBody(2, `${MARKER} from this app`, APP_ID),
      ],
    });

    await expect(clientFor().findOwnComment(7, MARKER)).resolves.toBe(2);
  });

  it("ignores a comment by someone else that copies the marker", async () => {
    api.on(`GET ${COMMENTS_PATH}`, {
      body: [
        commentBody(1, `${MARKER} pasted by a user`, null),
        commentBody(2, `${MARKER} written by another app`, OTHER_APP_ID),
      ],
    });

    await expect(clientFor().findOwnComment(7, MARKER)).resolves.toBeUndefined();
  });

  it("ignores this app's comments that lack the marker", async () => {
    api.on(`GET ${COMMENTS_PATH}`, { body: [commentBody(1, "Something else", APP_ID)] });

    await expect(clientFor().findOwnComment(7, MARKER)).resolves.toBeUndefined();
  });

  it("searches later pages", async () => {
    const filler = Array.from({ length: 100 }, (_unused, index) =>
      commentBody(index + 1, "chatter", null),
    );
    api.on(`GET ${COMMENTS_PATH}`, (request) => ({
      body: request.query.get("page") === "1" ? filler : [commentBody(500, MARKER, APP_ID)],
    }));

    await expect(clientFor().findOwnComment(7, MARKER)).resolves.toBe(500);
  });

  it("stops searching after ten pages", async () => {
    const filler = Array.from({ length: 100 }, (_unused, index) =>
      commentBody(index + 1, "chatter", null),
    );
    api.on(`GET ${COMMENTS_PATH}`, { body: filler });

    await expect(clientFor().findOwnComment(7, MARKER)).resolves.toBeUndefined();
    expect(api.requestsTo(`GET ${COMMENTS_PATH}`)).toHaveLength(10);
  });
});

describe("comments", () => {
  it("creates a comment on the pull request", async () => {
    api.on(`POST ${COMMENTS_PATH}`, { status: 201, body: commentBody(1, "Hello", APP_ID) });

    await clientFor().createComment(7, "Hello");

    expect(api.requestsTo(`POST ${COMMENTS_PATH}`)[0]?.body).toEqual({ body: "Hello" });
  });

  it("updates a comment by ID", async () => {
    api.on("PATCH /repos/acme/widgets/issues/comments/55", {
      body: commentBody(55, "Updated", APP_ID),
    });

    await clientFor().updateComment(55, "Updated");

    expect(api.requestsTo("PATCH /repos/acme/widgets/issues/comments/55")[0]?.body).toEqual({
      body: "Updated",
    });
  });
});
