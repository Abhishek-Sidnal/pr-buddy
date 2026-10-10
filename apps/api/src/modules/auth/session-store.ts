/** Who a browser is, and what they may see, for as long as the session lasts. */
export interface Session {
  /** GitHub's numeric ID of the person. */
  readonly userId: number;
  readonly login: string;
  /** Installations the person could access when they signed in. Every read is limited to them. */
  readonly installationIds: readonly number[];
  readonly expiresAt: Date;
}

export type NewSession = Omit<Session, "expiresAt">;

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
