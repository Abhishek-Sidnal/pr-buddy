import { randomBytes } from "node:crypto";
import { createAiReviewer, createScriptedProvider } from "@pr-buddy/ai-reviewer";
import { signWebhookBody, type ReviewTrigger } from "@pr-buddy/github-client";
import type { Express } from "express";
import request, { type Response as TestResponse } from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { migrate } from "../../src/database/migrate.js";
import {
  aiKeyInputSchema,
  createPostgresAiKeyStore,
  type AiKeyStore,
} from "../../src/modules/ai-keys/ai-key-store.js";
import {
  createLocalSecretCipher,
  decodeMasterKey,
  SecretDecryptionError,
} from "../../src/modules/ai-keys/secret-cipher.js";
import { createPostgresSessionStore } from "../../src/modules/auth/postgres-session-store.js";
import type { SessionStore } from "../../src/modules/auth/session-store.js";
import { createInMemoryDeliveryStore } from "../../src/modules/github/delivery-store.js";
import { createPostgresInstallationStore } from "../../src/modules/github/installation-store.js";
import { createPostgresHistoryStore } from "../../src/modules/history/postgres-history-store.js";
import { createReviewQueue } from "../../src/modules/reviews/review-queue.js";
import { createReviewService } from "../../src/modules/reviews/review.service.js";
import { FakeGitHub } from "../helpers/fake-github.js";
import { createRecordingLogger, type RecordingLogger } from "../helpers/recording-logger.js";
import {
  createRecordingReviewStore,
  type RecordingReviewStore,
} from "../helpers/recording-review-store.js";
import { createTestDatabase, type TestDatabase } from "../helpers/test-database.js";

const PUBLIC_URL = "http://localhost:3000";
const WEBHOOK_SECRET = "0123456789abcdef-webhook-secret";
const MASTER_KEY = randomBytes(32);
const API_KEY = "sk-KEY-CANARY-0123456789abcd";

/** OURS is owned by the signed-in person; READABLE is visible to them; THEIRS is neither. */
const OURS = 1001;
const READABLE = 1002;
const THEIRS = 9009;

const VALID = { provider: "anthropic", model: "claude-test-1", apiKey: API_KEY };
const AZURE = {
  provider: "azure",
  model: "review-deployment",
  resource: "acme-ai",
  apiKey: API_KEY,
};

let test: TestDatabase;
let logger: RecordingLogger;
let sessions: SessionStore;
let aiKeyStore: AiKeyStore;
let app: Express;
let cookie: string;
/** What the fake provider answers to the request that checks a key. */
let providerAnswer: () => Response;
let providerRequests: { url: string; headers: Headers; body: string }[];

const providerFetch: typeof fetch = (input, init) => {
  providerRequests.push({
    url: input instanceof Request ? input.url : input.toString(),
    headers: new Headers(init?.headers),
    body: typeof init?.body === "string" ? init.body : "",
  });
  return Promise.resolve(providerAnswer());
};

const okAnswer = (): Response =>
  Response.json({
    content: [{ type: "text", text: "OK" }],
    choices: [{ message: { content: "OK" } }],
    output: { message: { content: [{ text: "OK" }] } },
  });

function buildApp(withKeys = true): Express {
  return createApp({
    webhookSecret: WEBHOOK_SECRET,
    deliveryStore: createInMemoryDeliveryStore(),
    installationStore: createPostgresInstallationStore(test.database),
    reviewQueue: createReviewQueue({ concurrency: 1, maxWaiting: 1, onError: () => undefined }),
    reviewService: createReviewService({ clientFactory: new FakeGitHub().clientFactory, logger }),
    logger,
    trustProxy: 0,
    webhookRateLimit: 1_000,
    dashboard: {
      authClient: { authorizeUrl: () => "", signIn: () => Promise.reject(new Error("unused")) },
      sessionStore: sessions,
      historyStore: createPostgresHistoryStore(test.database),
      publicUrl: PUBLIC_URL,
      webRoot: "/nonexistent",
      authRateLimit: 1_000,
      apiRateLimit: 1_000,
      ...(withKeys ? { aiKeys: { aiKeyStore, fetch: providerFetch } } : {}),
    },
  });
}

async function signInAs(
  userId: number,
  installations: { id: number; isOwner: boolean }[],
): Promise<string> {
  const token = await sessions.create({
    userId,
    login: `user-${userId}`,
    installationIds: installations.map(({ id }) => id),
    installations: installations.map(({ id, isOwner }) => ({
      id,
      account: `account-${id}`,
      isOwner,
    })),
  });
  return `prbuddy_session=${token}`;
}

interface WriteOptions {
  cookie?: string | null;
  origin?: string | null;
  header?: string | null;
}

/** Sends a write the way the dashboard does, unless told to leave something out. */
function write(
  method: "put" | "delete",
  installationId: number | string,
  body?: unknown,
  options: WriteOptions = {},
): Promise<TestResponse> {
  let call = request(app)[method](`/api/installations/${installationId}/ai-key`);
  const sessionCookie = options.cookie === undefined ? cookie : options.cookie;
  if (sessionCookie !== null) {
    call = call.set("Cookie", sessionCookie);
  }
  const origin = options.origin === undefined ? PUBLIC_URL : options.origin;
  if (origin !== null) {
    call = call.set("Origin", origin);
  }
  const header = options.header === undefined ? "1" : options.header;
  if (header !== null) {
    call = call.set("X-PR-Buddy-Request", header);
  }
  return body === undefined ? call : call.send(body as object);
}

