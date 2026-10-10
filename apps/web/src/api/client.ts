import type { z } from "zod";
import {
  meSchema,
  overviewSchema,
  repositoryListSchema,
  reviewDetailsSchema,
  reviewPageSchema,
  type Me,
  type Overview,
  type RepositoryList,
  type ReviewDetails,
  type ReviewPage,
} from "./schemas.js";

export type ApiErrorKind = "unauthenticated" | "not-found" | "failed";

/** Why a request did not produce data. Its kind decides what the page shows. */
export class ApiError extends Error {
  readonly kind: ApiErrorKind;

  constructor(kind: ApiErrorKind) {
    super(`Request failed: ${kind}.`);
    this.name = "ApiError";
    this.kind = kind;
  }
}

const UNAUTHENTICATED = 401;
const NOT_FOUND = 404;

function kindOf(status: number): ApiErrorKind {
  if (status === UNAUTHENTICATED) {
    return "unauthenticated";
  }
  return status === NOT_FOUND ? "not-found" : "failed";
}

/**
 * Fetches a path of the dashboard's own origin and checks the answer against a schema. The
 * session travels in a cookie the browser attaches; this code never sees it.
 * @throws {ApiError}
 */
async function getJson<Schema extends z.ZodType>(
  path: string,
  schema: Schema,
  signal?: AbortSignal,
): Promise<z.infer<Schema>> {
  let response: Response;
  try {
    response = await fetch(path, {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    // A cancelled request is not a failure to report; the caller has moved on.
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error;
    }
    throw new ApiError("failed");
  }
  if (!response.ok) {
    throw new ApiError(kindOf(response.status));
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ApiError("failed");
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError("failed");
  }
  return parsed.data;
}

export const api = {
  me: (signal?: AbortSignal): Promise<Me> => getJson("/api/me", meSchema, signal),

  overview: (signal?: AbortSignal): Promise<Overview> =>
    getJson("/api/overview", overviewSchema, signal),

  repositories: (signal?: AbortSignal): Promise<RepositoryList> =>
    getJson("/api/repositories", repositoryListSchema, signal),

  reviews: (repositoryId: string, cursor?: string, signal?: AbortSignal): Promise<ReviewPage> => {
    const query = cursor === undefined ? "" : `?cursor=${encodeURIComponent(cursor)}`;
    return getJson(
      `/api/repositories/${encodeURIComponent(repositoryId)}/reviews${query}`,
      reviewPageSchema,
      signal,
    );
  },

  review: (reviewId: string, signal?: AbortSignal): Promise<ReviewDetails> =>
    getJson(`/api/reviews/${encodeURIComponent(reviewId)}`, reviewDetailsSchema, signal),

  /** Ends the session. Resolves whether or not there was one. */
  async signOut(): Promise<void> {
    await fetch("/auth/logout", { method: "POST", credentials: "same-origin" });
  },
};

/** Where the browser goes to start signing in. A navigation, not a fetch. */
export const SIGN_IN_PATH = "/auth/login";
