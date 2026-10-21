import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { api, config } from "keryx";
import {
  inflightRefreshKey,
  REFRESH_REPLAY_GRACE_MS,
  refreshInstallationTokens,
} from "../../ops/LinearOAuthOps";
import {
  LinearInstallationUnavailableError,
  LinearUnavailableError,
  linearRequest,
} from "../../ops/LinearOps";
import { GetViewer } from "../../ops/linear/operations";
import { notifications } from "../../schema/notifications";
import {
  buildTestUniverse,
  HOOK_TIMEOUT,
  runAction,
  type TestUniverse,
} from "../setup";
import { useFinear } from "./finear";
import {
  appToken,
  installationRow,
  refreshTokenOf,
  setTokenExpiry,
} from "./helpers";

let universe: TestUniverse;
beforeAll(async () => {
  universe = await buildTestUniverse();
}, HOOK_TIMEOUT);
afterAll(async () => {
  await api.stop();
}, HOOK_TIMEOUT);

const linear = useFinear();

beforeAll(async () => {
  const landed = await linear.install(
    universe.projectId,
    universe.peach.sessionId,
  );
  expect(landed.searchParams.get("connected")).toBe("1");
}, HOOK_TIMEOUT);

/** Ten minutes from now: inside the 30-minute refresh window. */
const soon = () => new Date(Date.now() + 10 * 60 * 1000);

/** How many refresh-token grants the server has sent since the log was cleared. */
const refreshesSent = () =>
  linear
    .requests()
    .filter((r) => r.path === "/oauth/token" && r.grantType === "refresh_token")
    .length;

/**
 * Whether an access token still works at finear.
 * @param token - The token.
 * @returns True when `viewer` answers.
 */
async function tokenWorks(token: string): Promise<boolean> {
  const reply = await linear.graphql(`Bearer ${token}`, "{ viewer { id } }");
  return reply.status === 200 && !reply.errors;
}