const rows = async <Row>(sql: string): Promise<Row[]> => (await test.database.query<Row>(sql)).rows;
const keyCount = async (): Promise<number> =>
  Number((await rows<{ n: string }>("SELECT count(*) AS n FROM installation_ai_keys"))[0]?.n);

beforeAll(async () => {
  test = await createTestDatabase();
  await migrate(test.database);
});

afterAll(async () => {
  await test.destroy();
});

beforeEach(async () => {
  await test.database.query(
    "TRUNCATE sessions, installation_ai_keys, audit_events, repositories CASCADE",
  );
  logger = createRecordingLogger();
  sessions = createPostgresSessionStore(test.database);
  aiKeyStore = createPostgresAiKeyStore(test.database, createLocalSecretCipher(MASTER_KEY));
  providerAnswer = okAnswer;
  providerRequests = [];
  app = buildApp();
  cookie = await signInAs(42, [
    { id: OURS, isOwner: true },
    { id: READABLE, isOwner: false },
  ]);
});

describe("the secret cipher", () => {
  const cipher = createLocalSecretCipher(MASTER_KEY);

  it("returns what it encrypted, for the same context", () => {
    const secret = cipher.encrypt(API_KEY, "installation-ai-key:1001:anthropic");

    expect(cipher.decrypt(secret, "installation-ai-key:1001:anthropic")).toBe(API_KEY);
    expect(secret.nonce).toHaveLength(12);
    expect(secret.ciphertext.toString("latin1")).not.toContain(API_KEY);
    expect(secret.ciphertext.toString("base64")).not.toContain(
      Buffer.from(API_KEY).toString("base64"),
    );
  });

  it("uses a new nonce every time, so equal keys do not look equal", () => {
    const first = cipher.encrypt(API_KEY, "c");
    const second = cipher.encrypt(API_KEY, "c");

    expect(first.nonce.equals(second.nonce)).toBe(false);
    expect(first.ciphertext.equals(second.ciphertext)).toBe(false);
  });

  it.each([
    [
      "another context",
      (s: ReturnType<typeof cipher.encrypt>) => ({
        secret: s,
        context: "installation-ai-key:9009:anthropic",
      }),
    ],
    [
      "a changed ciphertext",
      (s: ReturnType<typeof cipher.encrypt>) => ({
        secret: {
          ...s,
          ciphertext: Buffer.concat([
            Buffer.from([(s.ciphertext[0] ?? 0) ^ 1]),
            s.ciphertext.subarray(1),
          ]),
        },
        context: "c",
      }),
    ],
    [
      "a changed nonce",
      (s: ReturnType<typeof cipher.encrypt>) => ({
        secret: { ...s, nonce: randomBytes(12) },
        context: "c",
      }),
    ],
    [
      "a nonce of the wrong length",
      (s: ReturnType<typeof cipher.encrypt>) => ({
        secret: { ...s, nonce: randomBytes(8) },
        context: "c",
      }),
    ],
    [
      "a truncated ciphertext",
      (s: ReturnType<typeof cipher.encrypt>) => ({
        secret: { ...s, ciphertext: s.ciphertext.subarray(0, 4) },
        context: "c",
      }),
    ],
    [
      "an unknown master key",
      (s: ReturnType<typeof cipher.encrypt>) => ({
        secret: { ...s, keyId: "0000000000000000" },
        context: "c",
      }),
    ],
  ])("refuses to decrypt with %s, and says nothing about why", (_name, tamper) => {
    const { secret, context } = tamper(cipher.encrypt(API_KEY, "c"));

    const attempt = (): string => cipher.decrypt(secret, context);

    expect(attempt).toThrow(SecretDecryptionError);
    expect(attempt).toThrow("The stored secret could not be decrypted.");
  });

  it("cannot be read with another master key", () => {
    const other = createLocalSecretCipher(randomBytes(32));

    expect(() => other.decrypt(cipher.encrypt(API_KEY, "c"), "c")).toThrow(SecretDecryptionError);
  });

  it("still reads secrets written under a previous master key after rotation", () => {
    const old = cipher.encrypt(API_KEY, "c");
    const rotated = createLocalSecretCipher(randomBytes(32), [MASTER_KEY]);

    expect(rotated.decrypt(old, "c")).toBe(API_KEY);
    expect(rotated.encrypt(API_KEY, "c").keyId).not.toBe(old.keyId);
  });

  it.each([
    ["32 bytes in base64", MASTER_KEY.toString("base64"), true],
    ["32 bytes in URL-safe base64", MASTER_KEY.toString("base64url"), true],
    ["16 bytes", randomBytes(16).toString("base64"), false],
    ["64 bytes", randomBytes(64).toString("base64"), false],
    ["text that is not base64", "not a key!", false],
    ["an empty value", "", false],
  ])("accepts a master key only if it is 32 bytes: %s", (_name, encoded, isValid) => {
    expect(decodeMasterKey(encoded) !== undefined).toBe(isValid);
  });
});

