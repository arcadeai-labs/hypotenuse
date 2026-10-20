import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { api } from "keryx";
import { catalogKey } from "../../ops/LinearCatalogOps";
import {
  LinearRateLimitedError,
  LinearUnavailableError,
  linearRequest,
  rateLimitKey,
} from "../../ops/LinearOps";
import { CreateComment, GetViewer } from "../../ops/linear/operations";
import type { LinearInstallation } from "../../schema/linear_installations";
import {
  buildTestUniverse,
  cookieHeader,
  HOOK_TIMEOUT,
  type TestUniverse,
} from "../setup";
import { useFinear } from "./finear";
import { installationRow } from "./helpers";

let universe: TestUniverse;
beforeAll(async () => {
  universe = await buildTestUniverse();
}, HOOK_TIMEOUT);
afterAll(async () => {
  await api.stop();
}, HOOK_TIMEOUT);

const linear = useFinear();

let installation: LinearInstallation;
beforeAll(async () => {
  const landed = await linear.install(
    universe.projectId,
    universe.peach.sessionId,
  );
  expect(landed.searchParams.get("connected")).toBe("1");
  installation = await installationRow(universe.projectId);
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
    await linearRequest(installation, GetViewer, {});
    const row = await installationRow(universe.projectId);
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
    await linearRequest(installation, GetViewer, {});
    // Redis — what the outbox's token bucket reads — sees every response…
    expect(
      await api.redis.redis.hget(
        rateLimitKey(installation.id),
        "requestsRemaining",
      ),
    ).toBe("4998");
    // …and the row is throttled.
    expect(
      (await installationRow(universe.projectId)).rateLimit?.requestsRemaining,
    ).toBe(4999);
    linear.injectHeaders({});
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
      installation,
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
        rateLimitKey(installation.id),
        "requestsRemaining",
      ),
    ).toBe("0");
  });

  test("a request answers its own caller 429 when Linear is rate-limiting", async () => {
    await api.redis.redis.del(catalogKey(installation.id));
    linear.fault({
      kind: "ratelimit",
      match: (r) => r.operationName === "ListTeams",
    });
    const res = await fetch(
      `${universe.url}/api/linear/catalog?projectId=${universe.projectId}`,
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
      installation,
      GetViewer,
      {},
      {
        idempotent: true,
      },
    );
    expect(viewer.id).toBe(installation.appUserId);
    expect(sent("GetViewer")).toBe(2);

    linear.fault({
      kind: "drop",
      match: (r) => r.operationName === "CreateComment",
    });
    await expect(
      linearRequest(installation, CreateComment, {
        input: { issueId: "ENG-1", body: "x" },
      }),
    ).rejects.toBeInstanceOf(LinearUnavailableError);
    expect(sent("CreateComment")).toBe(1);
  });
});
