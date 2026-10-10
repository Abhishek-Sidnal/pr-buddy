import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createAiReviewer } from "../../src/ai-reviewer.js";
import type { AiProvider, AiRequest } from "../../src/provider.js";
import { createAnthropicProvider } from "../../src/providers/anthropic.js";
import { createBedrockProvider } from "../../src/providers/bedrock.js";
import { ProviderHttpError, ProviderResponseError } from "../../src/providers/http.js";
import { createChatCompletionsProvider } from "../../src/providers/openai.js";
import {
  createProvider,
  providerSettingsSchema,
  type ProviderSettings,
} from "../../src/providers/provider-settings.js";
import { deriveSigningKey, signAwsRequest } from "../../src/providers/sigv4.js";
import { contextWith, reply } from "../helpers/context.js";

/** The example credentials AWS uses throughout its documentation. They open nothing. */
const AWS_EXAMPLE = {
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
};

interface Recorded {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
  readonly rawBody: string;
  readonly signal: AbortSignal | null | undefined;
}

/** A `fetch` that records the request and answers with the given reply. */
function fakeFetch(answer: () => Response): { fetch: typeof fetch; requests: Recorded[] } {
  const requests: Recorded[] = [];
  const fetchStub: typeof fetch = (input, init) => {
    const rawBody = typeof init?.body === "string" ? init.body : "";
    requests.push({
      url: input instanceof Request ? input.url : input.toString(),
      method: init?.method ?? "GET",
      headers: Object.fromEntries(new Headers(init?.headers)),
      body: JSON.parse(rawBody) as unknown,
      rawBody,
      signal: init?.signal,
    });
    return Promise.resolve(answer());
  };
  return { fetch: fetchStub, requests };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function request(overrides: Partial<AiRequest> = {}): AiRequest {
  return {
    system: "SYSTEM TEXT",
    user: '{"pullRequest":{}}',
    maxOutputTokens: 2_000,
    signal: new AbortController().signal,
    ...overrides,
  };
}

async function errorOf(promise: Promise<unknown>): Promise<Error> {
  const error: unknown = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  if (!(error instanceof Error)) {
    throw new Error("Expected a rejection.");
  }
  return error;
}

describe("AWS Signature Version 4", () => {
  it("derives the signing key AWS documents for its example", () => {
    expect(
      deriveSigningKey(AWS_EXAMPLE.secretAccessKey, "20150830", "us-east-1", "iam").toString("hex"),
    ).toBe("c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9");
  });

  it("produces the signature AWS documents for its example request", () => {
    const headers = signAwsRequest({
      method: "GET",
      url: new URL("https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08"),
      headers: { "Content-Type": "application/x-www-form-urlencoded; charset=utf-8" },
      body: "",
      region: "us-east-1",
      service: "iam",
      credentials: AWS_EXAMPLE,
      now: new Date("2015-08-30T12:36:00Z"),
    });

    expect(headers["authorization"]).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, " +
        "SignedHeaders=content-type;host;x-amz-date, " +
        "Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7",
    );
    expect(headers).toMatchObject({
      host: "iam.amazonaws.com",
      "x-amz-date": "20150830T123600Z",
      "content-type": "application/x-www-form-urlencoded; charset=utf-8",
    });
    expect(headers).not.toHaveProperty("x-amz-security-token");
  });

  it("signs the path encoded twice, as every service but S3 requires", () => {
    const body = '{"a":1}';
    const headers = signAwsRequest({
      method: "POST",
      url: new URL(
        "https://bedrock-runtime.us-east-1.amazonaws.com/model/vendor.model-v1%3A0/converse",
      ),
      headers: { "content-type": "application/json" },
      body,
      region: "us-east-1",
      service: "bedrock",
      credentials: AWS_EXAMPLE,
      now: new Date("2026-10-10T08:00:00Z"),
    });

    // The same signature, worked out here from the specification with the path written out.
    const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
    const canonicalRequest = [
      "POST",
      "/model/vendor.model-v1%253A0/converse",
      "",
      "content-type:application/json",
      "host:bedrock-runtime.us-east-1.amazonaws.com",
      "x-amz-date:20261010T080000Z",
      "",
      "content-type;host;x-amz-date",
      sha256(body),
    ].join("\n");
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      "20261010T080000Z",
      "20261010/us-east-1/bedrock/aws4_request",
      sha256(canonicalRequest),
    ].join("\n");
    const expected = createHmac(
      "sha256",
      deriveSigningKey(AWS_EXAMPLE.secretAccessKey, "20261010", "us-east-1", "bedrock"),
    )
      .update(stringToSign)
      .digest("hex");

    expect(headers["authorization"]).toContain(`Signature=${expected}`);
  });

  it("signs and sends the session token of temporary credentials", () => {
    const sign = (sessionToken?: string): Record<string, string> =>
      signAwsRequest({
        method: "POST",
        url: new URL("https://bedrock-runtime.eu-west-1.amazonaws.com/model/m/converse"),
        headers: {},
        body: "{}",
        region: "eu-west-1",
        service: "bedrock",
        credentials: { ...AWS_EXAMPLE, ...(sessionToken === undefined ? {} : { sessionToken }) },
        now: new Date("2026-10-10T08:00:00Z"),
      });

    const withToken = sign("SESSION-TOKEN");

    expect(withToken["x-amz-security-token"]).toBe("SESSION-TOKEN");
    expect(withToken["authorization"]).toContain(
      "SignedHeaders=host;x-amz-date;x-amz-security-token",
    );
    expect(withToken["authorization"]).not.toBe(sign()["authorization"]);
  });

  it("orders query parameters and encodes reserved characters", () => {
    const sign = (query: string): string | undefined =>
      signAwsRequest({
        method: "GET",
        url: new URL(`https://example.amazonaws.com/${query}`),
        headers: {},
        body: "",
        region: "us-east-1",
        service: "example",
        credentials: AWS_EXAMPLE,
        now: new Date("2026-10-10T08:00:00Z"),
      })["authorization"];

    expect(sign("?b=2&a=1")).toBe(sign("?a=1&b=2"));
    expect(sign("?a=2&a=1")).toBe(sign("?a=1&a=2"));
    expect(sign("?a=(x)")).toBe(sign("?a=%28x%29"));
    expect(sign("?a=1")).not.toBe(sign("?a=2"));
  });

  it("changes with the body, the time and the secret, and never contains the secret", () => {
    const sign = (
      overrides: Partial<Parameters<typeof signAwsRequest>[0]> = {},
    ): string | undefined =>
      signAwsRequest({
        method: "POST",
        url: new URL("https://bedrock-runtime.us-east-1.amazonaws.com/model/m/converse"),
        headers: {},
        body: "{}",
        region: "us-east-1",
        service: "bedrock",
        credentials: AWS_EXAMPLE,
        now: new Date("2026-10-10T08:00:00Z"),
        ...overrides,
      })["authorization"];

    const baseline = sign();
    expect(sign()).toBe(baseline);
    expect(sign({ body: "{ }" })).not.toBe(baseline);
    expect(sign({ now: new Date("2026-10-10T08:00:01Z") })).not.toBe(baseline);
    expect(sign({ credentials: { ...AWS_EXAMPLE, secretAccessKey: "another" } })).not.toBe(
      baseline,
    );
    expect(baseline).not.toContain(AWS_EXAMPLE.secretAccessKey);
  });
});

