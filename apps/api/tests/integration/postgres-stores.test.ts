import { createReviewEngine, type ReviewResult } from "@pr-buddy/review-engine";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../../src/database/migrate.js";
import {
  createInMemoryDeliveryStore,
  type DeliveryStore,
} from "../../src/modules/github/delivery-store.js";
import { createPostgresDeliveryStore } from "../../src/modules/github/postgres-delivery-store.js";
import { createPostgresReviewStore } from "../../src/modules/reviews/postgres-review-store.js";
import type { ReviewRecord, ReviewStore } from "../../src/modules/reviews/review-store.js";
import { BASE_SHA, HEAD_SHA } from "../helpers/fake-github.js";
import { createTestDatabase, type TestDatabase } from "../helpers/test-database.js";

let test: TestDatabase;

beforeAll(async () => {
  test = await createTestDatabase();
  await migrate(test.database);
});

afterAll(async () => {
  await test.destroy();
});

beforeEach(async () => {
  await test.database.query("TRUNCATE repositories, webhook_deliveries CASCADE");
});

/** The behaviour every delivery store must have, whatever keeps its data. */
describe.each([
  ["in memory", (): DeliveryStore => createInMemoryDeliveryStore()],
  ["in PostgreSQL", (): DeliveryStore => createPostgresDeliveryStore(test.database)],
])("a delivery store %s", (_name, createStore) => {
  it("accepts a delivery once", async () => {
    const store = createStore();

    await expect(store.claim("delivery-1")).resolves.toBe(true);
    await expect(store.claim("delivery-1")).resolves.toBe(false);
    await expect(store.claim("delivery-2")).resolves.toBe(true);
  });

  it("accepts a released delivery again", async () => {
    const store = createStore();
    await store.claim("delivery-1");

    await store.release("delivery-1");

    await expect(store.claim("delivery-1")).resolves.toBe(true);
  });

  it("ignores the release of a delivery it never saw", async () => {
    await expect(createStore().release("never-seen")).resolves.toBeUndefined();
  });

  it("lets only one of several simultaneous claims win", async () => {
    const store = createStore();

    const claims = await Promise.all(
      Array.from({ length: 10 }, () => store.claim("contested-delivery")),
    );

    expect(claims.filter(Boolean)).toHaveLength(1);
  });
});

describe("the PostgreSQL delivery store", () => {
  it("remembers deliveries across instances, as after a restart", async () => {
    await createPostgresDeliveryStore(test.database).claim("delivery-1");

    const afterRestart = createPostgresDeliveryStore(test.database);

    await expect(afterRestart.claim("delivery-1")).resolves.toBe(false);
  });

  it("accepts a delivery again once it has expired", async () => {
    const store = createPostgresDeliveryStore(test.database, { ttlSeconds: 3_600 });
    await store.claim("delivery-1");
    await expect(store.claim("delivery-1")).resolves.toBe(false);

    await test.database.query(
      "UPDATE webhook_deliveries SET received_at = now() - interval '2 hours'",
    );

    await expect(store.claim("delivery-1")).resolves.toBe(true);
    await expect(store.claim("delivery-1")).resolves.toBe(false);
  });

  it("purges expired deliveries from time to time", async () => {
    const store = createPostgresDeliveryStore(test.database, { ttlSeconds: 3_600, purgeEvery: 3 });
    await store.claim("old-1");
    await store.claim("old-2");
    await test.database.query(
      "UPDATE webhook_deliveries SET received_at = now() - interval '2 hours'",
    );

    await store.claim("new-1");

    const remaining = await test.database.query<{ delivery_id: string }>(
      "SELECT delivery_id FROM webhook_deliveries",
    );
    expect(remaining.rows).toEqual([{ delivery_id: "new-1" }]);
  });

  it("stores a hostile delivery ID as data", async () => {
    const hostile = "'; DROP TABLE webhook_deliveries; --";
    const store = createPostgresDeliveryStore(test.database);

    await expect(store.claim(hostile)).resolves.toBe(true);
    await expect(store.claim(hostile)).resolves.toBe(false);
  });
});

const STARTED_AT = new Date("2026-10-10T10:00:00.000Z");
const COMPLETED_AT = new Date("2026-10-10T10:00:02.500Z");

async function realResult(): Promise<ReviewResult> {
  return createReviewEngine().review({
    pullRequest: { number: 7, title: "T", body: null, baseSha: BASE_SHA, headSha: HEAD_SHA },
    files: [
      {
        path: "src/feature.ts",
        status: "modified",
        additions: 2,
        deletions: 1,
        patch: "@@ -1 +1,2 @@\n-a\n+b\n+c",
      },
    ],
  });
}

