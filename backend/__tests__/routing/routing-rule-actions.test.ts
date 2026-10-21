import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, desc, eq } from "drizzle-orm";
import { api } from "keryx";
import type { SerializedRoutingRule } from "../../ops/RoutingOps";
import { auditLogs } from "../../schema/audit_logs";
import { useFinear } from "../linear/finear";
import {
  authHeaders,
  buildTestUniverse,
  cookieHeader,
  HOOK_TIMEOUT,
  type TestUniverse,
  type TestUser,
} from "../setup";

/**
 * `routing-rule:*` and `project:settings-edit` over HTTP: an admin builds and
 * orders the list, every member reads it, nobody else does, and every change
 * is one audit row.
 */

let universe: TestUniverse;
let url: string;
beforeAll(async () => {
  universe = await buildTestUniverse();
  url = universe.url;
}, HOOK_TIMEOUT);
afterAll(async () => {
  await api.stop();
}, HOOK_TIMEOUT);

const linear = useFinear();
beforeAll(async () => {
  await linear.install(universe.projectId, universe.peach.sessionId);
}, HOOK_TIMEOUT);

/** A JSON answer. */
interface Answer<T> {
  status: number;
  body: T & { error?: { message: string; key?: string } };
}

/**
 * Call an action over HTTP as someone.
 * @param method - The verb.
 * @param path - The route under `/api`.
 * @param user - Who.
 * @param body - The JSON body (or query, for GET).
 * @returns Status and body.
 */
async function call<T = Record<string, unknown>>(
  method: string,
  path: string,
  user: TestUser,
  body: Record<string, unknown> = {},
): Promise<Answer<T>> {
  const params = { projectId: universe.projectId, ...body };
  const res =
    method === "GET"
      ? await fetch(
          `${url}/api${path}?${new URLSearchParams(Object.entries(params).map(([k, v]): [string, string] => [k, String(v)]))}`,
          { headers: cookieHeader(user.sessionId) },
        )
      : await fetch(`${url}/api${path}`, {
          method,
          headers: authHeaders(user.sessionId),
          body: JSON.stringify(params),
        });
  return { status: res.status, body: (await res.json()) as Answer<T>["body"] };
}

/**
 * The project's rules, in order, as names.
 * @returns The names.
 */
async function names(): Promise<string[]> {
  const { body } = await call<{ routingRules: SerializedRoutingRule[] }>(
    "GET",
    "/routing-rules",
    universe.luigi,
    { limit: 100 },
  );
  return body.routingRules.map((r) => r.name);
}

/**
 * The newest audit row for an action.
 * @param action - The action name.
 * @returns The row.
 */
async function lastAudit(action: string) {
  const [row] = await api.db.db
    .select()
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.action, action),
        eq(auditLogs.projectId, universe.projectId),
      ),
    )
    .orderBy(desc(auditLogs.id))
    .limit(1);
  return row;
}