describe("what an owner may submit", () => {
  const issuesOf = (input: unknown): string[] => {
    const parsed = aiKeyInputSchema.safeParse(input);
    return parsed.success
      ? []
      : parsed.error.issues.map((issue) => String(issue.path[0] ?? "body"));
  };

  it.each([
    ["Anthropic", VALID],
    ["OpenAI", { provider: "openai", model: "gpt-test", apiKey: API_KEY }],
    [
      "Bedrock with a region",
      { provider: "bedrock", model: "us.vendor.model-v1:0", region: "us-east-1", apiKey: API_KEY },
    ],
    ["Azure with a resource name", AZURE],
    ["an Azure resource name of two characters", { ...AZURE, resource: "a1" }],
    ["an Azure resource name of 64 characters", { ...AZURE, resource: "a".repeat(64) }],
  ])("accepts %s", (_name, input) => {
    expect(issuesOf(input)).toEqual([]);
  });

  it("builds the Azure address from the resource's name, under Microsoft's domain", () => {
    expect(aiKeyInputSchema.parse(AZURE)).toMatchObject({
      provider: "azure",
      model: "review-deployment",
      baseUrl: "https://acme-ai.openai.azure.com/openai/v1",
    });
  });

  it.each([
    "evil.example",
    "acme.evil.example/x",
    "acme-ai.openai.azure.com",
    "evil.example#",
    "evil.example?",
    "user@evil.example",
    "localhost:5432",
    "169.254.169.254",
    "[::1]",
    "acme/../x",
    "acme\\x",
    "acme ai",
    "acme\nai",
    "ACME-AI",
    "-acme",
    "acme-",
    "a",
    "",
    "a".repeat(65),
    "acmé",
    "%61cme",
  ])("refuses the Azure resource name %j", (resource) => {
    expect(issuesOf({ ...AZURE, resource })).toEqual(["resource"]);
  });

  it("drops a resource name that is not for Azure", () => {
    expect(aiKeyInputSchema.parse({ ...VALID, resource: "acme-ai" })).not.toHaveProperty("baseUrl");
  });

  it("never passes on an address, and drops a region that is not for Bedrock", () => {
    const parsed = aiKeyInputSchema.parse({ ...VALID, region: "us-east-1" });

    expect(parsed).not.toHaveProperty("baseUrl");
    expect(parsed).not.toHaveProperty("region");
  });

  it.each<[string, unknown, string[]]>([
    ["Azure without a resource name", { ...VALID, provider: "azure" }, ["resource"]],
    ["a compatible server", { ...VALID, provider: "openai-compatible" }, ["provider"]],
    [
      "an address of the customer's choosing",
      { ...VALID, baseUrl: "http://169.254.169.254/" },
      ["body"],
    ],
    ["Bedrock without a region", { ...VALID, provider: "bedrock" }, ["region"]],
    [
      "a region that is an address",
      { ...VALID, provider: "bedrock", region: "x.evil.example/" },
      ["region"],
    ],
    ["a model with Markdown in it", { ...VALID, model: "[x](https://evil.example)" }, ["model"]],
    ["an empty model", { ...VALID, model: "" }, ["model"]],
    ["a key with a space", { ...VALID, apiKey: "sk-abc def-0123456789" }, ["apiKey"]],
    ["a key with a line break", { ...VALID, apiKey: "sk-abcdef0123456789\n" }, ["apiKey"]],
    ["a key that is too short", { ...VALID, apiKey: "short" }, ["apiKey"]],
    ["no key", { provider: "openai", model: "m" }, ["apiKey"]],
    ["something that is not an object", "anthropic", ["body"]],
  ])("rejects %s", (_name, input, fields) => {
    expect(issuesOf(input)).toEqual(fields);
  });
});

