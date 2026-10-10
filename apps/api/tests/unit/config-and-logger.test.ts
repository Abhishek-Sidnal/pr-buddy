import { describe, expect, it } from "vitest";
import { EnvironmentError, findConfigurationWarnings, loadConfig } from "../../src/config/env.js";
import { createLogger, describeError } from "../../src/logger.js";

const PRIVATE_KEY = [
  "-----BEGIN RSA PRIVATE KEY-----",
  "bm90LWEtcmVhbC1rZXktanVzdC1hLXBsYWNlaG9sZGVyLWZvci10ZXN0cw==",
  "-----END RSA PRIVATE KEY-----",
].join("\n");
const WEBHOOK_SECRET = "0123456789abcdef-webhook-secret";

function environment(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    GITHUB_APP_ID: "12345",
    GITHUB_PRIVATE_KEY: PRIVATE_KEY,
    GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET,
    ...overrides,
  };
}

function issuesOf(overrides: Record<string, string | undefined>): readonly string[] {
  try {
    loadConfig(environment(overrides));
  } catch (error) {
    if (error instanceof EnvironmentError) {
      return error.issues;
    }
    throw error;
  }
  throw new Error("Expected the environment to be rejected.");
}

describe("loadConfig", () => {
  it("reads the required settings and applies defaults", () => {
    expect(loadConfig(environment())).toEqual({
      github: { appId: 12_345, privateKey: PRIVATE_KEY, webhookSecret: WEBHOOK_SECRET },
      port: 3_000,
      logLevel: "info",
      trustProxy: 0,
      reviewConcurrency: 2,
      reviewQueueLimit: 100,
      webhookRateLimit: 300,
      reviewRetentionDays: 365,
    });
  });

  it("reads optional settings", () => {
    const config = loadConfig(
      environment({
        PORT: "8080",
        LOG_LEVEL: "debug",
        TRUST_PROXY: "1",
        REVIEW_CONCURRENCY: "4",
        REVIEW_QUEUE_LIMIT: "50",
        WEBHOOK_RATE_LIMIT: "60",
      }),
    );

    expect(config).toMatchObject({
      port: 8_080,
      logLevel: "debug",
      trustProxy: 1,
      reviewConcurrency: 4,
      reviewQueueLimit: 50,
      webhookRateLimit: 60,
    });
  });

  it("accepts a private key whose line breaks are written as backslash-n", () => {
    const config = loadConfig(
      environment({ GITHUB_PRIVATE_KEY: PRIVATE_KEY.replaceAll("\n", "\\n") }),
    );

    expect(config.github.privateKey).toBe(PRIVATE_KEY);
  });

  it("accepts a PKCS#8 private key and surrounding whitespace", () => {
    const pkcs8 = `\n${PRIVATE_KEY.replaceAll("RSA PRIVATE KEY", "PRIVATE KEY")}\n`;

    expect(loadConfig(environment({ GITHUB_PRIVATE_KEY: pkcs8 })).github.privateKey).toBe(
      pkcs8.trim(),
    );
  });

  it("runs without a database when none is configured", () => {
    expect(loadConfig(environment())).not.toHaveProperty("database");
  });

  it.each([
    "postgres://user:pw@db.internal:5432/prbuddy",
    "postgresql://user:pw@localhost/prbuddy?sslmode=require",
  ])("reads the database settings from %s", (url) => {
    expect(loadConfig(environment({ DATABASE_URL: url })).database).toEqual({ url, poolSize: 5 });
  });

  it("reads the database pool size", () => {
    const config = loadConfig(
      environment({ DATABASE_URL: "postgres://u:p@h/d", DATABASE_POOL_SIZE: "20" }),
    );

    expect(config.database?.poolSize).toBe(20);
  });

  it.each([
    ["another database", "mysql://user:pw@host/db"],
    ["a web address", "https://example.com/db"],
    ["text that is not a URL", "localhost prbuddy"],
    ["a URL without a host", "postgres:///prbuddy"],
    ["an empty value", ""],
  ])("rejects a database URL that is %s", (_name, url) => {
    expect(issuesOf({ DATABASE_URL: url })).toEqual([
      "DATABASE_URL: must be a postgres:// or postgresql:// URL",
    ]);
  });

  it("never includes the database password in an error", () => {
    const issues = issuesOf({ DATABASE_URL: "mysql://admin:PASSWORD-CANARY@host/db" });

    expect(issues.join()).not.toContain("PASSWORD-CANARY");
  });

  it("reads how long reviews are kept, and accepts zero for keeping them all", () => {
    expect(loadConfig(environment({ REVIEW_RETENTION_DAYS: "90" })).reviewRetentionDays).toBe(90);
    expect(loadConfig(environment({ REVIEW_RETENTION_DAYS: "0" })).reviewRetentionDays).toBe(0);
  });

  it.each(["-1", "3651", "1.5", "forever"])("rejects a retention of %s days", (value) => {
    expect(issuesOf({ REVIEW_RETENTION_DAYS: value })).toHaveLength(1);
  });

  it("rejects a pool size of zero", () => {
    expect(issuesOf({ DATABASE_POOL_SIZE: "0" })[0]).toMatch(/^DATABASE_POOL_SIZE: /);
  });

  it("ignores unrelated environment variables", () => {
    expect(() => loadConfig(environment({ PATH: "/usr/bin", HOME: "/home/node" }))).not.toThrow();
  });

  it("names every missing required variable", () => {
    const issues = issuesOf({
      GITHUB_APP_ID: undefined,
      GITHUB_PRIVATE_KEY: undefined,
      GITHUB_WEBHOOK_SECRET: undefined,
    });

    expect(issues.map((issue) => issue.split(":")[0])).toEqual([
      "GITHUB_APP_ID",
      "GITHUB_PRIVATE_KEY",
      "GITHUB_WEBHOOK_SECRET",
    ]);
  });

  it.each([
    ["an app ID that is not a number", { GITHUB_APP_ID: "abc" }, "GITHUB_APP_ID"],
    ["an app ID of zero", { GITHUB_APP_ID: "0" }, "GITHUB_APP_ID"],
    [
      "a private key that is not PEM",
      { GITHUB_PRIVATE_KEY: "just-some-text" },
      "GITHUB_PRIVATE_KEY",
    ],
    [
      "a public key",
      { GITHUB_PRIVATE_KEY: PRIVATE_KEY.replaceAll("RSA PRIVATE", "PUBLIC") },
      "GITHUB_PRIVATE_KEY",
    ],
    [
      "a private key with no body",
      { GITHUB_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\n-----END PRIVATE KEY-----" },
      "GITHUB_PRIVATE_KEY",
    ],
    ["a short webhook secret", { GITHUB_WEBHOOK_SECRET: "too-short" }, "GITHUB_WEBHOOK_SECRET"],
    ["a port out of range", { PORT: "70000" }, "PORT"],
    ["an empty port", { PORT: "" }, "PORT"],
    ["an unknown log level", { LOG_LEVEL: "verbose" }, "LOG_LEVEL"],
    ["a negative proxy count", { TRUST_PROXY: "-1" }, "TRUST_PROXY"],
    ["zero concurrency", { REVIEW_CONCURRENCY: "0" }, "REVIEW_CONCURRENCY"],
    ["a fractional queue limit", { REVIEW_QUEUE_LIMIT: "1.5" }, "REVIEW_QUEUE_LIMIT"],
    ["a zero rate limit", { WEBHOOK_RATE_LIMIT: "0" }, "WEBHOOK_RATE_LIMIT"],
  ])("rejects %s", (_name, overrides, variable) => {
    const issues = issuesOf(overrides);

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(new RegExp(`^${variable}: `));
  });

  it("never includes a value in the error", () => {
    const secretLookingValues = {
      GITHUB_APP_ID: "not-a-number-but-sensitive",
      GITHUB_PRIVATE_KEY: "sensitive-private-key-material",
      GITHUB_WEBHOOK_SECRET: "short-secret",
    };

    let message = "";
    try {
      loadConfig(environment(secretLookingValues));
    } catch (error) {
      message = error instanceof Error ? error.message : "";
    }

    expect(message).toContain("Invalid environment configuration.");
    for (const value of Object.values(secretLookingValues)) {
      expect(message).not.toContain(value);
    }
  });
});

describe("loadConfig for the dashboard", () => {
  const DASHBOARD = {
    DATABASE_URL: "postgres://user:pw@db.example:5432/prbuddy",
    GITHUB_CLIENT_ID: "Iv1.abcdef",
    GITHUB_CLIENT_SECRET: "CLIENT-SECRET-CANARY",
    PUBLIC_URL: "https://buddy.example",
  };

  it("is off when none of its variables are set", () => {
    expect(loadConfig(environment())).not.toHaveProperty("dashboard");
    expect(loadConfig(environment({ DATABASE_URL: DASHBOARD.DATABASE_URL }))).not.toHaveProperty(
      "dashboard",
    );
  });

  it("carries the app's name when it is set, and has none otherwise", () => {
    expect(loadConfig(environment(DASHBOARD)).dashboard).not.toHaveProperty("appSlug");
    expect(
      loadConfig(environment({ ...DASHBOARD, GITHUB_APP_SLUG: "pr-buddy-acme" })).dashboard,
    ).toMatchObject({ appSlug: "pr-buddy-acme" });
  });

  it.each(["a", "pr-buddy", "pr-buddy-2", "a".repeat(100)])("accepts the app name %s", (slug) => {
    expect(
      loadConfig(environment({ ...DASHBOARD, GITHUB_APP_SLUG: slug })).dashboard?.appSlug,
    ).toBe(slug);
  });

  it.each([
    "",
    "PR-Buddy",
    "pr buddy",
    "-pr-buddy",
    "pr-buddy-",
    "pr_buddy",
    "pr.buddy",
    "pr-buddy/installations",
    "../settings",
    "pr-buddy?x=1",
    "pr-buddy#x",
    "evil.example/x",
    "https://github.com/apps/pr-buddy",
    "a".repeat(101),
  ])("refuses the app name %j", (slug) => {
    expect(issuesOf({ ...DASHBOARD, GITHUB_APP_SLUG: slug })).toEqual([
      "GITHUB_APP_SLUG: must be the app's name in github.com/apps/<name>",
    ]);
  });

  it("is on when all of them and the database are set", () => {
    expect(loadConfig(environment(DASHBOARD)).dashboard).toEqual({
      clientId: "Iv1.abcdef",
      clientSecret: "CLIENT-SECRET-CANARY",
      publicUrl: "https://buddy.example",
    });
  });

  it("reduces the public URL to its origin", () => {
    const config = loadConfig(environment({ ...DASHBOARD, PUBLIC_URL: "https://Buddy.Example/" }));

    expect(config.dashboard?.publicUrl).toBe("https://buddy.example");
  });

  it.each(["http://localhost:3000", "http://127.0.0.1:3000"])(
    "accepts plain HTTP for %s",
    (publicUrl) => {
      const config = loadConfig(environment({ ...DASHBOARD, PUBLIC_URL: publicUrl }));

      expect(config.dashboard?.publicUrl).toBe(publicUrl);
    },
  );

  it.each([
    ["plain HTTP on another host", "http://buddy.example"],
    ["a host that only starts with localhost", "http://localhost.evil.example"],
    ["a path", "https://buddy.example/app"],
    ["a query", "https://buddy.example/?next=x"],
    ["credentials", "https://user:pw@buddy.example"],
    ["another scheme", "javascript:alert(1)"],
    ["text that is not a URL", "buddy"],
  ])("rejects a public URL with %s", (_name, publicUrl) => {
    expect(issuesOf({ ...DASHBOARD, PUBLIC_URL: publicUrl })).toEqual([
      "PUBLIC_URL: must be an https:// origin, or http://localhost for development",
    ]);
  });

  it("names what is missing when only some variables are set", () => {
    expect(
      issuesOf({ DATABASE_URL: DASHBOARD.DATABASE_URL, PUBLIC_URL: DASHBOARD.PUBLIC_URL }),
    ).toEqual([
      "GITHUB_CLIENT_ID: is required when the other dashboard variables are set",
      "GITHUB_CLIENT_SECRET: is required when the other dashboard variables are set",
    ]);
  });

  it("requires the database", () => {
    expect(issuesOf({ ...DASHBOARD, DATABASE_URL: undefined })).toEqual([
      "DATABASE_URL: is required for the dashboard",
    ]);
  });

  it("rejects an empty client secret without repeating any value", () => {
    const issues = issuesOf({ ...DASHBOARD, GITHUB_CLIENT_SECRET: "" });

    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("GITHUB_CLIENT_SECRET");
    expect(issuesOf({ ...DASHBOARD, PUBLIC_URL: "x" }).join()).not.toContain("CANARY");
  });
});

describe("loadConfig for AI review", () => {
  it("is off when no provider is named, even if other AI variables are set", () => {
    expect(loadConfig(environment())).not.toHaveProperty("ai");
    expect(
      loadConfig(environment({ AI_PROVIDER: "", AI_MODEL: "m", AWS_REGION: "us-east-1" })),
    ).not.toHaveProperty("ai");
  });

  it("reads Bedrock with an access key and a session token", () => {
    const config = loadConfig(
      environment({
        AI_PROVIDER: "bedrock",
        AI_MODEL: "us.anthropic.claude-sonnet-4-20250514-v1:0",
        AWS_REGION: "us-east-1",
        AWS_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
        AWS_SECRET_ACCESS_KEY: "secret",
        AWS_SESSION_TOKEN: "token",
      }),
    );

    expect(config.ai).toEqual({
      provider: "bedrock",
      model: "us.anthropic.claude-sonnet-4-20250514-v1:0",
      region: "us-east-1",
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "secret",
      sessionToken: "token",
      timeoutMs: 60_000,
    });
  });

  it("reads a Bedrock API key under either name, preferring the generic one", () => {
    const bedrock = { AI_PROVIDER: "bedrock", AI_MODEL: "m", AWS_REGION: "eu-west-1" };

    expect(
      loadConfig(environment({ ...bedrock, AWS_BEARER_TOKEN_BEDROCK: "aws-name" })).ai?.apiKey,
    ).toBe("aws-name");
    expect(
      loadConfig(
        environment({ ...bedrock, AI_API_KEY: "generic", AWS_BEARER_TOKEN_BEDROCK: "aws-name" }),
      ).ai?.apiKey,
    ).toBe("generic");
  });

  it("reads the other providers, a base URL and a time limit", () => {
    expect(
      loadConfig(
        environment({
          AI_PROVIDER: "azure",
          AI_MODEL: "my-deployment",
          AI_API_KEY: "k",
          AI_BASE_URL: "https://r.openai.azure.com/openai/v1/",
          AI_TIMEOUT_MS: "20000",
        }),
      ).ai,
    ).toEqual({
      provider: "azure",
      model: "my-deployment",
      apiKey: "k",
      baseUrl: "https://r.openai.azure.com/openai/v1",
      timeoutMs: 20_000,
    });
    expect(
      loadConfig(environment({ AI_PROVIDER: "anthropic", AI_MODEL: "m", AI_API_KEY: "k" })).ai,
    ).toMatchObject({ provider: "anthropic" });
  });

  it.each<[string, Record<string, string>, string[]]>([
    ["an unknown provider", { AI_PROVIDER: "skynet", AI_MODEL: "m" }, ["AI_PROVIDER: "]],
    ["no model", { AI_PROVIDER: "openai", AI_API_KEY: "k" }, ["AI_MODEL: "]],
    ["no key", { AI_PROVIDER: "openai", AI_MODEL: "m" }, ["AI_API_KEY: is required for openai"]],
    [
      "Bedrock without a region or credentials",
      { AI_PROVIDER: "bedrock", AI_MODEL: "m" },
      [
        "AWS_REGION: is required for bedrock",
        "AI_API_KEY: bedrock needs a Bedrock API key, or an access key ID with its secret",
      ],
    ],
    [
      "a malformed access key ID",
      {
        AI_PROVIDER: "bedrock",
        AI_MODEL: "m",
        AWS_REGION: "us-east-1",
        AWS_ACCESS_KEY_ID: "nope nope",
        AWS_SECRET_ACCESS_KEY: "s",
      },
      ["AWS_ACCESS_KEY_ID: must be an AWS access key ID"],
    ],
    [
      "a base URL over plain HTTP",
      { AI_PROVIDER: "azure", AI_MODEL: "m", AI_API_KEY: "k", AI_BASE_URL: "http://r.example" },
      ["AI_BASE_URL: must be an https:// URL, or http:// on this machine"],
    ],
    [
      "a time limit that is not a number",
      { AI_PROVIDER: "openai", AI_MODEL: "m", AI_API_KEY: "k", AI_TIMEOUT_MS: "soon" },
      ["AI_TIMEOUT_MS: "],
    ],
  ])("stops at start-up for %s, naming the variable", (_name, overrides, expected) => {
    const issues = issuesOf(overrides);

    expect(issues).toHaveLength(expected.length);
    expected.forEach((prefix, index) => {
      expect(issues[index]).toContain(prefix);
    });
  });

  it("never repeats a credential in an error", () => {
    const issues = issuesOf({
      AI_PROVIDER: "bedrock",
      AI_MODEL: "bad model name",
      AWS_REGION: "CANARY-region",
      AWS_ACCESS_KEY_ID: "CANARY-id",
      AWS_SECRET_ACCESS_KEY: "CANARY-secret",
      AI_API_KEY: "CANARY-key",
    });

    expect(issues.length).toBeGreaterThan(1);
    expect(issues.join()).not.toContain("CANARY");
  });
});

describe("loadConfig for stored secrets", () => {
  const KEY = Buffer.alloc(32, 7).toString("base64");
  const OLD_KEY = Buffer.alloc(32, 9).toString("base64");

  it("has no master key unless one is set", () => {
    expect(loadConfig(environment())).not.toHaveProperty("secretKeys");
  });

  it("reads the master key, and a previous one for rotation", () => {
    const one = loadConfig(environment({ SECRETS_ENCRYPTION_KEY: KEY }));
    const two = loadConfig(
      environment({ SECRETS_ENCRYPTION_KEY: KEY, SECRETS_ENCRYPTION_KEY_PREVIOUS: OLD_KEY }),
    );

    expect(one.secretKeys?.current.equals(Buffer.alloc(32, 7))).toBe(true);
    expect(one.secretKeys?.previous).toEqual([]);
    expect(two.secretKeys?.previous[0]?.equals(Buffer.alloc(32, 9))).toBe(true);
  });

  it.each([
    ["too short", Buffer.alloc(16).toString("base64")],
    ["not base64", "CANARY not a key"],
  ])("stops at start-up for a master key that is %s, without repeating it", (_name, value) => {
    const issues = issuesOf({ SECRETS_ENCRYPTION_KEY: value });

    expect(issues).toEqual(["SECRETS_ENCRYPTION_KEY: must be 32 random bytes in base64"]);
  });

  it("requires the current key when a previous one is given", () => {
    expect(issuesOf({ SECRETS_ENCRYPTION_KEY_PREVIOUS: OLD_KEY })).toEqual([
      "SECRETS_ENCRYPTION_KEY: is required when SECRETS_ENCRYPTION_KEY_PREVIOUS is set",
    ]);
  });
});

describe("findConfigurationWarnings", () => {
  const dashboard = {
    DATABASE_URL: "postgres://user:pw@db.example:5432/prbuddy",
    GITHUB_CLIENT_ID: "Iv1.abcdef",
    GITHUB_CLIENT_SECRET: "secret",
    PUBLIC_URL: "https://buddy.example",
    GITHUB_APP_SLUG: "pr-buddy-acme",
  };
  const warningsFor = (overrides: Record<string, string | undefined>): string[] =>
    findConfigurationWarnings(loadConfig(environment(overrides)));

  it("has nothing to say about a plain local set-up", () => {
    expect(warningsFor({})).toEqual([]);
    expect(warningsFor({ ...dashboard, PUBLIC_URL: "http://localhost:3000" })).toEqual([]);
  });

  it("has nothing to say about HTTPS behind a trusted proxy", () => {
    expect(warningsFor({ ...dashboard, TRUST_PROXY: "1" })).toEqual([]);
  });

  it("warns when the public address is HTTPS but no proxy is trusted", () => {
    const warnings = warningsFor(dashboard);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("PUBLIC_URL is HTTPS but TRUST_PROXY is 0");
  });

  it.each(["?sslmode=disable", "?application_name=x&sslmode=disable"])(
    "warns when the database connection is unencrypted: %s",
    (query) => {
      const warnings = warningsFor({ DATABASE_URL: `postgres://u:pw-CANARY@db:5432/p${query}` });

      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("DATABASE_URL turns encryption off");
      expect(warnings[0]).not.toContain("CANARY");
    },
  );

  it("does not warn about an encrypted database connection", () => {
    expect(warningsFor({ DATABASE_URL: "postgres://u:p@db:5432/p?sslmode=require" })).toEqual([]);
  });

  it("warns when the dashboard is on and the app is not named", () => {
    const warnings = warningsFor({
      ...dashboard,
      GITHUB_APP_SLUG: undefined,
      PUBLIC_URL: "http://localhost:3000",
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("GITHUB_APP_SLUG is not set");
  });

  it("does not ask for the app's name when the dashboard is off", () => {
    expect(warningsFor({ GITHUB_APP_SLUG: undefined })).toEqual([]);
  });
});

describe("createLogger", () => {
  function capture(level: Parameters<typeof createLogger>[0]): {
    lines: string[];
    logger: ReturnType<typeof createLogger>;
  } {
    const lines: string[] = [];
    return { lines, logger: createLogger(level, { write: (line) => lines.push(line) }) };
  }

  it("writes structured JSON with the service name", () => {
    const { lines, logger } = capture("info");

    logger.info({ pullRequestNumber: 7 }, "Review completed");

    expect(JSON.parse(lines[0] ?? "")).toMatchObject({
      service: "pr-buddy-api",
      pullRequestNumber: 7,
      msg: "Review completed",
    });
  });

  it("respects the level", () => {
    const { lines, logger } = capture("warn");

    logger.debug({}, "hidden");
    logger.info({}, "hidden");
    logger.warn({}, "shown");
    logger.error({}, "shown");

    expect(lines).toHaveLength(2);
  });

  it("redacts credentials even if a caller logs them by mistake", () => {
    const { lines, logger } = capture("info");

    logger.info(
      {
        token: "ghs_installation_token",
        privateKey: PRIVATE_KEY,
        webhookSecret: WEBHOOK_SECRET,
        request: { authorization: "Bearer abc", secret: "s3cret" },
      },
      "Oops",
    );

    const line = lines.join("");
    expect(line).not.toContain("ghs_installation_token");
    expect(line).not.toContain("bm90LWEtcmVhbC1rZXk");
    expect(line).not.toContain(WEBHOOK_SECRET);
    expect(line).not.toContain("Bearer abc");
    expect(line).not.toContain("s3cret");
    expect(line).toContain("[redacted]");
  });

  it("redacts AI and dashboard credentials as well", () => {
    const { lines, logger } = capture("info");

    logger.info(
      {
        apiKey: "AI-KEY-CANARY",
        clientSecret: "CLIENT-CANARY",
        ai: { secretAccessKey: "AWS-CANARY", sessionToken: "SESSION-CANARY", model: "m" },
        request: { cookie: "prbuddy_session=COOKIE-CANARY" },
      },
      "Oops",
    );

    expect(lines.join("")).not.toContain("CANARY");
    expect(lines.join("")).toContain('"model":"m"');
  });

  it("can be created without a destination", () => {
    expect(() => {
      createLogger("silent").info({}, "nothing is written");
    }).not.toThrow();
  });
});

describe("describeError", () => {
  it("keeps the name and message of an error", () => {
    expect(describeError(new TypeError("fetch failed"))).toEqual({
      errorName: "TypeError",
      errorMessage: "fetch failed",
    });
  });

  it("keeps an HTTP status", () => {
    const error = Object.assign(new Error("Not Found"), {
      status: 404,
      response: { headers: { secret: "x" } },
    });

    expect(describeError(error)).toEqual({
      errorName: "Error",
      errorMessage: "Not Found",
      status: 404,
    });
  });

  it("keeps a short error code, as database and network errors have", () => {
    const error = Object.assign(new Error("duplicate key"), { code: "23505" });

    expect(describeError(error)).toEqual({
      errorName: "Error",
      errorMessage: "duplicate key",
      errorCode: "23505",
    });
    expect(describeError(Object.assign(new Error("x"), { code: 5 }))).not.toHaveProperty(
      "errorCode",
    );
  });

  it("drops a status that is not a number", () => {
    expect(describeError(Object.assign(new Error("x"), { status: "500" }))).not.toHaveProperty(
      "status",
    );
  });

  it("bounds the message length", () => {
    const described = describeError(new Error("x".repeat(5_000)));

    expect(String(described["errorMessage"])).toHaveLength(500);
  });

  it.each(["a string", 42, null, undefined, { message: "not an Error" }])(
    "describes the thrown value %j without its content",
    (value) => {
      expect(describeError(value)).toEqual({ errorName: "NonError" });
    },
  );
});