describe("routing-rule:*", () => {
  test("connecting Linear seeded the two prefix rules, and every member reads them", async () => {
    const { status, body } = await call<{
      routingRules: SerializedRoutingRule[];
      pagination: { total: number };
    }>("GET", "/routing-rules", universe.toad);
    expect(status).toBe(200);
    expect(
      body.routingRules.map((r) => [r.position, r.name, r.match, r.role]),
    ).toEqual([
      [0, "/manage", { promptPrefix: "/manage" }, "manager"],
      [1, "/work", { promptPrefix: "/work" }, "worker"],
    ]);
    expect(body.pagination.total).toBe(2);
    const outsider = await call("GET", "/routing-rules", universe.bowser);
    expect(outsider.status).toBe(403);
  });

  test("an admin adds a rule at the end, normalizing a pinned remote", async () => {
    const { status, body } = await call<{ routingRule: SerializedRoutingRule }>(
      "PUT",
      "/routing-rule",
      universe.peach,
      {
        name: "PRDs",
        role: "manager",
        match: { labels: ["PRD"], teamKeys: ["ENG"], hasParent: false },
        repository: "git@github.com:acme/web.git",
      },
    );
    expect(status).toBe(200);
    expect(body.routingRule).toMatchObject({
      position: 2,
      name: "PRDs",
      role: "manager",
      enabled: true,
      match: { labels: ["PRD"], teamKeys: ["ENG"], hasParent: false },
      repository: "github.com/acme/web",
    });
    const audit = await lastAudit("routing-rule:create");
    expect(audit.targetType).toBe("routing_rule");
    expect(audit.targetPath).toBe("PRDs");
    expect(await names()).toEqual(["/manage", "/work", "PRDs"]);
  });

  test("a match field outside the schema, a bad prefix, and a bad role are refused", async () => {
    for (const body of [
      { name: "x", role: "worker", match: { assignee: "me" } },
      { name: "x", role: "worker", match: { promptPrefix: "manage" } },
      { name: "x", role: "boss" },
      { name: "", role: "worker" },
    ]) {
      const res = await call("PUT", "/routing-rule", universe.peach, body);
      expect(res.status, JSON.stringify(body)).toBe(406);
    }
  });

  test("members and outsiders cannot change rules", async () => {
    const [rule] = (
      await call<{ routingRules: SerializedRoutingRule[] }>(
        "GET",
        "/routing-rules",
        universe.peach,
      )
    ).body.routingRules;
    for (const user of [universe.mario, universe.toad, universe.bowser]) {
      expect(
        (
          await call("PUT", "/routing-rule", user, {
            name: "Mine",
            role: "worker",
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await call("POST", `/routing-rule/${rule.id}`, user, {
            enabled: false,
          })
        ).status,
      ).toBe(403);
      expect(
        (await call("DELETE", `/routing-rule/${rule.id}`, user)).status,
      ).toBe(403);
      expect(
        (
          await call("POST", "/routing-rules/order", user, {
            ids: [rule.id],
          })
        ).status,
      ).toBe(403);
    }
  });

  test("an edit replaces the match whole, clears a pin with null, and disables", async () => {
    const rules = (
      await call<{ routingRules: SerializedRoutingRule[] }>(
        "GET",
        "/routing-rules",
        universe.peach,
      )
    ).body.routingRules;
    const prd = rules.find((r) => r.name === "PRDs")!;
    const { status, body } = await call<{ routingRule: SerializedRoutingRule }>(
      "POST",
      `/routing-rule/${prd.id}`,
      universe.peach,
      { match: { origin: "mention" }, repository: null, enabled: false },
    );
    expect(status).toBe(200);
    expect(body.routingRule).toMatchObject({
      match: { origin: "mention" },
      repository: null,
      enabled: false,
    });
    const audit = await lastAudit("routing-rule:edit");
    expect(audit.before).toMatchObject({ enabled: true });
    expect(audit.after).toMatchObject({ enabled: false });

    const elsewhere = await call(
      "POST",
      `/routing-rule/${prd.id}`,
      universe.bowser,
      { projectId: universe.bowser.projectId, enabled: true },
    );
    expect(elsewhere.status).toBe(404);
  });

  test("a reorder must name every rule exactly once", async () => {
    const rules = (
      await call<{ routingRules: SerializedRoutingRule[] }>(
        "GET",
        "/routing-rules",
        universe.peach,
      )
    ).body.routingRules;
    const ids = rules.map((r) => r.id);
    for (const bad of [
      ids.slice(1),
      [...ids, ids[0]],
      [...ids.slice(1), 99999],
    ]) {
      const res = await call("POST", "/routing-rules/order", universe.peach, {
        ids: bad,
      });
      expect(res.status, JSON.stringify(bad)).toBe(406);
      expect(res.body.error?.key).toBe("ids");
    }
    const reversed = [...ids].reverse();
    const { status, body } = await call<{
      routingRules: SerializedRoutingRule[];
    }>("POST", "/routing-rules/order", universe.peach, { ids: reversed });
    expect(status).toBe(200);
    expect(body.routingRules.map((r) => [r.id, r.position])).toEqual(
      reversed.map((id, position) => [id, position]),
    );
    expect(await names()).toEqual(["PRDs", "/work", "/manage"]);
  });

  test("a delete moves the later rules up, and the list pages", async () => {
    const rules = (
      await call<{ routingRules: SerializedRoutingRule[] }>(
        "GET",
        "/routing-rules",
        universe.peach,
      )
    ).body.routingRules;
    const { status } = await call(
      "DELETE",
      `/routing-rule/${rules[0].id}`,
      universe.peach,
    );
    expect(status).toBe(200);
    expect((await lastAudit("routing-rule:delete")).targetPath).toBe("PRDs");
    const page = await call<{
      routingRules: SerializedRoutingRule[];
      pagination: Record<string, number>;
    }>("GET", "/routing-rules", universe.luigi, { limit: 1, page: 2 });
    expect(page.body.routingRules.map((r) => [r.name, r.position])).toEqual([
      ["/manage", 1],
    ]);
    expect(page.body.pagination).toEqual({
      page: 2,
      limit: 1,
      total: 2,
      pages: 2,
    });
  });
});

describe("project:settings-edit", () => {
  test("members read routing resolved with its defaults", async () => {
    const { body } = await call<{ settings: { routing: unknown } }>(
      "GET",
      "/project/settings",
      universe.toad,
    );
    expect(body.settings.routing).toEqual({
      queueTimeoutMs: 1_800_000,
      stickyTimeoutMs: 600_000,
      offerTtlMs: 10_000,
      repositoryConfidence: 0.7,
      stopGraceMs: 30_000,
      maxReviewRounds: 3,
    });
  });

  test("an admin changes a key, null restores its default, and bounds hold", async () => {
    const changed = await call<{
      settings: {
        routing: { stickyTimeoutMs: number; repositoryConfidence: number };
      };
    }>("POST", "/project/settings", universe.peach, {
      routing: { stickyTimeoutMs: 0, repositoryConfidence: 0.9 },
    });
    expect(changed.status).toBe(200);
    expect(changed.body.settings.routing).toMatchObject({
      stickyTimeoutMs: 0,
      repositoryConfidence: 0.9,
      queueTimeoutMs: 1_800_000,
    });
    const audit = await lastAudit("project:settings-edit");
    expect(audit.targetPath).toBe("routing");

    const reset = await call<{
      settings: { routing: { stickyTimeoutMs: number } };
    }>("POST", "/project/settings", universe.peach, {
      routing: { stickyTimeoutMs: null },
    });
    expect(reset.body.settings.routing.stickyTimeoutMs).toBe(600_000);

    for (const routing of [
      { offerTtlMs: 1 },
      { repositoryConfidence: 2 },
      { queueTimeoutMs: 1 },
      { unknownKey: 1 },
    ]) {
      const res = await call("POST", "/project/settings", universe.peach, {
        routing,
      });
      expect(res.status, JSON.stringify(routing)).toBe(406);
    }
    expect(
      (
        await call("POST", "/project/settings", universe.mario, {
          routing: { offerTtlMs: 5_000 },
        })
      ).status,
    ).toBe(403);
  });
});
