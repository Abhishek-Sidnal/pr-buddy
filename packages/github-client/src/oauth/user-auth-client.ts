import { z } from "zod";

const AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const API_URL = "https://api.github.com";
const API_VERSION = "2022-11-28";
const USER_AGENT = "pr-buddy";

const PAGE_SIZE = 100;
/** Installations read for one person; someone with more sees only the first thousand. */
const MAX_INSTALLATION_PAGES = 10;
const DEFAULT_TIMEOUT_MS = 10_000;

/** A person as GitHub identifies them. */
export interface GitHubUser {
  /** GitHub's numeric ID, which survives a change of login. */
  readonly id: number;
  readonly login: string;
}

/** Who signed in and which installations of this app they can access. */
export interface UserAccess {
  readonly user: GitHubUser;
  readonly installationIds: readonly number[];
}

export type SignInFailure = "code-rejected" | "github-unavailable" | "invalid-response";

/**
 * Thrown when a sign-in cannot be completed. Its message is fixed text: it never contains the
 * code, the token or anything GitHub returned.
 */
export class SignInError extends Error {
  readonly reason: SignInFailure;

  constructor(reason: SignInFailure) {
    super(`GitHub sign-in failed: ${reason}.`);
    this.name = "SignInError";
    this.reason = reason;
  }
}

/** Lets a person identify themselves through the GitHub App. */
export interface UserAuthClient {
  /** The GitHub page that asks the person to authorise the app. */
  authorizeUrl(state: string, redirectUri: string): string;
  /**
   * Exchanges the code GitHub sent back for a user token, reads who the person is and what they
   * can access, and forgets the token. The token never leaves this call.
   * @throws {SignInError}
   */
  signIn(code: string, redirectUri: string): Promise<UserAccess>;
}

export interface UserAuthClientOptions {
  /** The GitHub App's client ID. */
  readonly clientId: string;
  /** A client secret of the GitHub App. Never logged and never part of an error. */
  readonly clientSecret: string;
  /** Replaces the global `fetch`; used by tests. */
  readonly fetch?: typeof fetch;
  /** Time limit for each request to GitHub, in milliseconds. */
  readonly timeoutMs?: number;
}

const tokenResponseSchema = z.object({ access_token: z.string().min(1) });
const userSchema = z.object({
  id: z.number().int().positive(),
  login: z.string().min(1).max(100),
});
const installationsSchema = z.object({
  installations: z.array(z.object({ id: z.number().int().positive() })),
});

export function createUserAuthClient(options: UserAuthClientOptions): UserAuthClient {
  const { clientId, clientSecret } = options;
  const send = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  /** Sends a request and returns its JSON body. Network failures and bad statuses are mapped. */
  async function requestJson(
    url: string,
    init: RequestInit,
    onClientError: SignInFailure,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await send(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch {
      throw new SignInError("github-unavailable");
    }
    if (!response.ok) {
      throw new SignInError(response.status >= 500 ? "github-unavailable" : onClientError);
    }
    try {
      return await response.json();
    } catch {
      throw new SignInError("invalid-response");
    }
  }

  function parse<Schema extends z.ZodType>(schema: Schema, value: unknown): z.infer<Schema> {
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      throw new SignInError("invalid-response");
    }
    return parsed.data;
  }

  async function exchangeCode(code: string, redirectUri: string): Promise<string> {
    const body = await requestJson(
      TOKEN_URL,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "User-Agent": USER_AGENT,
        },
        body: JSON.stringify({
          client_id: clientId,
          client_secret: clientSecret,
          code,
          redirect_uri: redirectUri,
        }),
      },
      "code-rejected",
    );
    // GitHub answers 200 with an `error` field when a code is wrong, expired or already used.
    const token = tokenResponseSchema.safeParse(body);
    if (!token.success) {
      throw new SignInError("code-rejected");
    }
    return token.data.access_token;
  }

  function apiGet(path: string, token: string): Promise<unknown> {
    return requestJson(
      `${API_URL}${path}`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "User-Agent": USER_AGENT,
          "X-GitHub-Api-Version": API_VERSION,
        },
      },
      "invalid-response",
    );
  }

  async function listInstallationIds(token: string): Promise<number[]> {
    const ids: number[] = [];
    for (let page = 1; page <= MAX_INSTALLATION_PAGES; page += 1) {
      const { installations } = parse(
        installationsSchema,
        await apiGet(`/user/installations?per_page=${PAGE_SIZE}&page=${page}`, token),
      );
      ids.push(...installations.map((installation) => installation.id));
      if (installations.length < PAGE_SIZE) {
        break;
      }
    }
    return [...new Set(ids)];
  }

  return {
    authorizeUrl(state, redirectUri) {
      const url = new URL(AUTHORIZE_URL);
      url.searchParams.set("client_id", clientId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("state", state);
      return url.toString();
    },

    async signIn(code, redirectUri) {
      const token = await exchangeCode(code, redirectUri);
      const user = parse(userSchema, await apiGet("/user", token));
      const installationIds = await listInstallationIds(token);
      return { user: { id: user.id, login: user.login }, installationIds };
    },
  };
}
