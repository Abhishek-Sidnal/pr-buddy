import { randomBytes, timingSafeEqual } from "node:crypto";
import { SignInError, type UserAuthClient } from "@pr-buddy/github-client";
import { Router, type RequestHandler } from "express";
import type { Logger } from "../../logger.js";
import {
  clearCookie,
  cookieNamesFor,
  readCookie,
  serializeCookie,
  type CookieNames,
} from "./session-cookie.js";
import { SESSION_TTL_SECONDS, type Session, type SessionStore } from "./session-store.js";

export interface AuthDependencies {
  readonly authClient: UserAuthClient;
  readonly sessionStore: SessionStore;
  readonly logger: Logger;
  /** The origin people use to reach the service, without a trailing slash. */
  readonly publicUrl: string;
}

const STATE_BYTES = 32;
/** How long a person has to finish signing in at GitHub. */
const STATE_TTL_SECONDS = 10 * 60;
const STATE_FORMAT = /^[A-Za-z0-9_-]{43}$/;
/** GitHub's codes are short hexadecimal strings; anything unlike one is not sent to GitHub. */
const CODE_FORMAT = /^[A-Za-z0-9_-]{1,256}$/;

const UNAUTHENTICATED = 401;
const FORBIDDEN = 403;
const NO_CONTENT = 204;

/** Where the callback sends a browser. Both are fixed paths on the dashboard's own origin. */
const SIGNED_IN_PATH = "/";
const SIGN_IN_FAILED_PATH = "/?sign-in=failed";

function isSameState(expected: string, received: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  return a.length === b.length && timingSafeEqual(a, b);
}

function queryText(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Reads the session of a request, if it has a valid one. */
export function createSessionReader(
  sessionStore: SessionStore,
  names: CookieNames,
): (cookieHeader: string | undefined) => Promise<Session | undefined> {
  return async (cookieHeader) => {
    const token = readCookie(cookieHeader, names.session);
    return token === undefined ? undefined : sessionStore.find(token);
  };
}

/**
 * Rejects a request without a valid session and makes the session available to later handlers
 * as `response.locals.session`.
 */
export function createRequireSession(
  sessionStore: SessionStore,
  publicUrl: string,
): RequestHandler {
  const readSession = createSessionReader(sessionStore, cookieNamesFor(publicUrl));
  return async (request, response, next) => {
    const session = await readSession(request.headers.cookie);
    if (session === undefined) {
      response.status(UNAUTHENTICATED).json({ error: "unauthenticated" });
      return;
    }
    response.locals["session"] = session;
    next();
  };
}

/** The session placed on the response by `createRequireSession`. */
export function sessionOf(locals: Record<string, unknown>): Session {
  return locals["session"] as Session;
}

/** Sign-in with GitHub, and sign-out. See docs/DESIGN-DASHBOARD.md, section 3. */
export function createAuthRouter(dependencies: AuthDependencies): Router {
  const { authClient, sessionStore, logger, publicUrl } = dependencies;
  const names = cookieNamesFor(publicUrl);
  const redirectUri = `${publicUrl}/auth/callback`;
  const router = Router();

  router.get("/login", (_request, response) => {
    const state = randomBytes(STATE_BYTES).toString("base64url");
    response.append("Set-Cookie", serializeCookie(names, names.state, state, STATE_TTL_SECONDS));
    response.redirect(authClient.authorizeUrl(state, redirectUri));
  });

  router.get("/callback", async (request, response) => {
    const expectedState = readCookie(request.headers.cookie, names.state);
    const state = queryText(request.query["state"]);
    const code = queryText(request.query["code"]);
    // A state is good for one attempt, whatever its outcome.
    response.append("Set-Cookie", clearCookie(names, names.state));

    const fail = (reason: string): void => {
      logger.warn({ reason }, "Sign-in failed");
      response.redirect(SIGN_IN_FAILED_PATH);
    };

    if (
      expectedState === undefined ||
      state === undefined ||
      !STATE_FORMAT.test(state) ||
      !isSameState(expectedState, state)
    ) {
      fail("state-mismatch");
      return;
    }
    // The person declined at GitHub, or the link was not produced by GitHub.
    if (code === undefined || !CODE_FORMAT.test(code)) {
      fail("no-code");
      return;
    }

    let access;
    try {
      access = await authClient.signIn(code, redirectUri);
    } catch (error) {
      if (error instanceof SignInError) {
        fail(error.reason);
        return;
      }
      throw error;
    }

    const token = await sessionStore.create({
      userId: access.user.id,
      login: access.user.login,
      installationIds: access.installationIds,
    });
    response.append(
      "Set-Cookie",
      serializeCookie(names, names.session, token, SESSION_TTL_SECONDS),
    );
    logger.info(
      { userId: access.user.id, installationCount: access.installationIds.length },
      "Signed in",
    );
    response.redirect(SIGNED_IN_PATH);
  });

  router.post("/logout", async (request, response) => {
    // A browser sends Origin with every cross-site POST. The cookie is SameSite=Lax as well, so
    // this is a second lock on the only request that changes anything.
    const { origin } = request.headers;
    if (origin !== undefined && origin !== publicUrl) {
      response.status(FORBIDDEN).json({ error: "forbidden" });
      return;
    }
    const token = readCookie(request.headers.cookie, names.session);
    if (token !== undefined) {
      await sessionStore.delete(token);
    }
    response.append("Set-Cookie", clearCookie(names, names.session));
    response.status(NO_CONTENT).end();
  });

  return router;
}
