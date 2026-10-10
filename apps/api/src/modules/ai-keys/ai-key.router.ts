import { createProvider, ProviderHttpError, type ProviderSettings } from "@pr-buddy/ai-reviewer";
import express, { Router, type RequestHandler } from "express";
import { z } from "zod";
import type { Logger } from "../../logger.js";
import { sessionOf } from "../auth/auth.router.js";
import type { SessionInstallation } from "../auth/session-store.js";
import { aiKeyInputSchema, type AiKeyStore } from "./ai-key-store.js";

export interface AiKeyRouterDependencies {
  readonly aiKeyStore: AiKeyStore;
  readonly logger: Logger;
  /** The origin people use to reach the dashboard, without a trailing slash. */
  readonly publicUrl: string;
  /** Replaces the global `fetch` for the request that checks a key; used by tests. */
  readonly fetch?: typeof fetch;
}

/** A header no form on another site can send: a browser must ask first, and is never allowed. */
export const REQUEST_HEADER = "x-pr-buddy-request";

const MAX_BODY_BYTES = 16 * 1_024;
/** How long a provider is given to answer the request that checks a new key. */
const VERIFY_TIMEOUT_MS = 15_000;
const VERIFY_MAX_TOKENS = 16;

const BAD_REQUEST = 400;
const FORBIDDEN = 403;
const NOT_FOUND = 404;
const UNPROCESSABLE = 422;
const BAD_GATEWAY = 502;
const NO_CONTENT = 204;

const installationIdSchema = z
  .string()
  .regex(/^[1-9]\d{0,15}$/)
  .transform(Number);

type KeyCheck =
  | { readonly ok: true }
  /** The provider answered and refused: a wrong key, a missing model, no access. */
  | { readonly ok: false; readonly reason: "refused"; readonly status: number }
  /** The provider could not be reached or answered with something unreadable. */
  | { readonly ok: false; readonly reason: "unreachable" };

/**
 * Sends one very small request with the key that is about to be stored, so that a mistake is
 * found now and not at the next pull request. Nothing from a pull request is sent.
 */
async function checkKey(
  settings: ProviderSettings,
  send: typeof fetch | undefined,
): Promise<KeyCheck> {
  const provider = createProvider(settings, send === undefined ? {} : { fetch: send });
  try {
    await provider.complete({
      system: "Reply with the single word OK.",
      user: "OK",
      maxOutputTokens: VERIFY_MAX_TOKENS,
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    });
    return { ok: true };
  } catch (error) {
    return error instanceof ProviderHttpError
      ? { ok: false, reason: "refused", status: error.status }
      : { ok: false, reason: "unreachable" };
  }
}

/**
 * Lets an installation's owner store, replace and remove its AI key. It must be mounted behind
 * `createRequireSession`. See docs/DESIGN-AI-KEYS.md, section 6.
 */
export function createAiKeyRouter(dependencies: AiKeyRouterDependencies): Router {
  const { aiKeyStore, logger, publicUrl } = dependencies;
  const router = Router();

  /**
   * The locks on every request that changes something: it must come from the dashboard's own
   * origin and carry a header that only the dashboard's script sets. The session cookie is
   * `SameSite=Lax` as well, so each lock alone already stops a forged request.
   */
  const requireOwnOrigin: RequestHandler = (request, response, next) => {
    if (request.get("origin") !== publicUrl || request.get(REQUEST_HEADER) !== "1") {
      response.status(FORBIDDEN).json({ error: "forbidden" });
      return;
    }
    next();
  };

  /**
   * Finds the installation in the session. One the session does not hold answers `404`, like
   * one that does not exist; one the person does not own answers `403`.
   */
  function ownedInstallation(
    rawId: unknown,
    installations: readonly SessionInstallation[],
  ): { status: number; error: string } | { installation: SessionInstallation } {
    const id = installationIdSchema.safeParse(rawId);
    const installation = id.success
      ? installations.find((candidate) => candidate.id === id.data)
      : undefined;
    if (installation === undefined) {
      return { status: NOT_FOUND, error: "not_found" };
    }
    return installation.isOwner ? { installation } : { status: FORBIDDEN, error: "not_owner" };
  }

  router.get("/installations", async (_request, response) => {
    const { installations } = sessionOf(response.locals);
    const keys = await aiKeyStore.list(installations.map((installation) => installation.id));
    response.json({
      installations: installations.map((installation) => {
        const key = keys.find((candidate) => candidate.installationId === installation.id);
        return {
          id: installation.id,
          account: installation.account,
          canManage: installation.isOwner,
          aiKey:
            key === undefined
              ? null
              : {
                  provider: key.provider,
                  model: key.model,
                  region: key.region,
                  keyHint: key.keyHint,
                  updatedAt: key.updatedAt,
                },
        };
      }),
    });
  });

  router.put(
    "/installations/:installationId/ai-key",
    requireOwnOrigin,
    express.json({ limit: MAX_BODY_BYTES }),
    async (request, response) => {
      const session = sessionOf(response.locals);
      const owned = ownedInstallation(request.params["installationId"], session.installations);
      if (!("installation" in owned)) {
        response.status(owned.status).json({ error: owned.error });
        return;
      }
      const input = aiKeyInputSchema.safeParse(request.body);
      if (!input.success) {
        // Field names and constraints only: the body holds a secret.
        response.status(BAD_REQUEST).json({
          error: "invalid_input",
          fields: [...new Set(input.error.issues.map((issue) => String(issue.path[0] ?? "body")))],
        });
        return;
      }

      const { id: installationId } = owned.installation;
      const check = await checkKey(input.data, dependencies.fetch);
      if (!check.ok) {
        logger.info(
          { installationId, userId: session.userId, provider: input.data.provider, ...check },
          "AI key not saved: the provider did not accept it",
        );
        response
          .status(check.reason === "refused" ? UNPROCESSABLE : BAD_GATEWAY)
          .json(
            check.reason === "refused"
              ? { error: "key_refused", providerStatus: check.status }
              : { error: "provider_unreachable" },
          );
        return;
      }

      const saved = await aiKeyStore.save(installationId, input.data, session.userId);
      logger.info(
        { installationId, userId: session.userId, provider: saved.provider },
        "AI key saved",
      );
      response.json({
        provider: saved.provider,
        model: saved.model,
        region: saved.region,
        keyHint: saved.keyHint,
        updatedAt: saved.updatedAt,
      });
    },
  );

  router.delete(
    "/installations/:installationId/ai-key",
    requireOwnOrigin,
    async (request, response) => {
      const session = sessionOf(response.locals);
      const owned = ownedInstallation(request.params["installationId"], session.installations);
      if (!("installation" in owned)) {
        response.status(owned.status).json({ error: owned.error });
        return;
      }
      const removed = await aiKeyStore.remove(owned.installation.id, session.userId);
      if (removed) {
        logger.info(
          { installationId: owned.installation.id, userId: session.userId },
          "AI key removed",
        );
      }
      response.status(NO_CONTENT).end();
    },
  );

  return router;
}