describe("the Bedrock provider", () => {
  const CONVERSE_REPLY = {
    output: {
      message: {
        role: "assistant",
        content: [
          { reasoningContent: { text: "thinking" } },
          { text: '{"findings"' },
          { text: ":[]}" },
        ],
      },
    },
    stopReason: "end_turn",
    usage: { inputTokens: 321, outputTokens: 12, totalTokens: 333 },
  };

  it("calls the Converse API of the region with a Bedrock API key", async () => {
    const { fetch, requests } = fakeFetch(() => json(CONVERSE_REPLY));
    const provider = createBedrockProvider({
      model: "us.anthropic.claude-sonnet-4-20250514-v1:0",
      region: "us-west-2",
      auth: { apiKey: "BEDROCK-KEY" },
      fetch,
    });
    const signal = new AbortController().signal;

    const response = await provider.complete(request({ signal }));

    expect(provider).toMatchObject({
      name: "bedrock",
      model: "us.anthropic.claude-sonnet-4-20250514-v1:0",
    });
    expect(response).toEqual({
      text: '{"findings":[]}',
      usage: { inputTokens: 321, outputTokens: 12 },
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      url: "https://bedrock-runtime.us-west-2.amazonaws.com/model/us.anthropic.claude-sonnet-4-20250514-v1%3A0/converse",
      method: "POST",
      body: {
        system: [{ text: "SYSTEM TEXT" }],
        messages: [{ role: "user", content: [{ text: '{"pullRequest":{}}' }] }],
        inferenceConfig: { maxTokens: 2_000 },
      },
    });
    expect(requests[0]?.headers).toMatchObject({
      authorization: "Bearer BEDROCK-KEY",
      "content-type": "application/json",
    });
    expect(requests[0]?.signal).toBe(signal);
  });

  it("signs the request when given an access key", async () => {
    const { fetch, requests } = fakeFetch(() => json(CONVERSE_REPLY));
    const provider = createBedrockProvider({
      model: "amazon.nova-pro-v1:0",
      region: "us-east-1",
      auth: { credentials: { ...AWS_EXAMPLE, sessionToken: "SESSION" } },
      fetch,
      now: () => new Date("2026-10-10T08:00:00Z"),
    });

    await provider.complete(request());

    const headers: Record<string, string> = requests[0]?.headers ?? {};
    const rawBody = requests[0]?.rawBody ?? "";
    expect(headers["authorization"]).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20261010\/us-east-1\/bedrock\/aws4_request, SignedHeaders=accept;content-type;host;x-amz-date;x-amz-security-token, Signature=[0-9a-f]{64}$/,
    );
    expect(headers["x-amz-date"]).toBe("20261010T080000Z");
    expect(headers["x-amz-security-token"]).toBe("SESSION");
    // fetch sets Host itself; a second, hand-written one must not be sent.
    expect(headers).not.toHaveProperty("host");
    // What was signed is exactly what is sent.
    const again = signAwsRequest({
      method: "POST",
      url: new URL(requests[0]?.url ?? ""),
      headers: { "content-type": "application/json", accept: "application/json" },
      body: rawBody,
      region: "us-east-1",
      service: "bedrock",
      credentials: { ...AWS_EXAMPLE, sessionToken: "SESSION" },
      now: new Date("2026-10-10T08:00:00Z"),
    });
    expect(headers["authorization"]).toBe(again["authorization"]);
    expect(JSON.stringify(requests)).not.toContain(AWS_EXAMPLE.secretAccessKey);
  });

  it("keeps an inference-profile ARN as one path segment", async () => {
    const { fetch, requests } = fakeFetch(() => json(CONVERSE_REPLY));
    const arn = "arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.vendor.model-v1:0";

    await createBedrockProvider({
      model: arn,
      region: "us-east-1",
      auth: { apiKey: "k" },
      fetch,
    }).complete(request());

    expect(requests[0]?.url).toBe(
      `https://bedrock-runtime.us-east-1.amazonaws.com/model/${encodeURIComponent(arn)}/converse`,
    );
  });

  it("returns no usage when the service reports none", async () => {
    const { fetch } = fakeFetch(() => json({ output: { message: { content: [{ text: "{}" }] } } }));

    const response = await createBedrockProvider({
      model: "m",
      region: "us-east-1",
      auth: { apiKey: "k" },
      fetch,
    }).complete(request());

    expect(response).toEqual({ text: "{}" });
  });
});

