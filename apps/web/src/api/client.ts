import type { z } from "zod";
import {
  aiKeyErrorSchema,
  aiKeySummarySchema,
  aiKeyTestSchema,
  installationListSchema,
  meSchema,
  operatorOverviewSchema,
  overviewSchema,
  repositoryListSchema,
  reviewDetailsSchema,
  reviewListingSchema,
  reviewPageSchema,
  serviceInfoSchema,
  type AiKeySummary,
  type AiKeyTest,
  type CustomerProvider,
  type InstallationList,
  type Me,
  type OperatorOverview,
  type Overview,
  type RepositoryList,
  type ReviewDetails,
  type ReviewListing,
  type ReviewPage,
  type ReviewStatus,
  type ServiceInfo,
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

  /** For the people who run the deployment. Everyone else gets `not-found`. */
  operatorOverview: (signal?: AbortSignal): Promise<OperatorOverview> =>
    getJson("/api/operator/overview", operatorOverviewSchema, signal),

  /** Needs no session: it is what the page for signed-out visitors is built from. */
  service: (signal?: AbortSignal): Promise<ServiceInfo> =>
    getJson("/auth/service", serviceInfoSchema, signal),

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

  /** Reviews of every visible repository, optionally with one outcome only. */
  allReviews: (
    filter: { readonly status?: ReviewStatus | undefined; readonly cursor?: string | undefined },
    signal?: AbortSignal,
  ): Promise<ReviewListing> => {
    const query = new URLSearchParams();
    if (filter.status !== undefined) {
      query.set("status", filter.status);
    }
    if (filter.cursor !== undefined) {
      query.set("cursor", filter.cursor);
    }
    const suffix = query.size === 0 ? "" : `?${query.toString()}`;
    return getJson(`/api/reviews${suffix}`, reviewListingSchema, signal);
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

/** What an owner submits to store a key. It leaves the browser once and is never read back. */
export interface AiKeyInput {
  readonly provider: CustomerProvider;
  readonly model: string;
  readonly region?: string;
  /** The name of the Azure resource; only for `azure`. */
  readonly resource?: string;
  readonly apiKey: string;
}

/** What a test of the stored key found, or why the test could not be run. */
export type TestAiKeyResult =
  | AiKeyTest
  | { readonly result: "forbidden" }
  | { readonly result: "unauthenticated" }
  | { readonly result: "failed" };

export type SaveAiKeyResult =
  | { readonly ok: true; readonly key: AiKeySummary }
  /** The provider answered and refused the key, the model or the region. */
  | { readonly ok: false; readonly reason: "refused"; readonly providerStatus: number }
  /** The provider could not be reached; nothing was stored. */
  | { readonly ok: false; readonly reason: "unreachable" }
  | { readonly ok: false; readonly reason: "invalid"; readonly fields: readonly string[] }
  /** The person is not, or is no longer, an owner of the installation. */
  | { readonly ok: false; readonly reason: "forbidden" }
  | { readonly ok: false; readonly reason: "unauthenticated" }
  | { readonly ok: false; readonly reason: "failed" };

const WRITE_HEADERS = {
  Accept: "application/json",
  // A header that no form on another site can send; the API refuses a write without it.
  "X-PR-Buddy-Request": "1",
};
const FORBIDDEN = 403;

function keyPath(installationId: number): string {
  return `/api/installations/${encodeURIComponent(String(installationId))}/ai-key`;
}

async function refusalOf(response: Response): Promise<SaveAiKeyResult> {
  if (response.status === UNAUTHENTICATED) {
    return { ok: false, reason: "unauthenticated" };
  }
  if (response.status === FORBIDDEN || response.status === NOT_FOUND) {
    return { ok: false, reason: "forbidden" };
  }
  const body = aiKeyErrorSchema.safeParse(await response.json().catch(() => undefined));
  if (!body.success) {
    return { ok: false, reason: "failed" };
  }
  const { error, providerStatus, fields } = body.data;
  if (error === "key_refused" && providerStatus !== undefined) {
    return { ok: false, reason: "refused", providerStatus };
  }
  if (error === "provider_unreachable") {
    return { ok: false, reason: "unreachable" };
  }
  return error === "invalid_input"
    ? { ok: false, reason: "invalid", fields: fields ?? [] }
    : { ok: false, reason: "failed" };
}

export const aiKeys = {
  /** The session's installations and a summary of each one's key. `not-found` when the feature is off. */
  list: (signal?: AbortSignal): Promise<InstallationList> =>
    getJson("/api/installations", installationListSchema, signal),

  /** Stores or replaces an installation's key. Never throws: the result says what happened. */
  async save(installationId: number, input: AiKeyInput): Promise<SaveAiKeyResult> {
    try {
      const response = await fetch(keyPath(installationId), {
        method: "PUT",
        credentials: "same-origin",
        headers: { ...WRITE_HEADERS, "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!response.ok) {
        return await refusalOf(response);
      }
      const key = aiKeySummarySchema.safeParse(await response.json().catch(() => undefined));
      return key.success ? { ok: true, key: key.data } : { ok: false, reason: "failed" };
    } catch {
      return { ok: false, reason: "failed" };
    }
  },

  /**
   * Asks the provider once with the stored key. Never throws: the result says what happened.
   * It spends a little on the key, so the API treats it like a write.
   */
  async test(installationId: number): Promise<TestAiKeyResult> {
    try {
      const response = await fetch(`${keyPath(installationId)}/test`, {
        method: "POST",
        credentials: "same-origin",
        headers: WRITE_HEADERS,
      });
      if (response.status === UNAUTHENTICATED) {
        return { result: "unauthenticated" };
      }
      if (response.status === FORBIDDEN || response.status === NOT_FOUND) {
        return { result: "forbidden" };
      }
      if (!response.ok) {
        return { result: "failed" };
      }
      const tested = aiKeyTestSchema.safeParse(await response.json().catch(() => undefined));
      return tested.success ? tested.data : { result: "failed" };
    } catch {
      return { result: "failed" };
    }
  },

  /** Removes an installation's key. Resolves to whether the server confirmed it. */
  async remove(installationId: number): Promise<boolean> {
    try {
      const response = await fetch(keyPath(installationId), {
        method: "DELETE",
        credentials: "same-origin",
        headers: WRITE_HEADERS,
      });
      return response.ok;
    } catch {
      return false;
    }
  },
};
