import { useCallback, useEffect, useState } from "react";
import { ApiError } from "./api/client.js";

export type Resource<Data> =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly data: Data }
  | { readonly status: "error"; readonly error: ApiError };

export interface ResourceHandle<Data> {
  readonly resource: Resource<Data>;
  /** Loads the data again, for example after signing out. */
  readonly reload: () => void;
}

/**
 * Loads data when a component appears and again whenever `key` changes. A request that is no
 * longer wanted is cancelled, so an answer that arrives late never replaces a newer one.
 */
export function useResource<Data>(
  load: (signal: AbortSignal) => Promise<Data>,
  key: string,
): ResourceHandle<Data> {
  const [resource, setResource] = useState<Resource<Data>>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setResource({ status: "loading" });
    load(controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) {
          setResource({ status: "ready", data });
        }
      },
      (error: unknown) => {
        if (!controller.signal.aborted) {
          setResource({
            status: "error",
            error: error instanceof ApiError ? error : new ApiError("failed"),
          });
        }
      },
    );
    return () => {
      controller.abort();
    };
    // `load` is a new function on every render; `key` says when the request really changes.
  }, [key, attempt]);

  const reload = useCallback(() => {
    setAttempt((current) => current + 1);
  }, []);

  return { resource, reload };
}