describe("the key store", () => {
  const SETTINGS = aiKeyInputSchema.parse(VALID);

  it("stores a key encrypted, with its last four characters and who saved it", async () => {
    const summary = await aiKeyStore.save(OURS, SETTINGS, 42);

    expect(summary).toMatchObject({
      installationId: OURS,
      provider: "anthropic",
      model: "claude-test-1",
      region: null,
      resource: null,
      keyHint: "abcd",
    });
    const stored = await rows<Record<string, unknown>>(
      "SELECT *, encode(key_ciphertext, 'escape') AS raw FROM installation_ai_keys",
    );
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ key_hint: "abcd", updated_by: "42" });
    expect(JSON.stringify(stored)).not.toContain(API_KEY);
    expect(JSON.stringify(stored)).not.toContain("KEY-CANARY");
  });

  it("gives the key back to the review service only, complete and checked", async () => {
    await aiKeyStore.save(
      OURS,
      aiKeyInputSchema.parse({
        provider: "bedrock",
        model: "m",
        region: "eu-west-1",
        apiKey: API_KEY,
      }),
      42,
    );

    expect(await aiKeyStore.load(OURS)).toMatchObject({
      provider: "bedrock",
      model: "m",
      region: "eu-west-1",
      apiKey: API_KEY,
    });
    expect(await aiKeyStore.load(THEIRS)).toBeUndefined();
  });

  it("stores an Azure key with its resource name, and rebuilds the address when loading", async () => {
    const summary = await aiKeyStore.save(OURS, aiKeyInputSchema.parse(AZURE), 42);

    expect(summary).toMatchObject({ provider: "azure", resource: "acme-ai", region: null });
    expect(await rows("SELECT resource FROM installation_ai_keys")).toEqual([
      { resource: "acme-ai" },
    ]);
    expect(await aiKeyStore.load(OURS)).toMatchObject({
      provider: "azure",
      model: "review-deployment",
      baseUrl: "https://acme-ai.openai.azure.com/openai/v1",
      apiKey: API_KEY,
    });
  });

  it("clears the resource name when an Azure key is replaced by another provider's", async () => {
    await aiKeyStore.save(OURS, aiKeyInputSchema.parse(AZURE), 42);

    const summary = await aiKeyStore.save(OURS, SETTINGS, 42);

    expect(summary).toMatchObject({ provider: "anthropic", resource: null });
    expect(await aiKeyStore.load(OURS)).not.toHaveProperty("baseUrl");
  });

  it("refuses to store Azure settings whose address it did not build", async () => {
    const settings = aiKeyInputSchema.parse(AZURE);

    for (const baseUrl of [
      "https://evil.example/openai/v1",
      "https://acme-ai.openai.azure.com.evil.example/openai/v1",
      "https://acme.evil.openai.azure.com/openai/v1",
      "http://acme-ai.openai.azure.com/openai/v1",
    ]) {
      expect(() => aiKeyStore.save(OURS, { ...settings, baseUrl }, 42)).toThrow(
        "The Azure settings do not name a resource.",
      );
    }
    expect(await keyCount()).toBe(0);
  });

  it.each(["evil.example/x", "ACME", "a.b"])(
    "refuses a row whose resource name was edited to %j",
    async (resource) => {
      await aiKeyStore.save(OURS, aiKeyInputSchema.parse(AZURE), 42);
      await test.database.query("UPDATE installation_ai_keys SET resource = $1", [resource]);

      await expect(aiKeyStore.load(OURS)).rejects.toThrow();
    },
  );

  it("replaces a key, and lists only what it is asked about", async () => {
    await aiKeyStore.save(OURS, SETTINGS, 42);
    await aiKeyStore.save(OURS, { ...SETTINGS, model: "claude-test-2" }, 43);
    await aiKeyStore.save(THEIRS, SETTINGS, 99);

    expect(await keyCount()).toBe(2);
    expect(
      (await aiKeyStore.list([OURS, READABLE])).map(({ installationId, model }) => [
        installationId,
        model,
      ]),
    ).toEqual([[OURS, "claude-test-2"]]);
    expect(await aiKeyStore.list([])).toEqual([]);
  });

  it("removes a key and says whether there was one", async () => {
    await aiKeyStore.save(OURS, SETTINGS, 42);

    expect(await aiKeyStore.remove(OURS, 42)).toBe(true);
    expect(await aiKeyStore.remove(OURS, 42)).toBe(false);
    expect(await aiKeyStore.load(OURS)).toBeUndefined();
  });

  it("records every change, without the key", async () => {
    await aiKeyStore.save(OURS, SETTINGS, 42);
    await aiKeyStore.save(OURS, SETTINGS, 43);
    await aiKeyStore.remove(OURS, 44);
    await aiKeyStore.remove(OURS, 44);

    const events = await rows<Record<string, unknown>>(
      "SELECT installation_id, user_id, action FROM audit_events ORDER BY id",
    );
    expect(events).toEqual([
      { installation_id: String(OURS), user_id: "42", action: "ai-key-saved" },
      { installation_id: String(OURS), user_id: "43", action: "ai-key-saved" },
      { installation_id: String(OURS), user_id: "44", action: "ai-key-removed" },
    ]);
    expect(JSON.stringify(await rows("SELECT * FROM audit_events"))).not.toContain("abcd");
  });

  it("does not decrypt a key whose row was copied to another installation", async () => {
    await aiKeyStore.save(OURS, SETTINGS, 42);
    await test.database.query(
      `INSERT INTO installation_ai_keys
         (installation_id, provider, model, region, key_ciphertext, key_nonce, key_id, key_hint, updated_by)
       SELECT $1, provider, model, region, key_ciphertext, key_nonce, key_id, key_hint, updated_by
       FROM installation_ai_keys WHERE installation_id = $2`,
      [THEIRS, OURS],
    );

    await expect(aiKeyStore.load(THEIRS)).rejects.toBeInstanceOf(SecretDecryptionError);
    expect((await aiKeyStore.load(OURS))?.apiKey).toBe(API_KEY);
  });

  it("does not decrypt a key after the master key was replaced without keeping the old one", async () => {
    await aiKeyStore.save(OURS, SETTINGS, 42);
    const other = createPostgresAiKeyStore(test.database, createLocalSecretCipher(randomBytes(32)));

    await expect(other.load(OURS)).rejects.toBeInstanceOf(SecretDecryptionError);
  });

  it("refuses a row that was edited to carry something the schema would not accept", async () => {
    await aiKeyStore.save(OURS, SETTINGS, 42);
    await test.database.query("UPDATE installation_ai_keys SET model = 'bad model name'");

    await expect(aiKeyStore.load(OURS)).rejects.toThrow();
  });
});