function buildRecord(overrides: Partial<ReviewRecord> = {}): ReviewRecord {
  return {
    installationId: 1001,
    repository: { id: 2002, owner: "acme", name: "widgets" },
    pullRequestNumber: 7,
    headSha: HEAD_SHA,
    baseSha: BASE_SHA,
    startedAt: STARTED_AT,
    completedAt: COMPLETED_AT,
    outcome: { status: "skipped", reason: "draft" },
    ...overrides,
  };
}

const rows = async <Row>(sql: string): Promise<Row[]> => (await test.database.query<Row>(sql)).rows;

describe("the PostgreSQL review store", () => {
  let store: ReviewStore;

  beforeEach(() => {
    store = createPostgresReviewStore(test.database);
  });

  it("records a completed review with its findings and rule versions", async () => {
    const result = await realResult();

    await store.save(
      buildRecord({
        outcome: {
          status: "completed",
          comment: "created",
          skippedFileCount: 1,
          omittedPatchCount: 2,
          result,
        },
      }),
    );

    expect(await rows("SELECT * FROM repositories")).toEqual([
      expect.objectContaining({
        id: "2002",
        installation_id: "1001",
        owner: "acme",
        name: "widgets",
      }),
    ]);
    expect(await rows("SELECT * FROM reviews")).toEqual([
      expect.objectContaining({
        repository_id: "2002",
        pull_request_number: 7,
        head_sha: HEAD_SHA,
        base_sha: BASE_SHA,
        status: "completed",
        skip_reason: null,
        comment_action: "created",
        finding_count: 2,
        skipped_file_count: 1,
        omitted_patch_count: 2,
        error_name: null,
        error_status: null,
        started_at: STARTED_AT,
        completed_at: COMPLETED_AT,
      }),
    ]);
    expect(
      await rows(
        "SELECT rule_id, rule_version, status, finding_count FROM rule_executions ORDER BY rule_id",
      ),
    ).toEqual([
      {
        rule_id: "max-changed-files",
        rule_version: "1.0.0",
        status: "completed",
        finding_count: 0,
      },
      {
        rule_id: "missing-test-changes",
        rule_version: "1.0.0",
        status: "completed",
        finding_count: 1,
      },
      { rule_id: "pr-description", rule_version: "1.0.0", status: "completed", finding_count: 1 },
    ]);
    expect(
      await rows(
        "SELECT position, rule_id, severity, confidence, message, evidence FROM findings ORDER BY position",
      ),
    ).toEqual(
      result.findings.map((finding, position) => ({
        position,
        rule_id: finding.ruleId,
        severity: finding.severity,
        confidence: expect.closeTo(finding.confidence, 5) as number,
        message: finding.message,
        evidence: finding.evidence,
      })),
    );
  });

  it("records a finding's location and suggestion", async () => {
    const result = await realResult();
    const located: ReviewResult = {
      ...result,
      findings: [
        {
          ruleId: "located-rule",
          severity: "high",
          confidence: 1,
          message: "Here.",
          evidence: [{ label: "Why", value: "Because" }],
          filePath: "src/feature.ts",
          line: 2,
          suggestion: "Fix it.",
        },
      ],
    };

    await store.save(
      buildRecord({
        outcome: {
          status: "completed",
          comment: "updated",
          skippedFileCount: 0,
          omittedPatchCount: 0,
          result: located,
        },
      }),
    );

    expect(await rows("SELECT file_path, line, suggestion FROM findings")).toEqual([
      { file_path: "src/feature.ts", line: 2, suggestion: "Fix it." },
    ]);
  });

  it.each(["closed", "draft", "stale"] as const)(
    "records a review skipped as %s",
    async (reason) => {
      await store.save(buildRecord({ outcome: { status: "skipped", reason } }));

      expect(
        await rows("SELECT status, skip_reason, comment_action, finding_count FROM reviews"),
      ).toEqual([
        { status: "skipped", skip_reason: reason, comment_action: null, finding_count: 0 },
      ]);
      expect(await rows("SELECT * FROM findings")).toEqual([]);
    },
  );

  it("records a failed review by error name and status, without commit IDs if none were fetched", async () => {
    await store.save({
      installationId: 1001,
      repository: { id: 2002, owner: "acme", name: "widgets" },
      pullRequestNumber: 7,
      startedAt: STARTED_AT,
      completedAt: COMPLETED_AT,
      outcome: { status: "failed", errorName: "HttpError", errorStatus: 403 },
    });

    expect(
      await rows("SELECT status, error_name, error_status, head_sha, base_sha FROM reviews"),
    ).toEqual([
      {
        status: "failed",
        error_name: "HttpError",
        error_status: 403,
        head_sha: null,
        base_sha: null,
      },
    ]);
  });

  it("records a failure that has no HTTP status", async () => {
    await store.save(buildRecord({ outcome: { status: "failed", errorName: "TypeError" } }));

    expect(await rows("SELECT error_name, error_status FROM reviews")).toEqual([
      { error_name: "TypeError", error_status: null },
    ]);
  });

  it("keeps every review of a pull request", async () => {
    await store.save(buildRecord());
    await store.save(buildRecord({ outcome: { status: "skipped", reason: "stale" } }));

    expect(await rows("SELECT id FROM reviews")).toHaveLength(2);
    expect(await rows("SELECT id FROM repositories")).toHaveLength(1);
  });

  it("follows a repository that is renamed, transferred or reinstalled", async () => {
    await store.save(buildRecord());

    await store.save(
      buildRecord({
        installationId: 9009,
        repository: { id: 2002, owner: "newco", name: "gadgets" },
      }),
    );

    expect(await rows("SELECT installation_id, owner, name FROM repositories")).toEqual([
      { installation_id: "9009", owner: "newco", name: "gadgets" },
    ]);
    expect(await rows("SELECT id FROM reviews")).toHaveLength(2);
  });

  it("keeps the reviews of different repositories apart", async () => {
    await store.save(buildRecord());
    await store.save(
      buildRecord({
        installationId: 5005,
        repository: { id: 3003, owner: "other", name: "thing" },
      }),
    );

    expect(
      await rows(
        "SELECT r.installation_id, count(v.id)::int AS reviews FROM repositories r JOIN reviews v ON v.repository_id = r.id GROUP BY r.installation_id ORDER BY r.installation_id",
      ),
    ).toEqual([
      { installation_id: "1001", reviews: 1 },
      { installation_id: "5005", reviews: 1 },
    ]);
  });

  it("stores hostile text as data", async () => {
    const hostile = "x'); DROP TABLE reviews; --";

    await store.save(buildRecord({ repository: { id: 2002, owner: hostile, name: hostile } }));

    expect(await rows("SELECT owner, name FROM repositories")).toEqual([
      { owner: hostile, name: hostile },
    ]);
  });

  it("writes nothing when part of a review cannot be written", async () => {
    const result = await realResult();
    const first = result.rules[0];
    const invalid: ReviewResult = {
      ...result,
      // The same rule twice violates the table's primary key, after the review row is inserted.
      rules: first === undefined ? [] : [first, first],
    };

    await expect(
      store.save(
        buildRecord({
          outcome: {
            status: "completed",
            comment: "created",
            skippedFileCount: 0,
            omittedPatchCount: 0,
            result: invalid,
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "23505" });

    expect(await rows("SELECT id FROM reviews")).toEqual([]);
    expect(await rows("SELECT id FROM repositories")).toEqual([]);
  });

  it("removes a repository's reviews and findings with the repository", async () => {
    const result = await realResult();
    await store.save(
      buildRecord({
        outcome: {
          status: "completed",
          comment: "created",
          skippedFileCount: 0,
          omittedPatchCount: 0,
          result,
        },
      }),
    );

    await test.database.query("DELETE FROM repositories WHERE id = $1", [2002]);

    expect(await rows("SELECT id FROM reviews")).toEqual([]);
    expect(await rows("SELECT review_id FROM findings")).toEqual([]);
    expect(await rows("SELECT review_id FROM rule_executions")).toEqual([]);
  });

  it("stores no title, description or patch anywhere", async () => {
    const result = await createReviewEngine().review({
      pullRequest: {
        number: 7,
        title: "TITLE-CANARY",
        body: "BODY-CANARY",
        baseSha: BASE_SHA,
        headSha: HEAD_SHA,
      },
      files: [
        {
          path: "src/feature.ts",
          status: "modified",
          additions: 1,
          deletions: 0,
          patch: "@@ -0,0 +1 @@\n+PATCH-CANARY",
        },
      ],
    });
    await store.save(
      buildRecord({
        outcome: {
          status: "completed",
          comment: "created",
          skippedFileCount: 0,
          omittedPatchCount: 0,
          result,
        },
      }),
    );

    const dump = JSON.stringify([
      await rows("SELECT * FROM repositories"),
      await rows("SELECT * FROM reviews"),
      await rows("SELECT * FROM findings"),
      await rows("SELECT * FROM rule_executions"),
    ]);

    expect(dump).toContain("src/feature.ts");
    expect(dump).not.toMatch(/CANARY/);
  });
});
