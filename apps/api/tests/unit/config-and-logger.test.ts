import { describe, expect, it } from "vitest";
import { EnvironmentError, loadConfig } from "../../src/config/env.js";
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