describe("reading installations and their keys", () => {
  it("lists the session's installations, who may manage them, and a summary of each key", async () => {
    await write("put", OURS, VALID);
    await aiKeyStore.save(THEIRS, aiKeyInputSchema.parse(VALID), 99);

    const response = await request(app).get("/api/installations").set("Cookie", cookie);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      installations: [
        {
          id: OURS,
          account: `account-${OURS}`,
          canManage: true,
          aiKey: {
            provider: "anthropic",
            model: "claude-test-1",
            region: null,
            resource: null,
            keyHint: "abcd",
            updatedAt: expect.stringMatching(/^\d{4}-/) as string,
          },
        },
        { id: READABLE, account: `account-${READABLE}`, canManage: false, aiKey: null },
      ],
    });
    expect(JSON.stringify(response.body)).not.toContain(String(THEIRS));
  });

  it("needs a session", async () => {
    expect((await request(app).get("/api/installations")).status).toBe(401);
  });

  it("does not exist when no master key is configured", async () => {
    app = buildApp(false);

    expect((await request(app).get("/api/installations").set("Cookie", cookie)).status).toBe(404);
    expect((await write("put", OURS, VALID)).status).toBe(404);
    expect(await keyCount()).toBe(0);
  });
});

describe("saving a key", () => {
  it("checks it with the provider, stores it, and returns a summary without it", async () => {
    const response = await write("put", OURS, VALID);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      provider: "anthropic",
      model: "claude-test-1",
      region: null,
      resource: null,
      keyHint: "abcd",
      updatedAt: expect.stringMatching(/^\d{4}-/) as string,
    });
    expect(JSON.stringify(response.body)).not.toContain("CANARY");
    expect(providerRequests).toHaveLength(1);
    expect(providerRequests[0]?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(providerRequests[0]?.headers.get("x-api-key")).toBe(API_KEY);
    expect(JSON.parse(providerRequests[0]?.body ?? "{}")).toMatchObject({ max_tokens: 16 });
    expect((await aiKeyStore.load(OURS))?.apiKey).toBe(API_KEY);
  });

  it("sends the check only to the provider's own host, whatever the request says", async () => {
    await write("put", OURS, {
      provider: "bedrock",
      model: "m",
      region: "us-west-2",
      apiKey: API_KEY,
    });
    await write("put", OURS, { provider: "openai", model: "m", apiKey: API_KEY });
    await write("put", OURS, AZURE);

    expect(providerRequests.map(({ url }) => new URL(url).host)).toEqual([
      "bedrock-runtime.us-west-2.amazonaws.com",
      "api.openai.com",
      "acme-ai.openai.azure.com",
    ]);
  });

  it("stores an Azure key, sending it in Azure's own header to the resource's address", async () => {
    const response = await write("put", OURS, AZURE);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      provider: "azure",
      model: "review-deployment",
      resource: "acme-ai",
      region: null,
    });
    expect(providerRequests[0]?.url).toBe(
      "https://acme-ai.openai.azure.com/openai/v1/chat/completions",
    );
    expect(providerRequests[0]?.headers.get("api-key")).toBe(API_KEY);
    expect(providerRequests[0]?.headers.get("authorization")).toBeNull();
  });

  it("does not ask anyone when an Azure resource name is an address", async () => {
    const response = await write("put", OURS, { ...AZURE, resource: "evil.example/x" });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: "invalid_input", fields: ["resource"] });
    expect(providerRequests).toEqual([]);
  });

  it("logs who saved a key for which installation, and never the key", async () => {
    await write("put", OURS, VALID);

    expect(logger.entries).toContainEqual({
      level: "info",
      message: "AI key saved",
      fields: { installationId: OURS, userId: 42, provider: "anthropic" },
    });
    expect(logger.text()).not.toContain("CANARY");
  });

  it.each([401, 403, 404, 429])(
    "does not store a key the provider answers %s to",
    async (status) => {
      providerAnswer = () => Response.json({ error: "BODY-CANARY" }, { status });

      const response = await write("put", OURS, VALID);

      expect(response.status).toBe(422);
      expect(response.body).toEqual({ error: "key_refused", providerStatus: status });
      expect(await keyCount()).toBe(0);
      expect(logger.text()).not.toContain("CANARY");
    },
  );

  it("does not store a key when the provider cannot be reached or answers nonsense", async () => {
    providerAnswer = () => new Response("<html>gateway</html>");

    const response = await write("put", OURS, VALID);

    expect(response.status).toBe(502);
    expect(response.body).toEqual({ error: "provider_unreachable" });
    expect(await keyCount()).toBe(0);
  });

  it("keeps the old key when a replacement is refused", async () => {
    await write("put", OURS, VALID);
    providerAnswer = () => Response.json({}, { status: 401 });

    await write("put", OURS, { ...VALID, apiKey: "sk-another-key-0123456789" });

    expect((await aiKeyStore.load(OURS))?.apiKey).toBe(API_KEY);
  });

  it.each<[string, unknown, string[]]>([
    ["an unknown provider", { ...VALID, provider: "openai-compatible" }, ["provider"]],
    ["an address", { ...VALID, baseUrl: "http://localhost:5432" }, ["body"]],
    ["a bad key and a bad model", { ...VALID, apiKey: "x y", model: "" }, ["model", "apiKey"]],
  ])(
    "answers 400 naming the fields for %s, without asking the provider",
    async (_name, body, fields) => {
      const response = await write("put", OURS, body);

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: "invalid_input", fields });
      expect(JSON.stringify(response.body)).not.toContain("CANARY");
      expect(providerRequests).toEqual([]);
    },
  );

  it("answers 400 for a body that is not JSON", async () => {
    const response = await request(app)
      .put(`/api/installations/${OURS}/ai-key`)
      .set("Cookie", cookie)
      .set("Origin", PUBLIC_URL)
      .set("X-PR-Buddy-Request", "1")
      .set("Content-Type", "application/json")
      .send('{"provider": ');

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: "bad_request" });
  });

  it("answers 413 for a body that is far too large", async () => {
    const response = await write("put", OURS, { ...VALID, model: "m".repeat(50_000) });

    expect(response.status).toBe(413);
    expect(providerRequests).toEqual([]);
  });
});

