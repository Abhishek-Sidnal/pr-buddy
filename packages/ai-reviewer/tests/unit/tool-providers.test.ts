import { describe, expect, it } from "vitest";
import type { AiToolProvider, AiTurnRequest } from "../../src/provider.js";
import { createAnthropicProvider } from "../../src/providers/anthropic.js";
import { createBedrockProvider } from "../../src/providers/bedrock.js";
import { ProviderHttpError, ProviderResponseError } from "../../src/providers/http.js";
import { createChatCompletionsProvider } from "../../src/providers/openai.js";
import { createProvider, providerSettingsSchema } from "../../src/providers/provider-settings.js";

/** A `fetch` that records each request's body and answers with the given reply. */
function fakeFetch(answer: unknown, status = 200): { fetch: typeof fetch; bodies: unknown[] } {
  const bodies: unknown[] = [];
  const fetchStub: typeof fetch = (_input, init) => {
    bodies.push(JSON.parse(typeof init?.body === "string" ? init.body : "null") as unknown);
    return Promise.resolve(
      new Response(JSON.stringify(answer), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  };
  return { fetch: fetchStub, bodies };
}

const SCHEMA = { type: "object", properties: { path: { type: "string" } }, required: ["path"] };

/** A conversation after one step: the model asked for a file and was answered. */
function conversation(overrides: Partial<AiTurnRequest> = {}): AiTurnRequest {
  return {
    system: "SYSTEM TEXT",
    messages: [
      { role: "user", text: "USER TEXT" },
      {
        role: "assistant",
        text: "I will look.",
        toolCalls: [{ id: "call-1", name: "read_file", input: { path: "a.ts" } }],
      },
      {
        role: "tool",
        results: [{ id: "call-1", name: "read_file", text: "1: one", isRefused: false }],
      },
      {
        role: "assistant",
        text: "",
        toolCalls: [{ id: "call-2", name: "read_file", input: null }],
      },
      {
        role: "tool",
        results: [{ id: "call-2", name: "read_file", text: "REFUSED", isRefused: true }],
        note: "CLOSING",
      },
    ],
    tools: [{ name: "read_file", description: "Reads a file.", inputSchema: SCHEMA }],
    toolChoice: "auto",
    maxOutputTokens: 4_000,
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe("the Anthropic provider, with tools", () => {
  const build = (answer: unknown): { provider: AiToolProvider; bodies: unknown[] } => {
    const { fetch, bodies } = fakeFetch(answer);
    return {
      provider: createAnthropicProvider({ model: "claude-test", apiKey: "KEY", fetch }),
      bodies,
    };
  };

  it("sends the tools and the conversation in the Messages form", async () => {
    const { provider, bodies } = build({ content: [{ type: "text", text: "FINAL" }] });

    await provider.converse(conversation());

    expect(bodies[0]).toEqual({
      model: "claude-test",
      max_tokens: 4_000,
      system: "SYSTEM TEXT",
      tools: [{ name: "read_file", description: "Reads a file.", input_schema: SCHEMA }],
      tool_choice: { type: "auto" },
      messages: [
        { role: "user", content: "USER TEXT" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "I will look." },
            { type: "tool_use", id: "call-1", name: "read_file", input: { path: "a.ts" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "call-1", content: "1: one", is_error: false },
          ],
        },
        // No empty text block: the API refuses one.
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "call-2", name: "read_file", input: null }],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "call-2", content: "REFUSED", is_error: true },
            { type: "text", text: "CLOSING" },
          ],
        },
      ],
    });
  });

  it("can ask for an answer without tools", async () => {
    const { provider, bodies } = build({ content: [] });

    await provider.converse(conversation({ toolChoice: "none" }));

    expect(bodies[0]).toMatchObject({ tool_choice: { type: "none" } });
  });

  it("reads text, requests for tools and usage from a reply", async () => {
    const { provider } = build({
      content: [
        { type: "thinking", thinking: "…" },
        { type: "text", text: "Let me " },
        { type: "text", text: "check." },
        { type: "tool_use", id: "tu-1", name: "search", input: { query: "total" } },
        { type: "tool_use", name: "search", input: {} },
      ],
      usage: { input_tokens: 12, output_tokens: 3 },
    });

    expect(await provider.converse(conversation())).toEqual({
      text: "Let me check.",
      toolCalls: [{ id: "tu-1", name: "search", input: { query: "total" } }],
      usage: { inputTokens: 12, outputTokens: 3 },
    });
  });

  it("reports no usage when there is none", async () => {
    const { provider } = build({ content: [{ type: "text", text: "FINAL" }] });

    expect(await provider.converse(conversation())).toEqual({ text: "FINAL", toolCalls: [] });
  });
});

