import { describe, expect, it } from "vitest";
import {
  createUserAuthClient,
  SignInError,
  type SignInFailure,
  type UserAuthClient,
} from "../../src/oauth/user-auth-client.js";

const CLIENT_ID = "Iv1.testclientid";
const CLIENT_SECRET = "CLIENT-SECRET-CANARY";
const TOKEN = "ghu_TOKEN-CANARY";
const REDIRECT_URI = "https://buddy.example/auth/callback";

interface RecordedRequest {
  readonly url: URL;
  readonly method: string;
  readonly headers: Headers;
  readonly body: unknown;
  readonly hasSignal: boolean;
}

type Handler = (request: RecordedRequest) => Response | Promise<Response>;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const installationsPage = (ids: number[]): Response =>
  json({ total_count: ids.length, installations: ids.map((id) => ({ id, account: {} })) });

/** Stands in for GitHub: one handler per path, and a record of what was asked. */
function fakeGitHub(overrides: Record<string, Handler> = {}): {
  client: UserAuthClient;
  requests: RecordedRequest[];
} {
  const handlers: Record<string, Handler> = {
    "/login/oauth/access_token": () => json({ access_token: TOKEN, token_type: "bearer" }),
    "/user": () => json({ id: 583231, login: "octocat", email: "private@example.com" }),
    "/user/installations": () => installationsPage([1001, 1002]),
    ...overrides,
  };
  const requests: RecordedRequest[] = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const recorded: RecordedRequest = {
      url: new URL(input instanceof Request ? input.url : input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined,
      hasSignal: init?.signal instanceof AbortSignal,
    };
    requests.push(recorded);
    const handler = handlers[recorded.url.pathname];
    return handler === undefined ? json({ message: "Not Found" }, 404) : handler(recorded);
  };
  return {
    client: createUserAuthClient({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      fetch: fakeFetch,
    }),
    requests,
  };
}

async function failureOf(promise: Promise<unknown>): Promise<SignInError> {
  const error: unknown = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  if (!(error instanceof SignInError)) {
    throw new Error("Expected a SignInError.");
  }
  return error;
}

describe("authorizeUrl", () => {
  it("points at GitHub with the client ID, state and callback", () => {
    const url = new URL(fakeGitHub().client.authorizeUrl("state-123", REDIRECT_URI));

    expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      state: "state-123",
    });
  });

  it("never contains the client secret, and encodes what it is given", () => {
    const url = fakeGitHub().client.authorizeUrl("a b&client_id=evil", REDIRECT_URI);

    expect(url).not.toContain(CLIENT_SECRET);
    expect(new URL(url).searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(new URL(url).searchParams.get("state")).toBe("a b&client_id=evil");
  });
});

