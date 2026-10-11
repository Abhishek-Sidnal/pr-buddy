import express, { type Express } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { mergeEnvFile } from "../../src/modules/app-registration/env-file.js";
import {
  buildManifest,
  redirectUrlFor,
  registrationOptionsSchema,
  toEnvironment,
  type AppCredentials,
  type RegistrationOptions,
} from "../../src/modules/app-registration/manifest.js";
import { createRegistrationRouter } from "../../src/modules/app-registration/registration.router.js";

const OPTIONS: RegistrationOptions = {
  name: "pr-buddy-dev",
  webhookUrl: "https://smee.io/abc123",
  publicUrl: "http://localhost:3000",
  isPublic: false,
  configAccess: "single-file",
  port: 3999,
};

const PEM =
  "-----BEGIN RSA PRIVATE KEY-----\nPEM-CANARY-line-1\nPEM-CANARY-line-2\n-----END RSA PRIVATE KEY-----\n";
const CREDENTIALS: AppCredentials = {
  id: 123456,
  slug: "pr-buddy-dev",
  pem: PEM,
  webhook_secret: "WEBHOOK-SECRET-CANARY",
  client_id: "Iv1.clientid",
  client_secret: "CLIENT-SECRET-CANARY",
};

describe("what may be asked for when registering an app", () => {
  const issuesOf = (overrides: Record<string, unknown>): string[] => {
    const parsed = registrationOptionsSchema.safeParse({ ...OPTIONS, ...overrides });
    return parsed.success ? [] : parsed.error.issues.map((issue) => String(issue.path[0]));
  };

  it("accepts a development app and a public one", () => {
    expect(issuesOf({})).toEqual([]);
    expect(
      issuesOf({
        name: "PR Buddy",
        webhookUrl: "https://buddy.example/webhooks/github",
        publicUrl: "https://buddy.example",
        isPublic: true,
        configAccess: "contents",
      }),
    ).toEqual([]);
  });

  it("reduces the dashboard's address to its origin", () => {
    expect(
      registrationOptionsSchema.parse({ ...OPTIONS, publicUrl: "https://Buddy.Example/app/" })
        .publicUrl,
    ).toBe("https://buddy.example");
  });

  it.each<[string, Record<string, unknown>]>([
    ["name", { name: "" }],
    ["name", { name: "a".repeat(35) }],
    ["name", { name: "<script>" }],
    ["name", { name: "-leading-hyphen" }],
    ["webhookUrl", { webhookUrl: "" }],
    ["webhookUrl", { webhookUrl: "http://relay.example/hook" }],
    ["webhookUrl", { webhookUrl: "javascript:alert(1)" }],
    ["webhookUrl", { webhookUrl: "https://user:pw@relay.example/" }],
    ["publicUrl", { publicUrl: "http://buddy.example" }],
    ["publicUrl", { publicUrl: "ftp://buddy.example" }],
    ["publicUrl", { publicUrl: "not a url" }],
    ["port", { port: 80 }],
    ["port", { port: 70_000 }],
    ["port", { port: Number.NaN }],
    ["configAccess", { configAccess: "everything" }],
  ])("refuses a bad %s", (field, overrides) => {
    expect([...new Set(issuesOf(overrides))]).toEqual([field]);
  });

  it("refuses an option it does not know", () => {
    expect(registrationOptionsSchema.safeParse({ ...OPTIONS, permissions: "all" }).success).toBe(
      false,
    );
  });
});

