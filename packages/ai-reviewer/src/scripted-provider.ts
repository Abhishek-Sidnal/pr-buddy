import type { AiProvider, AiRequest, AiResponse } from "./provider.js";

/** What a scripted provider does with one request: a reply, or a function that produces one. */
export type ScriptedReply = string | AiResponse | ((request: AiRequest) => Promise<AiResponse>);

export interface ScriptedProvider extends AiProvider {
  /** Every request received, oldest first. */
  readonly requests: AiRequest[];
}

/**
 * A provider that calls no model and answers from a script, one entry per request. It exists for
 * tests and for trying the pipeline by hand; it is never a default. A request beyond the end of
 * the script rejects.
 */
export function createScriptedProvider(
  replies: readonly ScriptedReply[],
  identity: { readonly name?: string; readonly model?: string } = {},
): ScriptedProvider {
  const requests: AiRequest[] = [];
  return {
    name: identity.name ?? "scripted",
    model: identity.model ?? "scripted-1",
    requests,
    complete(request) {
      const reply = replies[requests.length];
      requests.push(request);
      if (reply === undefined) {
        return Promise.reject(new Error("The script has no more replies."));
      }
      if (typeof reply === "function") {
        return reply(request);
      }
      return Promise.resolve(typeof reply === "string" ? { text: reply } : reply);
    },
  };
}
