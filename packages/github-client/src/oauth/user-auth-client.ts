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
  /** The same installations, with whose they are and whether the person owns them. */
  readonly installations: readonly AccessibleInstallation[];
}

/** An installation of the app that the person can access. */
export interface AccessibleInstallation {
  readonly id: number;
  /** The login of the person or organisation the app is installed on; empty if unknown. */
  readonly account: string;
  /**
   * True when the person owns the account: it is their own, or they are an owner of the
   * organisation. Only a clear yes from GitHub makes it true.
   */
  readonly isOwner: boolean;
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
  installations: z.array(
    z.object({
      id: z.number().int().positive(),
      // Absent or unusual for an account GitHub does not describe; then nobody owns it.
      account: z
        .object({
          id: z.number().int().positive(),
          login: z.string().regex(/^[A-Za-z0-9-]{1,100}$/),
          type: z.string().max(40).optional(),
        })
        .nullish()
        .catch(undefined),
    }),
  ),
});
const membershipSchema = z.object({ role: z.string(), state: z.string() });

/** Organisations whose membership is looked up for one sign-in. Beyond it, nobody is an owner. */
const MAX_MEMBERSHIP_LOOKUPS = 50;

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

  /**
   * Whether the person is an owner of an organisation. GitHub answers with their role; an
   * error, a refusal or any role but "admin" means no. Deciding where an organisation's code is
   * sent is never granted on a guess.
   */
  async function isOrganizationOwner(organization: string, token: string): Promise<boolean> {
    try {
      const membership = parse(
        membershipSchema,
        await apiGet(`/user/memberships/orgs/${encodeURIComponent(organization)}`, token),
      );
      return membership.role === "admin" && membership.state === "active";
    } catch {
      return false;
    }
  }

  async function listInstallations(
    token: string,
    userId: number,
  ): Promise<AccessibleInstallation[]> {
    const found = new Map<number, AccessibleInstallation>();
    let lookups = 0;
    for (let page = 1; page <= MAX_INSTALLATION_PAGES; page += 1) {
      const { installations } = parse(
        installationsSchema,
        await apiGet(`/user/installations?per_page=${PAGE_SIZE}&page=${page}`, token),
      );
      for (const { id, account } of installations) {
        if (found.has(id)) {
          continue;
        }
        let isOwner = false;
        if (account?.type === "User") {
          isOwner = account.id === userId;
        } else if (account?.type === "Organization" && lookups < MAX_MEMBERSHIP_LOOKUPS) {
          lookups += 1;
          isOwner = await isOrganizationOwner(account.login, token);
        }
        found.set(id, { id, account: account?.login ?? "", isOwner });
      }
      if (installations.length < PAGE_SIZE) {
        break;
      }
    }
    return [...found.values()];
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
      const installations = await listInstallations(token, user.id);
      return {
        user: { id: user.id, login: user.login },
        installationIds: installations.map((installation) => installation.id),
        installations,
      };
    },
  };
}