describe("the app that is described to GitHub", () => {
  it("asks for what PR Buddy needs and nothing more", () => {
    expect(buildManifest(OPTIONS)).toEqual({
      name: "pr-buddy-dev",
      url: "http://localhost:3000",
      description: "Reviews pull requests with fixed rules and keeps one comment up to date.",
      hook_attributes: { url: "https://smee.io/abc123", active: true },
      redirect_url: "http://localhost:3999/callback",
      callback_urls: ["http://localhost:3000/auth/callback"],
      setup_url: "http://localhost:3000/auth/login",
      setup_on_update: true,
      public: false,
      request_oauth_on_install: false,
      default_events: ["pull_request"],
      default_permissions: {
        metadata: "read",
        pull_requests: "write",
        members: "read",
        single_file: "read",
      },
    });
  });

  it("asks to read code only when told to, and then not for the single file", () => {
    expect(buildManifest({ ...OPTIONS, configAccess: "contents" }).default_permissions).toEqual({
      metadata: "read",
      pull_requests: "write",
      members: "read",
      contents: "read",
    });
  });

  it("never asks to write code or to administer, and reads members only to tell who is an owner", () => {
    for (const configAccess of ["single-file", "contents"] as const) {
      const permissions = buildManifest({ ...OPTIONS, configAccess }).default_permissions;
      expect(Object.entries(permissions).filter(([, access]) => access === "write")).toEqual([
        ["pull_requests", "write"],
      ]);
      expect(Object.keys(permissions)).not.toContain("administration");
      expect(permissions["members"]).toBe("read");
      expect(Object.keys(permissions)).not.toContain("organization_administration");
    }
  });

  it("is public only when asked", () => {
    expect(buildManifest({ ...OPTIONS, isPublic: true }).public).toBe(true);
  });

  it("sends the browser back to this machine", () => {
    expect(redirectUrlFor(4100)).toBe("http://localhost:4100/callback");
  });
});

describe("turning GitHub's answer into settings", () => {
  it("names every setting the service reads, with the key on one line", () => {
    const environment = toEnvironment(CREDENTIALS, "http://localhost:3000");

    expect(environment).toEqual({
      GITHUB_APP_ID: "123456",
      GITHUB_PRIVATE_KEY:
        "-----BEGIN RSA PRIVATE KEY-----\\nPEM-CANARY-line-1\\nPEM-CANARY-line-2\\n-----END RSA PRIVATE KEY-----",
      GITHUB_WEBHOOK_SECRET: "WEBHOOK-SECRET-CANARY",
      GITHUB_CLIENT_ID: "Iv1.clientid",
      GITHUB_CLIENT_SECRET: "CLIENT-SECRET-CANARY",
      GITHUB_APP_SLUG: "pr-buddy-dev",
      PUBLIC_URL: "http://localhost:3000",
    });
    expect(Object.values(environment).some((value) => /[\r\n]/.test(value))).toBe(false);
  });

  it("copes with a key that has Windows line endings", () => {
    const environment = toEnvironment(
      { ...CREDENTIALS, pem: PEM.replaceAll("\n", "\r\n") },
      "http://localhost:3000",
    );

    expect(environment["GITHUB_PRIVATE_KEY"]).not.toContain("\r");
    expect(environment["GITHUB_PRIVATE_KEY"]?.split("\\n")).toHaveLength(4);
  });
});

describe("writing settings into an environment file", () => {
  it("replaces a setting where it stands and leaves everything else alone", () => {
    const before = [
      "# GitHub App",
      "GITHUB_APP_ID=1",
      "GITHUB_WEBHOOK_SECRET=old",
      "",
      "AI_PROVIDER=bedrock",
      "",
    ].join("\n");

    expect(mergeEnvFile(before, { GITHUB_APP_ID: "2", GITHUB_WEBHOOK_SECRET: "new" })).toBe(
      [
        "# GitHub App",
        "GITHUB_APP_ID=2",
        "GITHUB_WEBHOOK_SECRET=new",
        "",
        "AI_PROVIDER=bedrock",
        "",
      ].join("\n"),
    );
  });

  it("adds what is missing at the end, under a note, and leaves commented settings as comments", () => {
    const merged = mergeEnvFile("LOG_LEVEL=info\n# GITHUB_APP_SLUG=\n", {
      GITHUB_APP_SLUG: "pr-buddy-dev",
      GITHUB_APP_ID: "2",
    });

    expect(merged).toBe(
      [
        "LOG_LEVEL=info",
        "# GITHUB_APP_SLUG=",
        "",
        "# Written when the GitHub App was registered.",
        "GITHUB_APP_SLUG=pr-buddy-dev",
        "GITHUB_APP_ID=2",
        "",
      ].join("\n"),
    );
  });

  it("starts a file that does not exist yet", () => {
    expect(mergeEnvFile("", { GITHUB_APP_ID: "2" })).toBe(
      "# Written when the GitHub App was registered.\nGITHUB_APP_ID=2\n",
    );
  });

  it("keeps Windows line endings, and a value with an equals sign or a dollar", () => {
    const merged = mergeEnvFile("A=1\r\nGITHUB_CLIENT_SECRET=old\r\n", {
      GITHUB_CLIENT_SECRET: "a=b$c&d",
    });

    expect(merged).toBe("A=1\r\nGITHUB_CLIENT_SECRET=a=b$c&d\r\n");
  });

  it("replaces only a whole name, not one that merely starts the same", () => {
    expect(mergeEnvFile("GITHUB_APP_ID_OLD=1\n", { GITHUB_APP_ID: "2" })).toContain(
      "GITHUB_APP_ID_OLD=1\n",
    );
  });

  it("is the same when run twice", () => {
    const once = mergeEnvFile("A=1\n", { GITHUB_APP_ID: "2" });

    expect(mergeEnvFile(once, { GITHUB_APP_ID: "2" })).toBe(once);
  });

  it.each<[string, Record<string, string>]>([
    ["a value with a line break", { GITHUB_APP_ID: "2\nEVIL=1" }],
    ["a value with a carriage return", { GITHUB_APP_ID: "2\rEVIL=1" }],
    ["a name with a line break", { "GITHUB_APP_ID\nEVIL": "1" }],
    ["a name with an equals sign", { "A=B": "1" }],
    ["a lower-case name", { github_app_id: "1" }],
  ])("refuses %s, so one setting can never become two", (_name, values) => {
    expect(() => mergeEnvFile("A=1\n", values)).toThrow();
  });
});

