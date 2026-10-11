import { describe, expect, it } from "vitest";
import { MAX_TOOL_CALLS_PER_STEP, MAX_TOOL_RESULT_LENGTH } from "../../src/limits.js";
import type { AiToolCall, AiTurn } from "../../src/provider.js";
import { ProviderHttpError } from "../../src/providers/http.js";
import { createScriptedToolProvider } from "../../src/scripted-provider.js";
import {
  CLOSING_MESSAGE,
  runToolLoop,
  TOO_MANY_CALLS,
  TOOL_FAILED,
  UNKNOWN_TOOL,
} from "../../src/tool-loop.js";
import type { AiTool } from "../../src/tool.js";

const SCHEMA = { type: "object", properties: {} };

/** A tool that says what it was given, and counts how often it ran. */
function echoTool(name = "echo"): AiTool & { readonly inputs: unknown[] } {
  const inputs: unknown[] = [];
  return {
    name,
    description: "Repeats its input.",
    inputSchema: SCHEMA,
    inputs,
    run(input) {
      inputs.push(input);
      return Promise.resolve({ text: `ECHO ${JSON.stringify(input)}`, isRefused: false });
    },
  };
}

const call = (id: string, name = "echo", input: unknown = { n: id }): AiToolCall => ({
  id,
  name,
  input,
});
const asks = (...toolCalls: AiToolCall[]): AiTurn => ({ text: "", toolCalls });

const base = { system: "SYSTEM", user: "USER" };

