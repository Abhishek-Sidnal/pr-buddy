/**
 * Thrown when a provider answers with a status that is not a success. Its name carries the
 * status, for example `ProviderHttp429`, because the name is all that is logged and stored. The
 * body of the reply is deliberately not read: an error body can repeat the request.
 */
export class ProviderHttpError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`The AI provider answered with HTTP ${status}.`);
    this.name = `ProviderHttp${status}`;
    this.status = status;
  }
}

/** Thrown when a provider's reply is not JSON, or not the JSON its API documents. */
export class ProviderResponseError extends Error {
  constructor() {
    super("The AI provider's reply could not be read.");
    this.name = "ProviderResponseError";
  }
}

export interface JsonRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  /** The request body, already serialised: a signature may have been computed over it. */
  readonly body: string;
  readonly signal: AbortSignal;
}

/**
 * Sends one JSON request and returns the parsed reply. There is no retry: an AI review is
 * optional, and a second attempt would double its cost.
 * @throws {ProviderHttpError | ProviderResponseError}
 */
export async function postJson(send: typeof fetch, request: JsonRequest): Promise<unknown> {
  const response = await send(request.url, {
    method: "POST",
    headers: request.headers,
    body: request.body,
    signal: request.signal,
  });
  if (!response.ok) {
    // Release the connection without looking at what the service said.
    await response.body?.cancel().catch(() => undefined);
    throw new ProviderHttpError(response.status);
  }
  try {
    return await response.json();
  } catch {
    throw new ProviderResponseError();
  }
}
