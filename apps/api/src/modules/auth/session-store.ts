import { z } from "zod";

/** An installation as a session knows it: what it is called and whether the person owns it. */
export const sessionInstallationsSchema = z.array(
  z.object({
    id: z.number().int().positive(),
    /** The login of the account the app is installed on; empty if GitHub did not say. */
    account: z.string().max(100),
    /** True when the person may change the installation's settings, such as its AI key. */
    isOwner: z.boolean(),
  }),
);

export type SessionInstallation = z.infer<typeof sessionInstallationsSchema>[number];

/** Who a browser is, and what they may see, for as long as the session lasts. */
export interface Session {
  /** GitHub's numeric ID of the person. */
  readonly userId: number;
  readonly login: string;
  /** Installations the person could access when they signed in. Every read is limited to them. */
  readonly installationIds: readonly number[];
  /** The same installations with their accounts and the person's role, as of sign-in. */
  readonly installations: readonly SessionInstallation[];
  readonly expiresAt: Date;
}

export interface NewSession {
  readonly userId: number;
  readonly login: string;
  readonly installationIds: readonly number[];
  /** Defaults to none: then the person can read but owns nothing. */
  readonly installations?: readonly SessionInstallation[];
}

/** Keeps dashboard sessions. The token is the only way to reach one. */
export interface SessionStore {
  /** Starts a session and returns its token, which exists nowhere else afterwards. */
  create(session: NewSession): Promise<string>;
  /** The session for a token, unless there is none or it has expired. */
  find(token: string): Promise<Session | undefined>;
  /** Ends a session. Does nothing if there is none. */
  delete(token: string): Promise<void>;
}

/** How long a session lasts. It is not renewed: signing in again refreshes what may be seen. */
export const SESSION_TTL_SECONDS = 8 * 60 * 60;