describe("the tool loop", () => {
  it("returns the answer of a model that asks for nothing", async () => {
    const provider = createScriptedToolProvider(["FINAL"]);
    const tool = echoTool();

    const result = await runToolLoop({ ...base, provider, tools: [tool] });

    expect(result).toEqual({
      status: "completed",
      text: "FINAL",
      stop: "answered",
      requestCount: 1,
      toolCallCount: 0,
      durationMs: expect.any(Number) as number,
    });
    expect(provider.turnRequests[0]).toMatchObject({
      system: "SYSTEM",
      messages: [{ role: "user", text: "USER" }],
      tools: [{ name: "echo", description: "Repeats its input.", inputSchema: SCHEMA }],
      toolChoice: "auto",
    });
    // The tool's code is not part of what a provider is given.
    expect(provider.turnRequests[0]?.tools[0]).not.toHaveProperty("run");
  });

  it("runs the tools a reply asks for and gives their answers back", async () => {
    const provider = createScriptedToolProvider([
      {
        text: "Looking.",
        toolCalls: [call("a"), call("b")],
        usage: { inputTokens: 100, outputTokens: 10 },
      },
      { text: "FINAL", toolCalls: [], usage: { inputTokens: 150, outputTokens: 20 } },
    ]);
    const tool = echoTool();

    const result = await runToolLoop({ ...base, provider, tools: [tool] });

    expect(result).toMatchObject({
      status: "completed",
      text: "FINAL",
      stop: "answered",
      requestCount: 2,
      toolCallCount: 2,
      usage: { inputTokens: 250, outputTokens: 30 },
    });
    expect(tool.inputs).toEqual([{ n: "a" }, { n: "b" }]);
    expect(provider.turnRequests[1]?.messages).toEqual([
      { role: "user", text: "USER" },
      { role: "assistant", text: "Looking.", toolCalls: [call("a"), call("b")] },
      {
        role: "tool",
        results: [
          { id: "a", name: "echo", text: 'ECHO {"n":"a"}', isRefused: false },
          { id: "b", name: "echo", text: 'ECHO {"n":"b"}', isRefused: false },
        ],
      },
    ]);
    // The first request still holds what was sent then, not the conversation as it grew.
    expect(provider.turnRequests[0]?.messages).toHaveLength(1);
  });

  it("refuses a tool it does not have, and survives a tool that fails", async () => {
    const failing: AiTool = {
      name: "broken",
      description: "Fails.",
      inputSchema: SCHEMA,
      run: () => Promise.reject(new Error("ENOENT /secret/PATH-CANARY")),
    };
    const provider = createScriptedToolProvider([
      asks(call("1", "run_shell"), call("2", "broken"), call("3")),
      "FINAL",
    ]);

    const result = await runToolLoop({ ...base, provider, tools: [echoTool(), failing] });

    expect(result).toMatchObject({ status: "completed", toolCallCount: 3 });
    expect(provider.turnRequests[1]?.messages.at(-1)).toEqual({
      role: "tool",
      results: [
        { id: "1", name: "run_shell", text: UNKNOWN_TOOL, isRefused: true },
        { id: "2", name: "broken", text: TOOL_FAILED, isRefused: true },
        { id: "3", name: "echo", text: 'ECHO {"n":"3"}', isRefused: false },
      ],
    });
    expect(JSON.stringify(provider.turnRequests)).not.toContain("PATH-CANARY");
  });

  it("serves a limited number of requests from one reply", async () => {
    const calls = Array.from({ length: MAX_TOOL_CALLS_PER_STEP + 2 }, (_unused, index) =>
      call(String(index)),
    );
    const provider = createScriptedToolProvider([asks(...calls), "FINAL"]);
    const tool = echoTool();

    await runToolLoop({ ...base, provider, tools: [tool] });

    expect(tool.inputs).toHaveLength(MAX_TOOL_CALLS_PER_STEP);
    const last = provider.turnRequests[1]?.messages.at(-1);
    expect(last?.role === "tool" && last.results.slice(-2)).toEqual([
      expect.objectContaining({ text: TOO_MANY_CALLS, isRefused: true }),
      expect.objectContaining({ text: TOO_MANY_CALLS, isRefused: true }),
    ]);
  });

  it("cuts a tool's answer that is longer than any tool should give", async () => {
    const verbose: AiTool = {
      name: "echo",
      description: "Says too much.",
      inputSchema: SCHEMA,
      run: () =>
        Promise.resolve({ text: "x".repeat(MAX_TOOL_RESULT_LENGTH + 10), isRefused: false }),
    };
    const provider = createScriptedToolProvider([asks(call("1")), "FINAL"]);

    await runToolLoop({ ...base, provider, tools: [verbose] });

    const last = provider.turnRequests[1]?.messages.at(-1);
    expect(last?.role === "tool" && last.results[0]?.text.length).toBe(MAX_TOOL_RESULT_LENGTH);
  });

  it("asks for the answer when the limit on steps is reached, and ignores a tool request then", async () => {
    const provider = createScriptedToolProvider([
      asks(call("1")),
      asks(call("2")),
      { text: "FINAL", toolCalls: [call("3")] },
    ]);
    const tool = echoTool();

    const result = await runToolLoop({
      ...base,
      provider,
      tools: [tool],
      limits: { maxSteps: 2 },
    });

    expect(result).toMatchObject({
      status: "completed",
      text: "FINAL",
      stop: "steps",
      requestCount: 3,
      toolCallCount: 2,
    });
    expect(tool.inputs).toHaveLength(2);
    const closing = provider.turnRequests[2];
    expect(closing?.toolChoice).toBe("none");
    expect(closing?.tools).toHaveLength(1);
    expect(closing?.messages.at(-1)).toMatchObject({ role: "tool", note: CLOSING_MESSAGE });
    // The closing words go with the last answers; no turn is added.
    expect(closing?.messages).toHaveLength(5);
  });

  it("asks for the answer when the limit on tokens is reached", async () => {
    const turn = { ...asks(call("1")), usage: { inputTokens: 50, outputTokens: 10 } };
    const provider = createScriptedToolProvider([turn, turn, "FINAL"]);

    const result = await runToolLoop({
      ...base,
      provider,
      tools: [echoTool()],
      limits: { maxTokens: 100 },
    });

    expect(result).toMatchObject({
      status: "completed",
      stop: "tokens",
      requestCount: 3,
      usage: { inputTokens: 100, outputTokens: 20 },
    });
  });

  it("asks for the answer when the caller says to stop", async () => {
    const provider = createScriptedToolProvider([asks(call("1")), "FINAL"]);

    const result = await runToolLoop({
      ...base,
      provider,
      tools: [echoTool()],
      shouldStop: () => true,
    });

    expect(result).toMatchObject({ status: "completed", stop: "caller", requestCount: 2 });
    expect(provider.turnRequests[1]?.toolChoice).toBe("none");
  });

  it("goes straight to the answer when no steps are allowed", async () => {
    const provider = createScriptedToolProvider(["FINAL"]);

    const result = await runToolLoop({
      ...base,
      provider,
      tools: [echoTool()],
      limits: { maxSteps: 0 },
    });

    expect(result).toMatchObject({ status: "completed", text: "FINAL", stop: "steps" });
    expect(provider.turnRequests[0]).toMatchObject({
      toolChoice: "none",
      messages: [{ role: "user", text: "USER" }],
    });
  });

  it("fails by time when the provider does not answer, and tells it to stop", async () => {
    let signal: AbortSignal | undefined;
    const provider = createScriptedToolProvider([
      (request) => {
        signal = request.signal;
        return new Promise<AiTurn>(() => undefined);
      },
    ]);

    const result = await runToolLoop({
      ...base,
      provider,
      tools: [],
      limits: { timeoutMs: 10 },
    });

    expect(result).toMatchObject({ status: "failed", failureReason: "timeout", requestCount: 1 });
    expect(signal?.aborted).toBe(true);
  });

  it("fails by time when it runs out while a tool is working", async () => {
    const slow: AiTool = {
      name: "echo",
      description: "Takes its time.",
      inputSchema: SCHEMA,
      run: () =>
        new Promise((resolve) => {
          setTimeout(() => {
            resolve({ text: "late", isRefused: false });
          }, 40);
        }),
    };
    const provider = createScriptedToolProvider([asks(call("1")), "FINAL"]);

    const result = await runToolLoop({
      ...base,
      provider,
      tools: [slow],
      limits: { timeoutMs: 10 },
    });

    expect(result).toMatchObject({ status: "failed", failureReason: "timeout", requestCount: 1 });
    expect(provider.turnRequests).toHaveLength(1);
  });

  it("records a provider's failure by the name of its error only", async () => {
    const failing = createScriptedToolProvider([
      asks(call("1")),
      () => Promise.reject(new ProviderHttpError(429)),
    ]);
    const odd = createScriptedToolProvider([
      () => Promise.reject(Object.assign(new Error("PROMPT-CANARY"), { name: "not a name!" })),
    ]);

    const failed = await runToolLoop({ ...base, provider: failing, tools: [echoTool()] });

    expect(failed).toMatchObject({
      status: "failed",
      failureReason: "provider-error",
      errorName: "ProviderHttp429",
      requestCount: 2,
      toolCallCount: 1,
    });
    const other = await runToolLoop({ ...base, provider: odd, tools: [] });
    expect(other).toMatchObject({ failureReason: "provider-error", errorName: "Error" });
    expect(JSON.stringify(other)).not.toContain("CANARY");
  });

  it("fails when the script, like a provider, has nothing more to say", async () => {
    const provider = createScriptedToolProvider([]);

    expect(await runToolLoop({ ...base, provider, tools: [] })).toMatchObject({
      status: "failed",
      failureReason: "provider-error",
      errorName: "Error",
    });
    await expect(
      provider.complete({ ...base, maxOutputTokens: 1, signal: new AbortController().signal }),
    ).rejects.toThrow("conversations with tools");
  });

  it.each([
    ["no text", { toolCalls: [] }],
    ["no list of tool requests", { text: "x" }],
    ["a tool request without an identifier", { text: "", toolCalls: [{ id: "", name: "echo" }] }],
    ["a tool name that is too long", { text: "", toolCalls: [{ id: "1", name: "n".repeat(65) }] }],
    ["nothing", undefined],
  ])("fails on a reply with %s", async (_name, reply) => {
    const provider = createScriptedToolProvider([() => Promise.resolve(reply as AiTurn)]);

    expect(await runToolLoop({ ...base, provider, tools: [echoTool()] })).toMatchObject({
      status: "failed",
      failureReason: "invalid-response",
    });
  });

  it("drops usage that is malformed and keeps the reply", async () => {
    const provider = createScriptedToolProvider([
      () =>
        Promise.resolve({
          text: "FINAL",
          toolCalls: [],
          usage: { inputTokens: -1, outputTokens: 2 },
        }),
    ]);

    const result = await runToolLoop({ ...base, provider, tools: [] });

    expect(result).toMatchObject({ status: "completed", text: "FINAL" });
    expect(result).not.toHaveProperty("usage");
  });

  it("measures how long it took with the clock it is given", async () => {
    const times = [1_000, 1_250.4];
    const provider = createScriptedToolProvider(["FINAL"]);

    const result = await runToolLoop({
      ...base,
      provider,
      tools: [],
      now: () => times.shift() ?? 0,
    });

    expect(result.durationMs).toBe(250);
  });

  it("uses a script's own names when given", () => {
    const provider = createScriptedToolProvider([], { name: "test", model: "model-1" });

    expect([provider.name, provider.model]).toEqual(["test", "model-1"]);
  });
});