describe("the Anthropic provider", () => {
  const MESSAGES_REPLY = {
    id: "msg_1",
    content: [
      { type: "thinking", thinking: "hmm" },
      { type: "text", text: '{"findings":[]}' },
      { type: "text" },
    ],
    usage: { input_tokens: 400, output_tokens: 9 },
  };

  it("calls the Messages API with the key and the version", async () => {
    const { fetch, requests } = fakeFetch(() => json(MESSAGES_REPLY));
    const provider = createAnthropicProvider({ model: "claude-x", apiKey: "ANTHROPIC-KEY", fetch });

    const response = await provider.complete(request());

    expect(provider).toMatchObject({ name: "anthropic", model: "claude-x" });
    expect(response).toEqual({
      text: '{"findings":[]}',
      usage: { inputTokens: 400, outputTokens: 9 },
    });
    expect(requests[0]).toMatchObject({
      url: "https://api.anthropic.com/v1/messages",
      method: "POST",
      body: {
        model: "claude-x",
        max_tokens: 2_000,
        system: "SYSTEM TEXT",
        messages: [{ role: "user", content: '{"pullRequest":{}}' }],
      },
    });
    expect(requests[0]?.headers).toMatchObject({
      "x-api-key": "ANTHROPIC-KEY",
      "anthropic-version": "2023-06-01",
    });
    expect(requests[0]?.headers).not.toHaveProperty("authorization");
  });

  it("uses another base URL when given one, and reports no usage when there is none", async () => {
    const { fetch, requests } = fakeFetch(() => json({ content: [{ type: "text", text: "{}" }] }));

    const response = await createAnthropicProvider({
      model: "claude-x",
      apiKey: "k",
      baseUrl: "https://gateway.example/anthropic",
      fetch,
    }).complete(request());

    expect(requests[0]?.url).toBe("https://gateway.example/anthropic/v1/messages");
    expect(response).toEqual({ text: "{}" });
  });
});