describe("signIn", () => {
  it("returns who signed in and the installations they can access", async () => {
    const { client } = fakeGitHub();

    expect(await client.signIn("the-code", REDIRECT_URI)).toEqual({
      user: { id: 583231, login: "octocat" },
      installationIds: [1001, 1002],
      // The fake describes no accounts, so nobody is taken for an owner.
      installations: [
        { id: 1001, account: "", isOwner: false },
        { id: 1002, account: "", isOwner: false },
      ],
    });
  });

  it("exchanges the code with the client secret, then asks as the user", async () => {
    const { client, requests } = fakeGitHub();

    await client.signIn("the-code", REDIRECT_URI);

    const [exchange, user, installations] = requests;
    expect(requests).toHaveLength(3);
    expect(exchange).toMatchObject({
      method: "POST",
      body: {
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code: "the-code",
        redirect_uri: REDIRECT_URI,
      },
      hasSignal: true,
    });
    expect(exchange?.url.href).toBe("https://github.com/login/oauth/access_token");
    expect(exchange?.headers.get("accept")).toBe("application/json");
    expect(user?.url.href).toBe("https://api.github.com/user");
    expect(user?.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(installations?.url.href).toBe(
      "https://api.github.com/user/installations?per_page=100&page=1",
    );
    expect(installations?.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    // The secret goes to github.com only, never to the API host.
    expect(JSON.stringify(user?.body ?? null)).not.toContain(CLIENT_SECRET);
    expect(user?.headers.get("authorization")).not.toContain(CLIENT_SECRET);
  });

  it("does not return the token", async () => {
    const access = await fakeGitHub().client.signIn("the-code", REDIRECT_URI);

    expect(JSON.stringify(access)).not.toContain("CANARY");
  });

  it("reads every page of installations and drops repeats", async () => {
    const firstPage = Array.from({ length: 100 }, (_unused, index) => index + 1);
    const { client, requests } = fakeGitHub({
      "/user/installations": ({ url }) =>
        installationsPage(url.searchParams.get("page") === "1" ? firstPage : [100, 101]),
    });

    const { installationIds } = await client.signIn("the-code", REDIRECT_URI);

    expect(installationIds).toHaveLength(101);
    expect(installationIds.at(-1)).toBe(101);
    expect(requests.filter(({ url }) => url.pathname === "/user/installations")).toHaveLength(2);
  });

  it("stops after ten pages", async () => {
    let next = 0;
    const { client, requests } = fakeGitHub({
      "/user/installations": () =>
        installationsPage(Array.from({ length: 100 }, () => (next += 1))),
    });

    const { installationIds } = await client.signIn("the-code", REDIRECT_URI);

    expect(installationIds).toHaveLength(1_000);
    expect(requests.filter(({ url }) => url.pathname === "/user/installations")).toHaveLength(10);
  });

  it("accepts a person with no installations", async () => {
    const { client } = fakeGitHub({ "/user/installations": () => installationsPage([]) });

    expect((await client.signIn("the-code", REDIRECT_URI)).installationIds).toEqual([]);
  });

  it.each<[string, Record<string, Handler>, SignInFailure]>([
    [
      "GitHub rejects the code",
      {
        "/login/oauth/access_token": () =>
          json({ error: "bad_verification_code", error_description: "expired" }),
      },
      "code-rejected",
    ],
    [
      "the exchange answers 400",
      { "/login/oauth/access_token": () => json({ error: "x" }, 400) },
      "code-rejected",
    ],
    [
      "the exchange answers 503",
      { "/login/oauth/access_token": () => json({}, 503) },
      "github-unavailable",
    ],
    [
      "the network fails",
      {
        "/login/oauth/access_token": () => {
          throw new TypeError(`fetch failed for ${CLIENT_SECRET}`);
        },
      },
      "github-unavailable",
    ],
    [
      "the exchange answers with something that is not JSON",
      { "/login/oauth/access_token": () => new Response("<html>", { status: 200 }) },
      "invalid-response",
    ],
    ["the user request answers 401", { "/user": () => json({}, 401) }, "invalid-response"],
    ["the user request answers 500", { "/user": () => json({}, 500) }, "github-unavailable"],
    ["the user has no ID", { "/user": () => json({ login: "octocat" }) }, "invalid-response"],
    [
      "the user ID is not a number",
      { "/user": () => json({ id: "1", login: "octocat" }) },
      "invalid-response",
    ],
    [
      "the installation list is malformed",
      { "/user/installations": () => json({ installations: [{ id: "one" }] }) },
      "invalid-response",
    ],
    [
      "the installation list is missing",
      { "/user/installations": () => json({ total_count: 0 }) },
      "invalid-response",
    ],
  ])("fails with a fixed message when %s", async (_name, overrides, reason) => {
    const { client } = fakeGitHub(overrides);

    const error = await failureOf(client.signIn("CODE-CANARY", REDIRECT_URI));

    expect(error.reason).toBe(reason);
    expect(error.message).toBe(`GitHub sign-in failed: ${reason}.`);
    expect(`${error.message} ${error.stack ?? ""} ${JSON.stringify(error)}`).not.toContain(
      "CANARY",
    );
  });

  it("does not ask the API anything when the code is rejected", async () => {
    const { client, requests } = fakeGitHub({
      "/login/oauth/access_token": () => json({ error: "bad_verification_code" }),
    });

    await failureOf(client.signIn("the-code", REDIRECT_URI));

    expect(requests).toHaveLength(1);
  });

  it("gives up on a request that takes too long", async () => {
    const slowFetch: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("timed out", "TimeoutError"));
        });
      });
    const client = createUserAuthClient({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      fetch: slowFetch,
      timeoutMs: 20,
    });

    expect((await failureOf(client.signIn("the-code", REDIRECT_URI))).reason).toBe(
      "github-unavailable",
    );
  });
});

