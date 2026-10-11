import type {
  AiProvider,
  AiRequest,
  AiResponse,
  AiToolProvider,
  AiTurn,
  AiTurnRequest,
} from "./provider.js";

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

/** What a scripted provider does with one step of a conversation. */
export type ScriptedTurn = string | AiTurn | ((request: AiTurnRequest) => Promise<AiTurn>);

export interface ScriptedToolProvider extends AiToolProvider {
  /** Every step received, oldest first. */
  readonly turnRequests: AiTurnRequest[];
}

/**
 * A provider for conversations with tools that answers from a script, one entry per step. A
 * string is a final answer with no tool request. Like `createScriptedProvider`, it calls no
 * model and is never a default.
 */
export function createScriptedToolProvider(
  turns: readonly ScriptedTurn[],
  identity: { readonly name?: string; readonly model?: string } = {},
): ScriptedToolProvider {
  const turnRequests: AiTurnRequest[] = [];
  return {
    name: identity.name ?? "scripted",
    model: identity.model ?? "scripted-1",
    turnRequests,
    complete() {
      return Promise.reject(new Error("This script is for conversations with tools."));
    },
    converse(request) {
      const turn = turns[turnRequests.length];
      turnRequests.push(request);
      if (turn === undefined) {
        return Promise.reject(new Error("The script has no more turns."));
      }
      if (typeof turn === "function") {
        return turn(request);
      }
      return Promise.resolve(typeof turn === "string" ? { text: turn, toolCalls: [] } : turn);
    },
  };
}