describe("the Chat Completions providers", () => {
  const COMPLETION = {
    choices: [{ index: 0, message: { role: "assistant", content: '{"findings":[]}' } }],
    usage: { prompt_tokens: 500, completion_tokens: 7, total_tokens: 507 },
  };

  it("calls OpenAI with a bearer key, JSON mode and the newer token limit", async () => {
    const { fetch, requests } = fakeFetch(() => json(COMPLETION));
    const provider = createChatCompletionsProvider({
      dialect: "openai",
      model: "gpt-x",
      apiKey: "OPENAI-KEY",
      baseUrl: "https://api.openai.com/v1",
      fetch,
    });

    const response = await provider.complete(request());

    expect(provider).toMatchObject({ name: "openai", model: "gpt-x" });
    expect(response).toEqual({
      text: '{"findings":[]}',
      usage: { inputTokens: 500, outputTokens: 7 },
    });
    expect(requests[0]?.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(requests[0]?.body).toEqual({
      model: "gpt-x",
      messages: [
        { role: "system", content: "SYSTEM TEXT" },
        { role: "user", content: '{"pullRequest":{}}' },
      ],
      max_completion_tokens: 2_000,
      response_format: { type: "json_object" },
    });
    expect(requests[0]?.headers["authorization"]).toBe("Bearer OPENAI-KEY");
  });

  it("calls Azure with the key in an api-key header and the deployment as the model", async () => {
    const { fetch, requests } = fakeFetch(() => json(COMPLETION));
    const provider = createChatCompletionsProvider({
      dialect: "azure",
      model: "my-deployment",
      apiKey: "AZURE-KEY",
      baseUrl: "https://my-resource.openai.azure.com/openai/v1",
      fetch,
    });

    await provider.complete(request());

    expect(provider.name).toBe("azure");
    expect(requests[0]?.url).toBe(
      "https://my-resource.openai.azure.com/openai/v1/chat/completions",
    );
    expect(requests[0]?.headers["api-key"]).toBe("AZURE-KEY");
    expect(requests[0]?.headers).not.toHaveProperty("authorization");
    expect(requests[0]?.body).toMatchObject({
      model: "my-deployment",
      max_completion_tokens: 2_000,
    });
  });

  it("calls a compatible server with the older token limit, no JSON mode and no key", async () => {
    const { fetch, requests } = fakeFetch(() => json(COMPLETION));
    const provider = createChatCompletionsProvider({
      dialect: "openai-compatible",
      model: "llama-x",
      baseUrl: "http://localhost:11434/v1",
      fetch,
    });

    await provider.complete(request());

    expect(provider.name).toBe("openai-compatible");
    expect(requests[0]?.url).toBe("http://localhost:11434/v1/chat/completions");
    expect(requests[0]?.body).toMatchObject({ max_tokens: 2_000 });
    expect(requests[0]?.body).not.toHaveProperty("max_completion_tokens");
    expect(requests[0]?.body).not.toHaveProperty("response_format");
    expect(requests[0]?.headers).not.toHaveProperty("authorization");
    expect(requests[0]?.headers).not.toHaveProperty("api-key");
  });

  it("sends a key to a compatible server that needs one", async () => {
    const { fetch, requests } = fakeFetch(() => json(COMPLETION));

    await createChatCompletionsProvider({
      dialect: "openai-compatible",
      model: "m",
      apiKey: "KEY",
      baseUrl: "https://llm.example/v1",
      fetch,
    }).complete(request());

    expect(requests[0]?.headers["authorization"]).toBe("Bearer KEY");
  });

  it.each([
    ["empty content", { choices: [{ message: { content: null } }], usage: null }],
    ["no content field", { choices: [{ message: {} }] }],
  ])("returns empty text for %s, without usage", async (_name, body) => {
    const { fetch } = fakeFetch(() => json(body));

    const response = await createChatCompletionsProvider({
      dialect: "openai",
      model: "m",
      apiKey: "k",
      baseUrl: "https://api.openai.com/v1",
      fetch,
    }).complete(request());

    expect(response).toEqual({ text: "" });
  });
});

/** One of each provider, so shared behaviour is tested on all of them. */
const PROVIDERS: [string, (fetch: typeof globalThis.fetch) => AiProvider][] = [
  [
    "bedrock",
    (fetch) =>
      createBedrockProvider({
        model: "m",
        region: "us-east-1",
        auth: { apiKey: "KEY-CANARY" },
        fetch,
      }),
  ],
  ["anthropic", (fetch) => createAnthropicProvider({ model: "m", apiKey: "KEY-CANARY", fetch })],
  [
    "openai",
    (fetch) =>
      createChatCompletionsProvider({
        dialect: "openai",
        model: "m",
        apiKey: "KEY-CANARY",
        baseUrl: "https://api.openai.com/v1",
        fetch,
      }),
  ],
];

describe.each(PROVIDERS)("every provider: %s", (_name, build) => {
  it.each([400, 401, 403, 404, 429, 500, 529])(
    "turns HTTP %s into an error named after the status, without the reply's body",
    async (status) => {
      const { fetch } = fakeFetch(() =>
        json({ error: { message: "BODY-CANARY: your prompt was SYSTEM TEXT" } }, status),
      );

      const error = await errorOf(build(fetch).complete(request()));

      expect(error).toBeInstanceOf(ProviderHttpError);
      expect(error.name).toBe(`ProviderHttp${status}`);
      expect(error.message).toBe(`The AI provider answered with HTTP ${status}.`);
      expect(`${error.message} ${error.stack ?? ""} ${JSON.stringify(error)}`).not.toMatch(
        /CANARY|SYSTEM TEXT/,
      );
    },
  );

  it.each([
    ["a reply that is not JSON", () => new Response("<html>gateway error</html>")],
    ["JSON of another shape", () => json({ result: "ok" })],
    ["JSON null", () => json(null)],
  ])("rejects %s", async (_case, answer) => {
    const { fetch } = fakeFetch(answer);

    const error = await errorOf(build(fetch).complete(request()));

    expect(error).toBeInstanceOf(ProviderResponseError);
    expect(error.name).toBe("ProviderResponseError");
  });

  it("lets a network failure through for the reviewer to record", async () => {
    const failing: typeof fetch = () => Promise.reject(new TypeError("fetch failed"));

    expect((await errorOf(build(failing).complete(request()))).name).toBe("TypeError");
  });

  it("works end to end through the reviewer, which records a failure by status", async () => {
    const { fetch } = fakeFetch(() => json({ error: "slow down" }, 429));
    const reviewer = createAiReviewer({ provider: build(fetch) });

    expect(await reviewer.review(contextWith())).toMatchObject({
      status: "failed",
      failureReason: "provider-error",
      errorName: "ProviderHttp429",
    });
  });
});

describe("provider settings", () => {
  const parse = (settings: Record<string, unknown>): ProviderSettings =>
    providerSettingsSchema.parse(settings);
  const issuesOf = (settings: Record<string, unknown>): string[] => {
    const parsed = providerSettingsSchema.safeParse(settings);
    return parsed.success
      ? []
      : parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
  };

  it.each([
    [
      "bedrock with an API key",
      { provider: "bedrock", model: "m", region: "us-east-1", apiKey: "k" },
    ],
    [
      "bedrock with an access key",
      {
        provider: "bedrock",
        model: "amazon.nova-pro-v1:0",
        region: "ap-southeast-2",
        accessKeyId: "AKIAIOSFODNN7EXAMPLE",
        secretAccessKey: "s",
      },
    ],
    [
      "bedrock in a GovCloud region",
      { provider: "bedrock", model: "m", region: "us-gov-west-1", apiKey: "k" },
    ],
    ["anthropic", { provider: "anthropic", model: "claude-x", apiKey: "k" }],
    ["openai", { provider: "openai", model: "gpt-x", apiKey: "k" }],
    [
      "azure",
      {
        provider: "azure",
        model: "dep",
        apiKey: "k",
        baseUrl: "https://r.openai.azure.com/openai/v1",
      },
    ],
    [
      "a local compatible server",
      { provider: "openai-compatible", model: "m", baseUrl: "http://localhost:11434/v1" },
    ],
    [
      "a compatible server on 127.0.0.1",
      { provider: "openai-compatible", model: "m", baseUrl: "http://127.0.0.1:8080/v1" },
    ],
  ])("accepts %s", (_name, settings) => {
    expect(parse(settings)).toMatchObject({ ...settings, timeoutMs: 60_000 });
  });

  it.each<[string, Record<string, unknown>, string[]]>([
    [
      "no model",
      { provider: "openai", apiKey: "k" },
      ["model: Invalid input: expected string, received undefined"],
    ],
    [
      "anthropic without a key",
      { provider: "anthropic", model: "m" },
      ["apiKey: is required for anthropic"],
    ],
    [
      "openai without a key",
      { provider: "openai", model: "m" },
      ["apiKey: is required for openai"],
    ],
    [
      "azure without a key or an address",
      { provider: "azure", model: "m" },
      ["apiKey: is required for azure", "baseUrl: is required for azure"],
    ],
    [
      "a compatible server without an address",
      { provider: "openai-compatible", model: "m" },
      ["baseUrl: is required for openai-compatible"],
    ],
    [
      "bedrock without a region or credentials",
      { provider: "bedrock", model: "m" },
      [
        "region: is required for bedrock",
        "apiKey: bedrock needs a Bedrock API key, or an access key ID with its secret",
      ],
    ],
    [
      "bedrock with an access key ID but no secret",
      { provider: "bedrock", model: "m", region: "us-east-1", accessKeyId: "AKIAIOSFODNN7EXAMPLE" },
      ["apiKey: bedrock needs a Bedrock API key, or an access key ID with its secret"],
    ],
    [
      "a region that is not one",
      { provider: "bedrock", model: "m", region: "evil.example/x", apiKey: "k" },
      ["region: must be an AWS region such as us-east-1"],
    ],
    [
      "an access key ID that is not one",
      {
        provider: "bedrock",
        model: "m",
        region: "us-east-1",
        accessKeyId: "not a key",
        secretAccessKey: "s",
      },
      ["accessKeyId: must be an AWS access key ID"],
    ],
    [
      "a model with characters that mean something in Markdown",
      { provider: "openai", model: "[x](https://evil.example)", apiKey: "k" },
      ["model: must be letters, digits and . _ : / - only"],
    ],
  ])("rejects %s", (_name, settings, issues) => {
    expect(issuesOf(settings)).toEqual(issues);
  });

  it.each([
    ["plain HTTP to another host", "http://llm.example/v1"],
    ["a host that only starts with localhost", "http://localhost.evil.example/v1"],
    ["credentials in the address", "https://user:pw@llm.example/v1"],
    ["a query", "https://llm.example/v1?key=1"],
    ["a fragment", "https://llm.example/v1#x"],
    ["another scheme", "file:///etc/passwd"],
    ["text that is not an address", "llm"],
  ])("rejects a base URL with %s", (_name, baseUrl) => {
    expect(issuesOf({ provider: "openai-compatible", model: "m", baseUrl })).toEqual([
      "baseUrl: must be an https:// URL, or http:// on this machine",
    ]);
  });

  it("rejects an unknown provider and an unknown setting without repeating a value", () => {
    const issues = issuesOf({ provider: "CANARY-provider", model: "m", apiKey: "k" });
    const unknown = issuesOf({ provider: "openai", model: "m", apiKey: "k", extra: "CANARY" });

    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("provider: ");
    expect(unknown).toHaveLength(1);
    expect([...issues, ...unknown].join()).not.toContain("CANARY-provider");
  });

  it("removes a trailing slash from the base URL and accepts a time limit", () => {
    const settings = parse({
      provider: "openai-compatible",
      model: "m",
      baseUrl: "https://llm.example/v1//",
      timeoutMs: 15_000,
    });

    expect(settings).toMatchObject({ baseUrl: "https://llm.example/v1", timeoutMs: 15_000 });
  });

  it.each([0, 300_001, 1.5, Number.NaN])("rejects a time limit of %s", (timeoutMs) => {
    expect(issuesOf({ provider: "openai", model: "m", apiKey: "k", timeoutMs })).toHaveLength(1);
  });
});

describe("createProvider", () => {
  const COMPLETION = { choices: [{ message: { content: reply() } }] };
  const CONVERSE = { output: { message: { content: [{ text: reply() }] } } };
  const MESSAGES = { content: [{ type: "text", text: reply() }] };

  it.each<[Record<string, unknown>, unknown, string, Record<string, string>]>([
    [
      { provider: "bedrock", model: "m", region: "eu-central-1", apiKey: "K" },
      CONVERSE,
      "https://bedrock-runtime.eu-central-1.amazonaws.com/model/m/converse",
      { authorization: "Bearer K" },
    ],
    [
      { provider: "anthropic", model: "m", apiKey: "K" },
      MESSAGES,
      "https://api.anthropic.com/v1/messages",
      { "x-api-key": "K" },
    ],
    [
      { provider: "anthropic", model: "m", apiKey: "K", baseUrl: "https://proxy.example/" },
      MESSAGES,
      "https://proxy.example/v1/messages",
      { "x-api-key": "K" },
    ],
    [
      { provider: "openai", model: "m", apiKey: "K" },
      COMPLETION,
      "https://api.openai.com/v1/chat/completions",
      { authorization: "Bearer K" },
    ],
    [
      {
        provider: "azure",
        model: "dep",
        apiKey: "K",
        baseUrl: "https://r.services.ai.azure.com/openai/v1",
      },
      COMPLETION,
      "https://r.services.ai.azure.com/openai/v1/chat/completions",
      { "api-key": "K" },
    ],
    [
      { provider: "openai-compatible", model: "m", baseUrl: "http://localhost:11434/v1" },
      COMPLETION,
      "http://localhost:11434/v1/chat/completions",
      {},
    ],
  ])("builds a working provider from %o", async (settings, answer, url, headers) => {
    const { fetch, requests } = fakeFetch(() => json(answer));
    const provider = createProvider(providerSettingsSchema.parse(settings), { fetch });

    const review = await createAiReviewer({ provider }).review(contextWith());

    expect(review.status).toBe("completed");
    expect(provider.name).toBe(settings["provider"]);
    expect(requests[0]?.url).toBe(url);
    expect(requests[0]?.headers).toMatchObject(headers);
  });

  it("builds a signing Bedrock provider from an access key, with or without a session token", async () => {
    const run = async (extra: Record<string, unknown>): Promise<Record<string, string>> => {
      const { fetch, requests } = fakeFetch(() => json(CONVERSE));
      const provider = createProvider(
        providerSettingsSchema.parse({
          provider: "bedrock",
          model: "m",
          region: "us-east-1",
          accessKeyId: "AKIAIOSFODNN7EXAMPLE",
          secretAccessKey: "SECRET-CANARY",
          ...extra,
        }),
        { fetch },
      );
      await provider.complete(request());
      expect(JSON.stringify(requests)).not.toContain("SECRET-CANARY");
      return requests[0]?.headers ?? {};
    };

    const plain = await run({});
    const temporary = await run({ sessionToken: "TOKEN" });

    expect(plain["authorization"]).toContain("Credential=AKIAIOSFODNN7EXAMPLE/");
    expect(plain).not.toHaveProperty("x-amz-security-token");
    expect(temporary["x-amz-security-token"]).toBe("TOKEN");
  });

  it("uses the real fetch when none is given", () => {
    const provider = createProvider(
      providerSettingsSchema.parse({ provider: "openai", model: "m", apiKey: "k" }),
    );

    expect(provider).toMatchObject({ name: "openai", model: "m" });
  });
});
