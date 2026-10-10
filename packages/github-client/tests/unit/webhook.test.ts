import { describe, expect, it } from "vitest";
import { parseInstallationEvent } from "../../src/webhook/installation-event.js";
import { parsePullRequestEvent, REVIEWABLE_ACTIONS } from "../../src/webhook/pull-request-event.js";
import { signWebhookBody, verifyWebhookSignature } from "../../src/webhook/verify-signature.js";

const SECRET = "a-webhook-secret-for-tests";
const body = (text: string): Buffer => Buffer.from(text, "utf8");

describe("verifyWebhookSignature", () => {
  it("accepts the example from GitHub's documentation", () => {
    const signature = "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17";

    expect(
      verifyWebhookSignature("It's a Secret to Everybody", body("Hello, World!"), signature),
    ).toBe(true);
  });

  it("accepts a signature made with the same secret and body", () => {
    const payload = body('{"action":"opened"}');

    expect(verifyWebhookSignature(SECRET, payload, signWebhookBody(SECRET, payload))).toBe(true);
  });

  it("rejects a signature made with another secret", () => {
    const payload = body('{"action":"opened"}');

    expect(
      verifyWebhookSignature(SECRET, payload, signWebhookBody("another-secret", payload)),
    ).toBe(false);
  });

  it("rejects a body that was changed after signing", () => {
    const signature = signWebhookBody(SECRET, body('{"number":1}'));

    expect(verifyWebhookSignature(SECRET, body('{"number":2}'), signature)).toBe(false);
  });

  it("rejects a body that was re-serialised with different whitespace", () => {
    const signature = signWebhookBody(SECRET, body('{"number":1}'));

    expect(verifyWebhookSignature(SECRET, body('{ "number": 1 }'), signature)).toBe(false);
  });

  it.each([
    ["a missing header", undefined],
    ["an empty header", ""],
    ["the legacy SHA-1 header format", `sha1=${"a".repeat(40)}`],
    ["a signature without the prefix", "a".repeat(64)],
    ["a signature that is too short", "sha256=abc123"],
    ["a signature that is too long", `sha256=${"a".repeat(66)}`],
    ["characters that are not hexadecimal", `sha256=${"z".repeat(64)}`],
    ["uppercase hexadecimal", signWebhookBody(SECRET, "x").toUpperCase()],
  ])("rejects %s", (_name, header) => {
    expect(verifyWebhookSignature(SECRET, body("x"), header)).toBe(false);
  });
});

function buildEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: "opened",
    number: 7,
    installation: { id: 1001 },
    repository: { id: 2002, name: "widgets", owner: { login: "acme" }, full_name: "acme/widgets" },
    pull_request: { title: "A title that must not be used", body: "Nor this body" },
    sender: { login: "someone" },
    ...overrides,
  };
}

describe("parsePullRequestEvent", () => {
  it.each(REVIEWABLE_ACTIONS)("asks for a review after the %s action", (action) => {
    expect(parsePullRequestEvent(buildEvent({ action }))).toEqual({
      kind: "review",
      trigger: {
        action,
        installationId: 1001,
        repository: { id: 2002, owner: "acme", name: "widgets" },
        pullRequestNumber: 7,
      },
    });
  });

  it("carries nothing from the payload except identifiers", () => {
    const parsed = parsePullRequestEvent(buildEvent());

    expect(JSON.stringify(parsed)).not.toContain("must not be used");
  });

  it.each(["closed", "labeled", "assigned", "review_requested", "converted_to_draft", ""])(
    "ignores the %j action",
    (action) => {
      expect(parsePullRequestEvent(buildEvent({ action }))).toEqual({
        kind: "ignored",
        reason: "unsupported-action",
      });
    },
  );

  it.each([
    ["null", null],
    ["a string", "opened"],
    ["an array", []],
    ["an empty object", {}],
    ["no installation", buildEvent({ installation: undefined })],
    ["a non-numeric installation ID", buildEvent({ installation: { id: "1001" } })],
    ["a negative pull request number", buildEvent({ number: -1 })],
    ["a fractional pull request number", buildEvent({ number: 1.5 })],
    ["no repository", buildEvent({ repository: undefined })],
    [
      "an owner containing a slash",
      buildEvent({ repository: { id: 1, name: "widgets", owner: { login: "acme/evil" } } }),
    ],
    [
      "a repository name containing path traversal",
      buildEvent({ repository: { id: 1, name: "../../admin", owner: { login: "acme" } } }),
    ],
    [
      "a repository name that is too long",
      buildEvent({ repository: { id: 1, name: "a".repeat(101), owner: { login: "acme" } } }),
    ],
    ["a non-string action", buildEvent({ action: 5 })],
  ])("ignores a payload with %s as malformed", (_name, payload) => {
    expect(parsePullRequestEvent(payload)).toEqual({
      kind: "ignored",
      reason: "malformed-payload",
    });
  });
});

describe("parseInstallationEvent", () => {
  const installation = { id: 1001, account: { login: "ACCOUNT-CANARY" } };

  it("recognises an uninstall and a suspension", () => {
    expect(parseInstallationEvent("installation", { action: "deleted", installation })).toEqual({
      kind: "removed",
      installationId: 1001,
    });
    expect(parseInstallationEvent("installation", { action: "suspend", installation })).toEqual({
      kind: "suspended",
      installationId: 1001,
    });
  });

  it("recognises repositories removed from an installation, by ID only", () => {
    const change = parseInstallationEvent("installation_repositories", {
      action: "removed",
      installation,
      repositories_removed: [
        { id: 2002, full_name: "acme/NAME-CANARY" },
        { id: 2003, full_name: "acme/other" },
      ],
    });

    expect(change).toEqual({
      kind: "repositories-removed",
      installationId: 1001,
      repositoryIds: [2002, 2003],
    });
    expect(JSON.stringify(change)).not.toContain("CANARY");
  });

  it.each<[string, string, unknown]>([
    ["a new installation", "installation", { action: "created", installation }],
    ["an unsuspension", "installation", { action: "unsuspend", installation }],
    [
      "repositories added",
      "installation_repositories",
      { action: "added", installation, repositories_removed: [] },
    ],
    [
      "an empty removal",
      "installation_repositories",
      { action: "removed", installation, repositories_removed: [] },
    ],
    ["a removal without a list", "installation_repositories", { action: "removed", installation }],
    ["a missing installation", "installation", { action: "deleted" }],
    [
      "an installation ID that is text",
      "installation",
      { action: "deleted", installation: { id: "1001" } },
    ],
    ["a negative installation ID", "installation", { action: "deleted", installation: { id: -1 } }],
    [
      "a repository ID that is text",
      "installation_repositories",
      { action: "removed", installation, repositories_removed: [{ id: "2002" }] },
    ],
    ["a body that is not an object", "installation", "deleted"],
    ["no body", "installation", undefined],
    ["another event", "pull_request", { action: "deleted", installation }],
  ])("ignores %s", (_name, event, payload) => {
    expect(parseInstallationEvent(event, payload)).toEqual({ kind: "ignored" });
  });
});
