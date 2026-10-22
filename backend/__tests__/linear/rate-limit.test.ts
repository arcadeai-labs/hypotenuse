import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { api } from "keryx";
import {
  bucketKey,
  currentObservation,
  takeLinearToken,
} from "../../ops/LinearBucketOps";
import { catalogKey } from "../../ops/LinearCatalogOps";
import {
  LinearRateLimitedError,
  LinearUnavailableError,
  linearRequest,
  rateLimitKey,
} from "../../ops/LinearOps";
import {
  CreateComment,
  GetViewer,
  LINEAR_OPERATIONS,
} from "../../ops/linear/operations";
import type { Integration } from "../../schema/integrations";
import {
  buildTestUniverse,
  cookieHeader,
  HOOK_TIMEOUT,
  type TestUniverse,
} from "../setup";
import { useFinear } from "./finear";
import { integrationRow } from "./helpers";

let universe: TestUniverse;
beforeAll(async () => {
  universe = await buildTestUniverse();
}, HOOK_TIMEOUT);
afterAll(async () => {
  await api.stop();
}, HOOK_TIMEOUT);

const linear = useFinear();

let integration: Integration;
beforeAll(async () => {
  const landed = await linear.install(
    universe.projectId,
    universe.peach.sessionId,
  );
  expect(landed.searchParams.get("connected")).toBe("1");
  integration = await integrationRow(universe.projectId);
}, HOOK_TIMEOUT);

/** How many times the server has sent one operation since the log was cleared. */
const sent = (operation: string) =>
  linear.requests().filter((r) => r.operationName === operation).length;

/**
 * The headers Linear documents, with the given remaining budget.
 * @param remaining - `X-RateLimit-Requests-Remaining`.
 * @returns The header map.
 */
const linearHeaders = (remaining: number) => ({
  "X-RateLimit-Requests-Limit": "5000",
  "X-RateLimit-Requests-Remaining": String(remaining),
  "X-RateLimit-Requests-Reset": "1792000000000",
  "X-RateLimit-Complexity-Limit": "2000000",
  "X-RateLimit-Complexity-Remaining": "1999990",
  "X-RateLimit-Complexity-Reset": "1792000000000",
  "X-Complexity": "10",
});

describe("rate limits", () => {
  test("LC-RATE-04 the X-RateLimit-* headers are recorded on the row and in Redis, the row at most every 10 s", async () => {
    linear.injectHeaders(linearHeaders(4999));
    await linearRequest(integration, GetViewer, {});
    const row = await integrationRow(universe.projectId);
    expect(row.rateLimit).toEqual({
      requestsLimit: 5000,
      requestsRemaining: 4999,
      requestsResetAt: 1792000000000,
      complexityLimit: 2000000,
      complexityRemaining: 1999990,
      complexityResetAt: 1792000000000,
      lastComplexity: 10,
      observedAt: expect.any(Number),
    });

    linear.injectHeaders(linearHeaders(4998));
    await linearRequest(integration, GetViewer, {});
    // Redis — what the outbox's token bucket reads — sees every response…
    expect(
      await api.redis.redis.hget(
        rateLimitKey(integration.id),
        "requestsRemaining",
      ),
    ).toBe("4998");
    // …and the row is throttled.
    expect(
      (await integrationRow(universe.projectId)).rateLimit?.requestsRemaining,
    ).toBe(4999);
    linear.injectHeaders({});
  });

  test("LC-RATE-02 every connection a document reads is bounded with first:, so a query's complexity stays small", () => {
    let connections = 0;
    for (const op of LINEAR_OPERATIONS) {
      for (const m of op.query.matchAll(
        /(\w+)(\(([^)]*)\))?\s*\{\s*(nodes|edges)\b/g,
      )) {
        connections++;
        expect(m[3] ?? "", `${op.name}: ${m[1]}`).toContain("first");
      }
    }
    expect(connections).toBeGreaterThan(3);
  });

  test("LC-RATE-03 RATELIMITED raises LinearRateLimitedError with the reset time, and is never retried", async () => {
    linear.clearRequests();
    const resetAt = Date.now() + 120_000;
    linear.fault({
      kind: "ratelimit",
      match: (r) => r.operationName === "GetViewer",
      resetAt,
    });
    const error = await linearRequest(
      integration,
      GetViewer,
      {},
      {
        idempotent: true,
      },
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LinearRateLimitedError);
    expect((error as LinearRateLimitedError).resetAt).toBe(resetAt);
    expect(sent("GetViewer")).toBe(1);
    expect(
      await api.redis.redis.hget(
        rateLimitKey(integration.id),
        "requestsRemaining",
      ),
    ).toBe("0");
  });

  test("a request answers its own caller 429 when Linear is rate-limiting", async () => {
    await api.redis.redis.del(catalogKey(integration.id));
    linear.fault({
      kind: "ratelimit",
      match: (r) => r.operationName === "ListTeams",
    });
    const res = await fetch(
      `${universe.url}/api/integration/catalog?projectId=${universe.projectId}&type=linear`,
      { headers: cookieHeader(universe.peach.sessionId) },
    );
    expect(res.status).toBe(429);
  });

  test("an idempotent operation is retried once after a lost response; a mutation without a client id is not", async () => {
    linear.clearRequests();
    linear.fault({
      kind: "drop",
      match: (r) => r.operationName === "GetViewer",
    });
    const { viewer } = await linearRequest(
      integration,
      GetViewer,
      {},
      {
        idempotent: true,
      },
    );
    expect(viewer.id).toBe(integration.externalAppUserId);
    expect(sent("GetViewer")).toBe(2);

    linear.fault({
      kind: "drop",
      match: (r) => r.operationName === "CreateComment",
    });
    await expect(
      linearRequest(integration, CreateComment, {
        input: { issueId: "ENG-1", body: "x" },
      }),
    ).rejects.toBeInstanceOf(LinearUnavailableError);
    expect(sent("CreateComment")).toBe(1);
  });
});