describe("who owns an installation", () => {
  const USER_ID = 583231;
  const installations =
    (...accounts: unknown[]): Handler =>
    () =>
      json({ installations: accounts.map((account, index) => ({ id: 1001 + index, account })) });
  const membership =
    (role: string, state = "active"): Handler =>
    () =>
      json({ role, state });

  async function ownership(overrides: Record<string, Handler>): Promise<unknown> {
    const { client } = fakeGitHub(overrides);
    return (await client.signIn("the-code", REDIRECT_URI)).installations;
  }

  it("is the person for an installation on their own account", async () => {
    expect(
      await ownership({
        "/user/installations": installations(
          { id: USER_ID, login: "octocat", type: "User" },
          { id: 999, login: "someone-else", type: "User" },
        ),
      }),
    ).toEqual([
      { id: 1001, account: "octocat", isOwner: true },
      { id: 1002, account: "someone-else", isOwner: false },
    ]);
  });

  it("is an organisation's owner, and not its other members", async () => {
    const { client, requests } = fakeGitHub({
      "/user/installations": installations(
        { id: 50, login: "acme", type: "Organization" },
        { id: 51, login: "other-org", type: "Organization" },
      ),
      "/user/memberships/orgs/acme": membership("admin"),
      "/user/memberships/orgs/other-org": membership("member"),
    });

    const access = await client.signIn("the-code", REDIRECT_URI);

    expect(access.installations).toEqual([
      { id: 1001, account: "acme", isOwner: true },
      { id: 1002, account: "other-org", isOwner: false, ownerCheck: "not-an-owner" },
    ]);
    const lookup = requests.find(({ url }) => url.pathname === "/user/memberships/orgs/acme");
    expect(lookup?.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
  });

  it.each<[string, Handler, string]>([
    ["a billing manager", membership("billing_manager"), "not-an-owner"],
    ["an owner whose invitation is pending", membership("admin", "pending"), "not-active"],
    ["a role GitHub may add later", membership("super-admin"), "not-an-owner"],
    [
      "someone GitHub does not list as a member",
      () => json({ message: "Not Found" }, 404),
      "http-404",
    ],
    ["an organisation that blocks the app", () => json({ message: "Forbidden" }, 403), "http-403"],
    ["a failing GitHub", () => json({}, 500), "http-500"],
    ["an answer of another shape", () => json({ role: 1 }), "invalid-response"],
    [
      "a network failure",
      () => {
        throw new TypeError("fetch failed");
      },
      "unreachable",
    ],
  ])("does not make an owner of %s, and says why", async (_name, handler, ownerCheck) => {
    expect(
      await ownership({
        "/user/installations": installations({ id: 50, login: "acme", type: "Organization" }),
        "/user/memberships/orgs/acme": handler,
      }),
    ).toEqual([{ id: 1001, account: "acme", isOwner: false, ownerCheck }]);
  });

  it.each<[string, unknown]>([
    ["no account", undefined],
    ["a null account", null],
    ["an account of an unknown type", { id: USER_ID, login: "octocat", type: "Bot" }],
    ["an account without a type", { id: USER_ID, login: "octocat" }],
    [
      "an account whose login could not be a GitHub name",
      { id: USER_ID, login: "../x", type: "User" },
    ],
  ])("does not make an owner of anyone for %s", async (_name, account) => {
    const result = (await ownership({ "/user/installations": installations(account) })) as {
      isOwner: boolean;
    }[];

    expect(result).toHaveLength(1);
    expect(result[0]?.isOwner).toBe(false);
  });

  it("stops asking about organisations after fifty", async () => {
    const accounts = Array.from({ length: 60 }, (_unused, index) => ({
      id: 100 + index,
      login: `org-${index}`,
      type: "Organization",
    }));
    const handlers: Record<string, Handler> = { "/user/installations": installations(...accounts) };
    for (const { login } of accounts) {
      handlers[`/user/memberships/orgs/${login}`] = membership("admin");
    }
    const { client, requests } = fakeGitHub(handlers);

    const access = await client.signIn("the-code", REDIRECT_URI);

    expect(access.installations.filter(({ isOwner }) => isOwner)).toHaveLength(50);
    expect(
      access.installations.filter(({ ownerCheck }) => ownerCheck === "not-asked"),
    ).toHaveLength(accounts.length - 50);
    expect(
      requests.filter(({ url }) => url.pathname.startsWith("/user/memberships/")),
    ).toHaveLength(50);
  });
});