describe("who may change a key", () => {
  it("refuses a member who is not an owner", async () => {
    const put = await write("put", READABLE, VALID);
    const del = await write("delete", READABLE);

    expect([put.status, del.status]).toEqual([403, 403]);
    expect(put.body).toEqual({ error: "not_owner" });
    expect(providerRequests).toEqual([]);
    expect(await keyCount()).toBe(0);
  });

  it("answers 404 for an installation outside the session, exactly as for one that does not exist", async () => {
    await aiKeyStore.save(THEIRS, aiKeyInputSchema.parse(VALID), 99);

    const theirs = await write("put", THEIRS, VALID);
    const missing = await write("put", 424242, VALID);
    const removed = await write("delete", THEIRS);

    expect([theirs.status, missing.status, removed.status]).toEqual([404, 404, 404]);
    expect(theirs.body).toEqual(missing.body);
    expect((await aiKeyStore.load(THEIRS))?.apiKey).toBe(API_KEY);
    expect(providerRequests).toEqual([]);
  });

  it.each(["abc", "0", "-1", "1001 OR 1=1", "99999999999999999999"])(
    "answers 404 for the installation ID %s",
    async (id) => {
      expect((await write("put", encodeURIComponent(id), VALID)).status).toBe(404);
    },
  );

  it("lets an owner of another installation change only their own", async () => {
    const theirCookie = await signInAs(99, [{ id: THEIRS, isOwner: true }]);

    const own = await write("put", THEIRS, VALID, { cookie: theirCookie });
    const ours = await write("put", OURS, VALID, { cookie: theirCookie });

    expect([own.status, ours.status]).toEqual([200, 404]);
    expect(await aiKeyStore.load(OURS)).toBeUndefined();
  });

  it.each<[string, WriteOptions, number]>([
    ["no session", { cookie: null }, 401],
    ["an Origin of another site", { origin: "https://evil.example" }, 403],
    ["no Origin", { origin: null }, 403],
    ["an Origin that only starts like ours", { origin: `${PUBLIC_URL}.evil.example` }, 403],
    ["no custom header", { header: null }, 403],
    ["a wrong custom header", { header: "true" }, 403],
  ])("refuses a write with %s", async (_name, options, status) => {
    const put = await write("put", OURS, VALID, options);
    const del = await write("delete", OURS, undefined, options);

    expect([put.status, del.status]).toEqual([status, status]);
    expect(await keyCount()).toBe(0);
    expect(providerRequests).toEqual([]);
  });

  it("does not let a GET or a POST change anything", async () => {
    await write("put", OURS, VALID);
    const base = `/api/installations/${OURS}/ai-key`;

    const get = await request(app).get(base).set("Cookie", cookie);
    const post = await request(app)
      .post(base)
      .set("Cookie", cookie)
      .set("Origin", PUBLIC_URL)
      .set("X-PR-Buddy-Request", "1")
      .send(VALID);

    expect([get.status, post.status]).toEqual([404, 404]);
    expect(await keyCount()).toBe(1);
  });
});