describe("the outbox's token bucket", () => {
  /** A bucket key nobody else in the file uses. */
  const BUCKET = 9_001;

  /**
   * Take from the test bucket at a fixed clock.
   * @param priority - The row's priority.
   * @param now - Epoch ms.
   * @returns Granted, and the wait.
   */
  const take = (priority: "ack" | "normal" | "bulk", now: number) =>
    takeLinearToken(BUCKET, priority, now);

  test("LC-RATE-01 refills at 5,000 an hour from a burst of 60, and keeps the last 10 for acknowledgements", async () => {
    await api.redis.redis.del(bucketKey(BUCKET), rateLimitKey(BUCKET));
    const now = 1_000_000;
    let normal = 0;
    while ((await take("normal", now)).granted) normal++;
    // 60 in the bucket, 10 kept back.
    expect(normal).toBe(50);
    const refused = await take("normal", now);
    expect(refused.granted).toBe(false);
    // One more token, at 5,000 an hour, is 720 ms away.
    expect(refused.waitMs).toBe(720);

    let acks = 0;
    while ((await take("ack", now)).granted) acks++;
    expect(acks).toBe(10);

    // Two seconds later, about 2.8 tokens have refilled: still short of the
    // reserve for normal work, enough for an acknowledgement.
    expect((await take("normal", now + 2000)).granted).toBe(false);
    expect((await take("ack", now + 2000)).granted).toBe(true);
  });

  test("bulk work yields first: it keeps twice the reserve", async () => {
    await api.redis.redis.del(bucketKey(BUCKET), rateLimitKey(BUCKET));
    const now = 2_000_000;
    let bulk = 0;
    while ((await take("bulk", now)).granted) bulk++;
    expect(bulk).toBe(40);
    expect((await take("normal", now)).granted).toBe(true);
  });

  test("LC-RATE-01 Linear's lower count wins, once per observation, and not after its window resets", async () => {
    await api.redis.redis.del(bucketKey(BUCKET), rateLimitKey(BUCKET));
    const now = Date.now();
    await api.redis.redis.hset(rateLimitKey(BUCKET), {
      requestsRemaining: "12",
      observedAt: String(now),
      requestsResetAt: String(now + 60_000),
    });
    // Twelve remain, not our sixty: two normal takes reach the reserve…
    expect((await take("normal", now)).granted).toBe(true);
    expect((await take("normal", now)).granted).toBe(true);
    expect((await take("normal", now)).granted).toBe(false);
    // …and the same observation is not applied a second time.
    expect((await take("ack", now)).granted).toBe(true);

    // After Linear's reset, the old count no longer pins a fresh bucket.
    await api.redis.redis.del(bucketKey(BUCKET));
    expect(currentObservation(0, now, now + 60_000, now + 60_001)).toEqual([
      -1, 0,
    ]);
    expect((await take("normal", now + 60_001)).granted).toBe(true);
  });
});