describe("linear:refresh-tokens", () => {
  test("leaves a token far from expiry alone", async () => {
    linear.clearRequests();
    const result = await runAction<{ due: number }>("linear:refresh-tokens");
    expect(result.due).toBe(0);
    expect(refreshesSent()).toBe(0);
  });

  test("LC-OAUTH-13 LC-OAUTH-14 rotates both tokens for an installation inside the window", async () => {
    const access = await appToken(universe.projectId);
    const refresh = await refreshTokenOf(universe.projectId);
    await setTokenExpiry(universe.projectId, soon());
    linear.clearRequests();

    const result = await runAction<{ due: number; failed: number }>(
      "linear:refresh-tokens",
    );
    expect(result).toEqual({ due: 1, failed: 0 });
    expect(refreshesSent()).toBe(1);

    const row = await installationRow(universe.projectId);
    expect(row.status).toBe("active");
    expect(await appToken(universe.projectId)).not.toBe(access);
    expect(await refreshTokenOf(universe.projectId)).not.toBe(refresh);
    expect(row.lastRefreshedAt).not.toBeNull();
    expect(row.accessTokenExpiresAt!.getTime() - Date.now()).toBeGreaterThan(
      23 * 60 * 60 * 1000,
    );
    // Rotation spends the old pair.
    expect(await tokenWorks(access)).toBe(false);
    expect(await tokenWorks(await appToken(universe.projectId))).toBe(true);
  });

  test("two refreshers at once call Linear once: the row lock serializes them", async () => {
    await setTokenExpiry(universe.projectId, soon());
    const { id } = await installationRow(universe.projectId);
    linear.clearRequests();

    const [a, b] = await Promise.all([
      refreshInstallationTokens(id),
      refreshInstallationTokens(id),
    ]);
    expect(refreshesSent()).toBe(1);
    expect(a.accessTokenEncrypted).toEqual(b.accessTokenEncrypted);
    expect(await tokenWorks(await appToken(universe.projectId))).toBe(true);
  });

  test("LC-OAUTH-15 a lost refresh response is replayed with the spent token inside the grace and ends active", async () => {
    await setTokenExpiry(universe.projectId, soon());
    const { id } = await installationRow(universe.projectId);
    const spent = await refreshTokenOf(universe.projectId);
    linear.clearRequests();
    // finear rotates the tokens; the answer never reaches the server.
    linear.fault({
      kind: "drop",
      match: (r) => r.grantType === "refresh_token",
    });

    await expect(refreshInstallationTokens(id)).rejects.toBeInstanceOf(
      LinearUnavailableError,
    );
    const lost = await installationRow(universe.projectId);
    expect(lost.status).toBe("active");
    expect(lost.refreshError).toContain("will be retried");
    // Nothing committed: the row still holds the token Linear just spent.
    expect(await refreshTokenOf(universe.projectId)).toBe(spent);
    expect(await api.redis.redis.exists(inflightRefreshKey(id))).toBe(1);

    // Twenty minutes later, by finear's clock, the clock tries again.
    await linear.advance(20 * 60 * 1000);
    const result = await runAction<{ due: number; failed: number }>(
      "linear:refresh-tokens",
    );
    expect(result).toEqual({ due: 1, failed: 0 });
    expect(refreshesSent()).toBe(2);

    const recovered = await installationRow(universe.projectId);
    expect(recovered.status).toBe("active");
    expect(recovered.refreshError).toBeNull();
    expect(await refreshTokenOf(universe.projectId)).not.toBe(spent);
    expect(await tokenWorks(await appToken(universe.projectId))).toBe(true);
    expect(await api.redis.redis.exists(inflightRefreshKey(id))).toBe(0);
  });

  test("a failed refresh cannot stamp its error over a concurrent refresher's success", async () => {
    await setTokenExpiry(universe.projectId, soon());
    const { id, connectedAt } = await installationRow(universe.projectId);
    linear.clearRequests();
    // Whichever refresher takes the lock first loses its response; the second
    // then refreshes for real. The failure is recorded under the lock, so it is
    // never written after the success.
    linear.fault({
      kind: "drop",
      match: (r) => r.grantType === "refresh_token",
    });
    const [first, second] = await Promise.allSettled([
      refreshInstallationTokens(id),
      refreshInstallationTokens(id),
    ]);
    expect([first.status, second.status].sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
    expect(refreshesSent()).toBe(2);
    const row = await installationRow(universe.projectId);
    expect(row.status).toBe("active");
    expect(row.refreshError).toBeNull();
    expect(row.refreshFailedAt).toBeNull();
    // A refresh is not a connect.
    expect(row.connectedAt).toEqual(connectedAt);
    expect(await tokenWorks(await appToken(universe.projectId))).toBe(true);
  });

  test("a 401 refreshes inline once and retries the request", async () => {
    const row = await installationRow(universe.projectId);
    // Something outside this server spent the refresh token, so the access
    // token the row holds is dead — but the spent token still replays.
    const spentAt = await fetch(`${linear.url()}/oauth/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${Buffer.from(`${config.linear.clientId}:${config.linear.clientSecret}`).toString("base64")}`,
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: await refreshTokenOf(universe.projectId),
      }).toString(),
    });
    expect(spentAt.status).toBe(200);
    expect(await tokenWorks(await appToken(universe.projectId))).toBe(false);
    linear.clearRequests();

    const data = await linearRequest(row, GetViewer, {}, { idempotent: true });
    expect(data.viewer.id).toBe(row.appUserId);
    expect(refreshesSent()).toBe(1);
    expect(
      linear.requests().filter((r) => r.operationName === "GetViewer").length,
    ).toBe(2);
    expect(await tokenWorks(await appToken(universe.projectId))).toBe(true);
  });

  test("invalid_grant past the grace marks the installation error and tells the admins", async () => {
    await setTokenExpiry(universe.projectId, soon());
    const { id } = await installationRow(universe.projectId);
    linear.fault({
      kind: "drop",
      match: (r) => r.grantType === "refresh_token",
    });
    await expect(refreshInstallationTokens(id)).rejects.toBeInstanceOf(
      LinearUnavailableError,
    );
    // Past Linear's 30-minute replay grace.
    await linear.advance(REFRESH_REPLAY_GRACE_MS + 60 * 1000);

    const result = await runAction<{ due: number; failed: number }>(
      "linear:refresh-tokens",
    );
    expect(result).toEqual({ due: 1, failed: 0 });
    const row = await installationRow(universe.projectId);
    expect(row.status).toBe("error");
    expect(row.refreshError).toContain("reconnect");
    expect(row.refreshFailedAt).not.toBeNull();

    const sent = await api.db.db
      .select({ userId: notifications.userId })
      .from(notifications)
      .where(
        and(
          eq(notifications.projectId, universe.projectId),
          eq(notifications.template, "linear-refresh-failed"),
        ),
      );
    expect(new Set(sent.map((n) => n.userId))).toEqual(
      new Set([universe.peach.userId]),
    );

    // Nothing more goes to Linear until an admin reconnects.
    linear.clearRequests();
    expect(
      (await runAction<{ due: number }>("linear:refresh-tokens")).due,
    ).toBe(0);
    await expect(linearRequest(row, GetViewer, {})).rejects.toBeInstanceOf(
      LinearInstallationUnavailableError,
    );
    expect(linear.requests()).toEqual([]);

    // Reconnecting clears it.
    const landed = await linear.install(
      universe.projectId,
      universe.peach.sessionId,
    );
    expect(landed.searchParams.get("connected")).toBe("1");
    const reconnected = await installationRow(universe.projectId);
    expect(reconnected.id).toBe(row.id);
    expect(reconnected.status).toBe("active");
    expect(reconnected.refreshError).toBeNull();
  });
});