describe("testing the stored key", () => {
  const runTest = (
    installationId: number | string = OURS,
    options: WriteOptions = {},
  ): Promise<TestResponse> => {
    let call = request(app).post(`/api/installations/${installationId}/ai-key/test`);
    const sessionCookie = options.cookie === undefined ? cookie : options.cookie;
    if (sessionCookie !== null) {
      call = call.set("Cookie", sessionCookie);
    }
    const origin = options.origin === undefined ? PUBLIC_URL : options.origin;
    if (origin !== null) {
      call = call.set("Origin", origin);
    }
    const header = options.header === undefined ? "1" : options.header;
    return header === null ? call : call.set("X-PR-Buddy-Request", header);
  };

  it("asks the provider once with the stored key, and says that it works", async () => {
    await write("put", OURS, VALID);
    providerRequests = [];

    const response = await runTest();

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ result: "working" });
    expect(providerRequests).toHaveLength(1);
    expect(providerRequests[0]?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(providerRequests[0]?.headers.get("x-api-key")).toBe(API_KEY);
    expect(JSON.parse(providerRequests[0]?.body ?? "{}")).toMatchObject({ max_tokens: 16 });
  });

  it("tests an Azure key at the address built from its resource name", async () => {
    await write("put", OURS, AZURE);
    providerRequests = [];

    expect((await runTest()).body).toEqual({ result: "working" });
    expect(providerRequests[0]?.url).toBe(
      "https://acme-ai.openai.azure.com/openai/v1/chat/completions",
    );
  });

  it.each([401, 403, 404, 429])(
    "reports the status when the provider answers %s, and nothing it said",
    async (status) => {
      await write("put", OURS, VALID);
      providerAnswer = () => Response.json({ error: "BODY-CANARY" }, { status });

      const response = await runTest();

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ result: "refused", providerStatus: status });
      expect(logger.text()).not.toContain("CANARY");
    },
  );

  it("says when the provider cannot be reached or answers nonsense", async () => {
    await write("put", OURS, VALID);
    providerAnswer = () => new Response("<html>gateway</html>");

    expect((await runTest()).body).toEqual({ result: "unreachable" });
  });

  it("says when the installation has no key, without asking anyone", async () => {
    const response = await runTest();

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ result: "missing" });
    expect(providerRequests).toEqual([]);
  });

  it("says when the stored key cannot be read, without asking anyone", async () => {
    await write("put", OURS, VALID);
    providerRequests = [];
    aiKeyStore = createPostgresAiKeyStore(test.database, createLocalSecretCipher(randomBytes(32)));
    app = buildApp();

    expect((await runTest()).body).toEqual({ result: "unreadable" });

    await test.database.query("UPDATE installation_ai_keys SET model = 'bad model name'");
    aiKeyStore = createPostgresAiKeyStore(test.database, createLocalSecretCipher(MASTER_KEY));
    app = buildApp();

    expect((await runTest()).body).toEqual({ result: "unreadable" });
    expect(providerRequests).toEqual([]);
  });

  it("changes nothing: the key, its date and the audit trail stay as they were", async () => {
    await write("put", OURS, VALID);
    const before = await rows("SELECT * FROM installation_ai_keys");
    providerAnswer = () => Response.json({}, { status: 401 });

    await runTest();
    await runTest();

    expect(await rows("SELECT * FROM installation_ai_keys")).toEqual(before);
    expect(await rows("SELECT action FROM audit_events")).toEqual([{ action: "ai-key-saved" }]);
  });

  it("logs who tested which installation and the result, and never the key", async () => {
    await write("put", OURS, VALID);

    const response = await runTest();

    expect(logger.entries.at(-1)).toEqual({
      level: "info",
      message: "AI key tested",
      fields: { installationId: OURS, userId: 42, result: "working" },
    });
    expect(JSON.stringify(response.body)).not.toContain("abcd");
    expect(logger.text()).not.toContain("CANARY");
  });

  it("is for owners only, and hides installations outside the session", async () => {
    await aiKeyStore.save(READABLE, aiKeyInputSchema.parse(VALID), 7);
    await aiKeyStore.save(THEIRS, aiKeyInputSchema.parse(VALID), 99);

    const member = await runTest(READABLE);
    const theirs = await runTest(THEIRS);
    const missing = await runTest(424242);
    const malformed = await runTest("abc");

    expect([member.status, theirs.status, missing.status, malformed.status]).toEqual([
      403, 404, 404, 404,
    ]);
    expect(member.body).toEqual({ error: "not_owner" });
    expect(theirs.body).toEqual(missing.body);
    expect(providerRequests).toEqual([]);
  });

  it.each<[string, WriteOptions, number]>([
    ["no session", { cookie: null }, 401],
    ["an Origin of another site", { origin: "https://evil.example" }, 403],
    ["no Origin", { origin: null }, 403],
    ["no custom header", { header: null }, 403],
  ])(
    "refuses a test with %s, so another site cannot spend the key",
    async (_name, options, status) => {
      await write("put", OURS, VALID);
      providerRequests = [];

      expect((await runTest(OURS, options)).status).toBe(status);
      expect(providerRequests).toEqual([]);
    },
  );

  it("cannot be run with a GET", async () => {
    await write("put", OURS, VALID);
    providerRequests = [];

    const response = await request(app)
      .get(`/api/installations/${OURS}/ai-key/test`)
      .set("Cookie", cookie);

    expect(response.status).toBe(404);
    expect(providerRequests).toEqual([]);
  });

  it("does not exist when no master key is configured", async () => {
    app = buildApp(false);

    expect((await runTest()).status).toBe(404);
  });
});

describe("removing a key", () => {
  it("removes it, answers 204, and logs who did it", async () => {
    await write("put", OURS, VALID);

    const response = await write("delete", OURS);

    expect(response.status).toBe(204);
    expect(await aiKeyStore.load(OURS)).toBeUndefined();
    expect(logger.entries.at(-1)).toMatchObject({
      message: "AI key removed",
      fields: { installationId: OURS, userId: 42 },
    });
  });

  it("answers 204 when there was nothing to remove", async () => {
    expect((await write("delete", OURS)).status).toBe(204);
    expect(await rows("SELECT 1 FROM audit_events")).toEqual([]);
  });

  it("goes with the installation when the app is uninstalled, and stays when a repository leaves", async () => {
    await aiKeyStore.save(OURS, aiKeyInputSchema.parse(VALID), 42);
    await aiKeyStore.save(THEIRS, aiKeyInputSchema.parse(VALID), 99);
    const deliver = (event: string, body: string): Promise<TestResponse> =>
      request(app)
        .post("/webhooks/github")
        .set("content-type", "application/json")
        .set("x-github-event", event)
        .set("x-github-delivery", "00000000-0000-4000-8000-000000000001")
        .set("x-hub-signature-256", signWebhookBody(WEBHOOK_SECRET, body))
        .send(body);

    await deliver(
      "installation_repositories",
      JSON.stringify({
        action: "removed",
        installation: { id: OURS },
        repositories_removed: [{ id: 2002 }],
      }),
    );
    expect(await keyCount()).toBe(2);

    await deliver(
      "installation",
      JSON.stringify({ action: "deleted", installation: { id: OURS } }),
    );

    expect(
      (await aiKeyStore.list([OURS, THEIRS])).map(({ installationId }) => installationId),
    ).toEqual([THEIRS]);
  });
});