describe("the Chat Completions providers, with tools", () => {
  const build = (
    answer: unknown,
    dialect: "openai" | "azure" | "openai-compatible" = "openai",
  ): { provider: AiToolProvider; bodies: unknown[] } => {
    const { fetch, bodies } = fakeFetch(answer);
    return {
      provider: createChatCompletionsProvider({
        dialect,
        model: "gpt-test",
        apiKey: "KEY",
        baseUrl: "https://api.example/v1",
        fetch,
      }),
      bodies,
    };
  };
  const final = { choices: [{ message: { content: "FINAL" } }] };

  it("sends the tools as functions and each tool answer as a message of its own", async () => {
    const { provider, bodies } = build(final);

    await provider.converse(conversation());

    expect(bodies[0]).toEqual({
      model: "gpt-test",
      max_completion_tokens: 4_000,
      tool_choice: "auto",
      tools: [
        {
          type: "function",
          function: { name: "read_file", description: "Reads a file.", parameters: SCHEMA },
        },
      ],
      messages: [
        { role: "system", content: "SYSTEM TEXT" },
        { role: "user", content: "USER TEXT" },
        {
          role: "assistant",
          content: "I will look.",
          tool_calls: [
            {
              id: "call-1",
              type: "function",
              function: { name: "read_file", arguments: '{"path":"a.ts"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "call-1", content: "1: one" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "call-2", type: "function", function: { name: "read_file", arguments: "{}" } },
          ],
        },
        { role: "tool", tool_call_id: "call-2", content: "REFUSED" },
        { role: "user", content: "CLOSING" },
      ],
    });
    // A reply that asks for a tool is not a JSON document.
    expect(bodies[0]).not.toHaveProperty("response_format");
  });

  it("gives a compatible server the older token limit, and can ask for no tools", async () => {
    const { provider, bodies } = build(final, "openai-compatible");

    await provider.converse(
      conversation({
        toolChoice: "none",
        messages: [{ role: "assistant", text: "x", toolCalls: [] }],
      }),
    );

    expect(bodies[0]).toMatchObject({
      max_tokens: 4_000,
      tool_choice: "none",
      messages: [
        { role: "system", content: "SYSTEM TEXT" },
        { role: "assistant", content: "x" },
      ],
    });
    expect(JSON.stringify(bodies[0])).not.toContain("tool_calls");
  });

  it("reads text, requests for tools and usage from a reply", async () => {
    const { provider } = build({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              {
                id: "c1",
                type: "function",
                function: { name: "search", arguments: '{"query":"x"}' },
              },
              { id: "c2", type: "function", function: { name: "search", arguments: "{not json" } },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 20, completion_tokens: 5 },
    });

    expect(await provider.converse(conversation())).toEqual({
      text: "",
      toolCalls: [
        { id: "c1", name: "search", input: { query: "x" } },
        // Arguments that are not JSON reach the tool as nothing, and the tool refuses them.
        { id: "c2", name: "search", input: undefined },
      ],
      usage: { inputTokens: 20, outputTokens: 5 },
    });
  });

  it("reads a plain answer, with no usage", async () => {
    const { provider } = build({ ...final, usage: null }, "azure");

    expect(await provider.converse(conversation())).toEqual({ text: "FINAL", toolCalls: [] });
  });
});

describe("the Bedrock provider, with tools", () => {
  const build = (answer: unknown): { provider: AiToolProvider; bodies: unknown[] } => {
    const { fetch, bodies } = fakeFetch(answer);
    return {
      provider: createBedrockProvider({
        model: "model-test",
        region: "us-east-1",
        auth: { apiKey: "KEY" },
        fetch,
      }),
      bodies,
    };
  };

  it("sends the tools and the conversation in the Converse form", async () => {
    const { provider, bodies } = build({ output: { message: { content: [{ text: "FINAL" }] } } });

    await provider.converse(conversation({ toolChoice: "none" }));

    expect(bodies[0]).toEqual({
      system: [{ text: "SYSTEM TEXT" }],
      inferenceConfig: { maxTokens: 4_000 },
      // Converse has no setting for "no tools now", so none is sent.
      toolConfig: {
        tools: [
          {
            toolSpec: {
              name: "read_file",
              description: "Reads a file.",
              inputSchema: { json: SCHEMA },
            },
          },
        ],
      },
      messages: [
        { role: "user", content: [{ text: "USER TEXT" }] },
        {
          role: "assistant",
          content: [
            { text: "I will look." },
            { toolUse: { toolUseId: "call-1", name: "read_file", input: { path: "a.ts" } } },
          ],
        },
        {
          role: "user",
          content: [
            {
              toolResult: { toolUseId: "call-1", content: [{ text: "1: one" }], status: "success" },
            },
          ],
        },
        {
          role: "assistant",
          content: [{ toolUse: { toolUseId: "call-2", name: "read_file", input: {} } }],
        },
        {
          role: "user",
          content: [
            {
              toolResult: { toolUseId: "call-2", content: [{ text: "REFUSED" }], status: "error" },
            },
            { text: "CLOSING" },
          ],
        },
      ],
    });
  });

  it("reads text, requests for tools and usage from a reply", async () => {
    const { provider } = build({
      output: {
        message: {
          content: [
            { reasoningContent: {} },
            { text: "Checking." },
            { toolUse: { toolUseId: "t1", name: "list_files", input: { path: "src" } } },
          ],
        },
      },
      usage: { inputTokens: 9, outputTokens: 4, totalTokens: 13 },
    });

    expect(await provider.converse(conversation())).toMatchObject({
      text: "Checking.",
      toolCalls: [{ id: "t1", name: "list_files", input: { path: "src" } }],
      usage: { inputTokens: 9, outputTokens: 4 },
    });
  });

  it("reports no usage when there is none", async () => {
    const { provider } = build({ output: { message: { content: [{ text: "FINAL" }] } } });

    expect(await provider.converse(conversation())).toEqual({ text: "FINAL", toolCalls: [] });
  });
});

describe("every provider, in a conversation", () => {
  const providers = (send: typeof fetch): AiToolProvider[] => [
    createAnthropicProvider({ model: "m", apiKey: "KEY-CANARY", fetch: send }),
    createChatCompletionsProvider({
      dialect: "openai",
      model: "m",
      apiKey: "KEY-CANARY",
      baseUrl: "https://api.example/v1",
      fetch: send,
    }),
    createBedrockProvider({
      model: "m",
      region: "us-east-1",
      auth: { apiKey: "KEY-CANARY" },
      fetch: send,
    }),
  ];

  it("turns an error status into an error named after it, without the body", async () => {
    const { fetch } = fakeFetch({ error: "BODY-CANARY USER TEXT" }, 400);

    for (const provider of providers(fetch)) {
      const error: unknown = await provider.converse(conversation()).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ProviderHttpError);
      expect((error as Error).name).toBe("ProviderHttp400");
      expect(String(error)).not.toContain("CANARY");
    }
  });

  it("rejects a reply that is not what the API documents", async () => {
    const { fetch } = fakeFetch({ unexpected: true });

    for (const provider of providers(fetch)) {
      await expect(provider.converse(conversation())).rejects.toBeInstanceOf(ProviderResponseError);
    }
  });

  it("is what the operator's settings build", () => {
    const settings = providerSettingsSchema.parse({
      provider: "anthropic",
      model: "m",
      apiKey: "KEY",
    });

    expect(typeof createProvider(settings).converse).toBe("function");
  });
});