describe("the pages of registering an app", () => {
  const STATE = "state-0123456789-abcdefghijklmnopqrstuvwxyz";
  let stored: AppCredentials[];
  let finished: string[];
  let exchanges: { url: string; method: string | undefined }[];
  let githubAnswer: () => Response;
  let app: Express;

  function build(
    overrides: { needsFilePath?: boolean; storing?: () => Promise<void> } = {},
  ): Express {
    const target = express();
    target.use(
      createRegistrationRouter({
        manifest: buildManifest(OPTIONS),
        state: STATE,
        needsFilePath: overrides.needsFilePath ?? true,
        onRegistered: (credentials) => {
          stored.push(credentials);
          return overrides.storing?.() ?? Promise.resolve();
        },
        onFinished: (outcome) => finished.push(outcome),
        fetch: (input, init) => {
          exchanges.push({ url: typeof input === "string" ? input : "", method: init?.method });
          return Promise.resolve(githubAnswer());
        },
      }),
    );
    return target;
  }

  beforeEach(() => {
    stored = [];
    finished = [];
    exchanges = [];
    githubAnswer = () => Response.json(CREDENTIALS, { status: 201 });
    app = build();
  });

  const callback = (query: Record<string, string>): request.Test =>
    request(app).get("/callback").query(query);

  it("shows what will be registered and posts the manifest to GitHub with the state", async () => {
    const response = await request(app).get("/");

    expect(response.status).toBe(200);
    expect(response.text).toContain("<strong>pr-buddy-dev</strong>");
    expect(response.text).toContain("https://smee.io/abc123");
    expect(response.text).toContain("<li>pull_requests: write</li>");
    expect(response.text).toContain(
      `<form method="post" action="https://github.com/settings/apps/new?state=${STATE}">`,
    );
    const field = /name="manifest" value="([^"]*)"/.exec(response.text)?.[1] ?? "";
    expect(JSON.parse(field.replaceAll("&quot;", '"'))).toEqual(buildManifest(OPTIONS));
  });

  it("escapes what the person chose before it becomes part of a page", async () => {
    const hostile = express();
    hostile.use(
      createRegistrationRouter({
        manifest: {
          ...buildManifest(OPTIONS),
          name: `"><script>alert(1)</script>`,
          hook_attributes: { url: "https://x.example/'\"<b>", active: true },
        },
        state: STATE,
        needsFilePath: true,
        onRegistered: () => Promise.resolve(),
        onFinished: () => undefined,
      }),
    );

    const response = await request(hostile).get("/");

    expect(response.text).not.toContain("<script>");
    expect(response.text).not.toContain("<b>");
    expect(response.text).toContain("&lt;script&gt;");
  });

  it("forbids framing, caching, scripts, and forms to anywhere but GitHub", async () => {
    const response = await request(app).get("/");

    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["content-security-policy"]).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; form-action https://github.com; frame-ancestors 'none'",
    );
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
  });

  it("exchanges the code once, stores the credentials, and shows none of them", async () => {
    const response = await callback({ code: "abc123", state: STATE });

    expect(response.status).toBe(200);
    expect(exchanges).toEqual([
      { url: "https://api.github.com/app-manifests/abc123/conversions", method: "POST" },
    ]);
    expect(stored).toEqual([CREDENTIALS]);
    expect(finished).toEqual(["registered"]);
    expect(response.text).toContain("The app is registered");
    expect(response.text).toContain("https://github.com/apps/pr-buddy-dev/installations/new");
    expect(response.text).not.toContain("CANARY");
    expect(response.text).not.toContain("Iv1.clientid");
    expect(response.text).not.toContain("123456");
  });

  it("tells the person to enter the file's path when the app reads a single file", async () => {
    const response = await callback({ code: "abc123", state: STATE });

    expect(response.text).toContain("https://github.com/settings/apps/pr-buddy-dev/permissions");
    expect(response.text).toContain("<code>.github/pr-buddy.json</code>");
    expect(response.text).toContain("Do this before installing the app.");
  });

  it("leaves that step out when the app may read code", async () => {
    app = build({ needsFilePath: false });

    const response = await callback({ code: "abc123", state: STATE });

    expect(response.text).not.toContain("Single file");
    expect(response.text).toContain("Install the app");
  });

  it.each<[string, Record<string, string>]>([
    ["another state", { code: "abc123", state: "someone-elses-state" }],
    ["no state", { code: "abc123" }],
    ["a state that only starts like ours", { code: "abc123", state: `${STATE}x` }],
    ["no code", { state: STATE }],
    ["a code with a path in it", { code: "../../user", state: STATE }],
    ["a code with a query in it", { code: "abc?x=1", state: STATE }],
    ["a code that is far too long", { code: "a".repeat(300), state: STATE }],
  ])("asks GitHub nothing and stores nothing for %s", async (_name, query) => {
    const response = await callback(query);

    expect(response.status).toBe(400);
    expect(response.text).toContain("Nothing was saved.");
    expect(exchanges).toEqual([]);
    expect(stored).toEqual([]);
    expect(finished).toEqual([]);
  });

  it("still works after a wrong answer was turned away", async () => {
    await callback({ code: "abc123", state: "wrong" });

    expect((await callback({ code: "abc123", state: STATE })).status).toBe(200);
    expect(stored).toHaveLength(1);
  });

  it("serves one registration only", async () => {
    await callback({ code: "abc123", state: STATE });

    const again = await callback({ code: "def456", state: STATE });

    expect(again.status).toBe(410);
    expect(exchanges).toHaveLength(1);
    expect(stored).toHaveLength(1);
  });

  it.each<[string, () => Response]>([
    ["GitHub refuses the code", () => Response.json({ message: "Not Found" }, { status: 404 })],
    ["GitHub answers something else", () => Response.json({ id: "one", pem: "SECRET-CANARY" })],
    ["GitHub answers no JSON", () => new Response("<html>SECRET-CANARY</html>")],
    [
      "the key is not a key",
      () => Response.json({ ...CREDENTIALS, pem: "SECRET-CANARY" }, { status: 201 }),
    ],
    [
      "the app's name could not be a link",
      () => Response.json({ ...CREDENTIALS, slug: "evil.example/x" }, { status: 201 }),
    ],
  ])("stores nothing and says what to do when %s", async (_name, answer) => {
    githubAnswer = answer;

    const response = await callback({ code: "abc123", state: STATE });

    expect(response.status).toBe(502);
    expect(response.text).toContain("Delete the app on GitHub and run the command again.");
    expect(response.text).not.toContain("CANARY");
    expect(stored).toEqual([]);
    expect(finished).toEqual(["failed"]);
  });

  it("says the same when the credentials could not be written", async () => {
    app = build({ storing: () => Promise.reject(new Error("disk full: SECRET-CANARY")) });

    const response = await callback({ code: "abc123", state: STATE });

    expect(response.status).toBe(502);
    expect(response.text).not.toContain("CANARY");
    expect(finished).toEqual(["failed"]);
  });

  it("answers nothing else", async () => {
    expect((await request(app).get("/anything")).status).toBe(404);
    expect((await request(app).post("/callback")).status).toBe(404);
  });
});