describe("which provider a review uses", () => {
  const TRIGGER: ReviewTrigger = {
    action: "opened",
    installationId: OURS,
    repository: { id: 2002, owner: "acme", name: "widgets" },
    pullRequestNumber: 7,
  };
  const SUGGESTION = JSON.stringify({
    findings: [{ message: "A remark.", severity: "low", filePath: "src/service.ts", line: 1 }],
  });

  let github: FakeGitHub;
  let reviewStore: RecordingReviewStore;

  beforeEach(() => {
    github = new FakeGitHub();
    github.setConfiguration({ ai: { enabled: true } });
    github.files = [
      {
        path: "src/service.ts",
        status: "added",
        additions: 1,
        deletions: 0,
        patch: "@@ -0,0 +1,1 @@\n+const a = 1;",
      },
      { path: "src/service.test.ts", status: "added", additions: 1, deletions: 0 },
    ];
    reviewStore = createRecordingReviewStore();
  });

  const operator = (): ReturnType<typeof createScriptedProvider> =>
    createScriptedProvider([SUGGESTION, SUGGESTION], { name: "operator", model: "op-1" });
  const customer = (): ReturnType<typeof createScriptedProvider> =>
    createScriptedProvider([SUGGESTION, SUGGESTION], { name: "customer", model: "cu-1" });

  it("uses the installation's own provider in place of the operator's", async () => {
    const operatorProvider = operator();
    const customerProvider = customer();
    const asked: number[] = [];
    const service = createReviewService({
      clientFactory: github.clientFactory,
      logger,
      reviewStore,
      aiReviewer: createAiReviewer({ provider: operatorProvider }),
      resolveInstallationReviewer: (installationId) => {
        asked.push(installationId);
        return Promise.resolve(createAiReviewer({ provider: customerProvider }));
      },
    });

    await service.review(TRIGGER);

    expect(asked).toEqual([OURS]);
    expect(customerProvider.requests).toHaveLength(1);
    expect(operatorProvider.requests).toEqual([]);
    expect(github.comments[0]?.body).toContain("` customer/cu-1 `");
  });

  it("uses the operator's provider when the installation has none", async () => {
    const operatorProvider = operator();
    const service = createReviewService({
      clientFactory: github.clientFactory,
      logger,
      aiReviewer: createAiReviewer({ provider: operatorProvider }),
      resolveInstallationReviewer: () => Promise.resolve(undefined),
    });

    await service.review(TRIGGER);

    expect(operatorProvider.requests).toHaveLength(1);
  });

  it("works with an installation's provider when the operator has none", async () => {
    const customerProvider = customer();
    const service = createReviewService({
      clientFactory: github.clientFactory,
      logger,
      resolveInstallationReviewer: () =>
        Promise.resolve(createAiReviewer({ provider: customerProvider })),
    });

    const outcome = await service.review(TRIGGER);

    expect(outcome).toMatchObject({ status: "completed", aiFindingCount: 1 });
  });

  it("does not look up a key for a repository that has not opted in", async () => {
    github.setConfiguration({});
    let lookups = 0;
    const service = createReviewService({
      clientFactory: github.clientFactory,
      logger,
      resolveInstallationReviewer: () => {
        lookups += 1;
        return Promise.resolve(undefined);
      },
    });

    await service.review(TRIGGER);

    expect(lookups).toBe(0);
  });

  it("never falls back to the operator when the installation's key cannot be used", async () => {
    const operatorProvider = operator();
    const service = createReviewService({
      clientFactory: github.clientFactory,
      logger,
      reviewStore,
      aiReviewer: createAiReviewer({ provider: operatorProvider }),
      resolveInstallationReviewer: () => Promise.reject(new SecretDecryptionError()),
    });
    github.files = [
      {
        path: "src/service.ts",
        status: "added",
        additions: 1,
        deletions: 0,
        patch: "@@ -0,0 +1,1 @@\n+console.log('x');",
      },
      { path: "src/service.test.ts", status: "added", additions: 1, deletions: 0 },
    ];

    const outcome = await service.review(TRIGGER);

    expect(operatorProvider.requests).toEqual([]);
    expect(outcome).toMatchObject({ status: "completed", findingCount: 1, aiFindingCount: 0 });
    expect(github.comments[0]?.body).toContain("- The AI review could not be completed");
    expect(logger.entries).toContainEqual({
      level: "warn",
      message: "The installation's AI key could not be used",
      fields: { repositoryId: 2002, pullRequestNumber: 7, errorName: "SecretDecryptionError" },
    });
    const recorded = reviewStore.records[0]?.outcome;
    expect(recorded?.status === "completed" ? recorded.aiReview : undefined).toMatchObject({
      provider: "installation-key",
      status: "failed",
      errorName: "InstallationKeyUnusable",
    });
  });

  it("reviews with a key that was stored through the API", async () => {
    await write("put", OURS, VALID);
    const loaded = await aiKeyStore.load(OURS);

    expect(loaded).toMatchObject({
      provider: "anthropic",
      model: "claude-test-1",
      apiKey: API_KEY,
      timeoutMs: 60_000,
    });
  });
});
