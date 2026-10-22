import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { api, config } from "keryx";
import { NOT_PERMITTED_MESSAGE } from "../../middleware/daemonSessionScope";
import {
  changesThought,
  clearDispatchIntent,
  type DispatchIntent,
  dispatchedThought,
  dispatchInflightKey,
  writeDispatchIntent,
} from "../../ops/DispatchOps";
import { ackBody } from "../../ops/WorkItemOps";
import { auditLogs } from "../../schema/audit_logs";
import { triggerEvents } from "../../schema/trigger_events";
import { FINEAR_PRIMARY_KEY, useFinear } from "../linear/finear";
import { appToken, integrationRow } from "../linear/helpers";
import {
  activityRows,
  delegate,
  finearSession,
  recordedEvent,
  settle,
} from "../linear/sessions";
import {
  itemsOf,
  ScriptedDaemon,
  sessionById,
  withoutRunnerRateLimits,
} from "../routing/helpers";
import {
  authHeaders,
  buildTestUniverse,
  HOOK_TIMEOUT,
  type TestUniverse,
} from "../setup";
import {
  callTool,
  childrenOf,
  type Held,
  heldSession,
  sessionsOnIssue,
  subIssue,
} from "./dispatch-helpers";

/**
 * `daemon:dispatch` — a manager session handing an issue to a worker, driven
 * by a scripted daemon against finear: the delegation and the new session in
 * Linear, exactly one child row and one turn whichever way Linear's `created`
 * webhook races the dispatch, every guard, the parallel cap under
 * concurrency, and requesting changes.
 */

let universe: TestUniverse;
beforeAll(async () => {
  universe = await buildTestUniverse();
}, HOOK_TIMEOUT);
afterAll(async () => {
  await api.stop();
}, HOOK_TIMEOUT);

const linear = useFinear();
withoutRunnerRateLimits();

let savedRate = 0;
beforeAll(() => {
  savedRate = config.linear.requestsPerHour;
  config.linear.requestsPerHour = 3_600_000;
});
afterAll(() => {
  config.linear.requestsPerHour = savedRate;
});

let appUserId: string;
let mario: ScriptedDaemon;

beforeAll(async () => {
  await linear.install(universe.projectId, universe.peach.sessionId);
  appUserId = (await integrationRow(universe.projectId)).externalAppUserId;
  mario = await ScriptedDaemon.register(
    universe.url,
    universe.mario,
    universe.projectId,
    "dispatch-mario",
    { limits: { maxParallelJobs: 30 } },
  );
  await mario.heartbeat();
}, HOOK_TIMEOUT);

/**
 * A new manager session Mario's runner holds.
 * @param title - Its issue's title.
 * @returns The session.
 */
function managerSession(title: string): Promise<Held> {
  return heldSession(linear, appUserId, mario, title, "manager");
}

/**
 * `hypotenuse_dispatch` as Mario's runner.
 * @param manager - The calling session.
 * @param input - The tool input.
 * @returns The answer.
 */
function dispatch(manager: Held, input: Record<string, unknown>) {
  return callTool(
    universe.url,
    mario,
    "hypotenuse_dispatch",
    manager.sessionId,
    input,
  );
}

/**
 * Change the project's settings as Peach, the admin.
 * @param body - The sections to change.
 * @returns The response.
 */
function editSettings(body: Record<string, unknown>): Promise<Response> {
  return fetch(`${universe.url}/api/project/settings`, {
    method: "POST",
    headers: authHeaders(universe.peach.sessionId),
    body: JSON.stringify({ projectId: universe.projectId, ...body }),
  });
}

/**
 * Deliver what finear has queued and process it.
 */
async function deliverAndSettle(): Promise<void> {
  await linear.drain();
  await settle();
}

/**
 * The bodies of a session's outbound thoughts.
 * @param agentSessionId - The session.
 * @returns The bodies, in order.
 */
async function thoughts(agentSessionId: number): Promise<string[]> {
  return (await activityRows(agentSessionId))
    .filter((r) => r.direction === "outbound" && r.contentType === "thought")
    .map((r) => (r.content as { body: string }).body);
}

/**
 * The issue's delegate in finear.
 * @param identifier - The issue.
 * @returns The delegate's id, or null.
 */
async function delegateOf(identifier: string): Promise<string | null> {
  const reply = await linear.graphql<{
    issue: { delegate: { id: string } | null };
  }>(
    FINEAR_PRIMARY_KEY,
    `query($id: String!) { issue(id: $id) { delegate { id } } }`,
    {
      id: identifier,
    },
  );
  return reply.data!.issue.delegate?.id ?? null;
}

describe("a dispatch", () => {
  test("LC-SES-02 LC-DEL-01 LC-ACT-11 delegates the issue to the app, starts a Linear session, and records one worker child with one turn", async () => {
    const manager = await managerSession("Plan saved carts");
    const issue = await subIssue(
      universe.url,
      mario,
      manager,
      "Persist the cart",
    );
    const answer = await dispatch(manager, {
      issue,
      instructions: "Use the existing session store.",
    });
    expect(answer.status).toBe(200);
    const data = answer.body.result!.data.dispatch as {
      agentSessionId: number;
      externalSessionId: string;
      issueIdentifier: string;
      mode: string;
      reviewRound: number;
    };
    expect(data).toMatchObject({
      issueIdentifier: issue,
      mode: "new",
      reviewRound: 0,
    });
    expect(answer.body.result!.text).toContain("review turn");

    expect(await delegateOf(issue)).toBe(appUserId);
    const linearSession = await finearSession(
      linear,
      await appToken(universe.projectId),
      data.externalSessionId,
    );
    expect(linearSession.status).toBeDefined();

    // LC-SES-23 Linear's own `created` for the new session arrives after the
    // dispatch recorded it.
    await deliverAndSettle();
    const rows = await sessionsOnIssue(issue);
    expect(rows).toHaveLength(1);
    const [child] = rows;
    expect(child).toMatchObject({
      id: data.agentSessionId,
      role: "worker",
      parentAgentSessionId: manager.sessionId,
      dispatchMode: "new",
      reviewRound: 0,
      origin: "proactive",
    });
    const items = await itemsOf(child.id);
    expect(items.map((i) => [i.kind, i.role])).toEqual([
      ["dispatch", "worker"],
    ]);
    expect(items[0].payload).toEqual({
      dispatch: {
        mode: "new",
        reviewRound: 0,
        instructions: "Use the existing session store.",
        agentPreference: null,
        dispatchedBy: manager.sessionId,
      },
    });
    const childThoughts = await thoughts(child.id);
    const managerRow = await sessionById(manager.sessionId);
    expect(childThoughts.filter((t) => t.startsWith("Dispatched by"))).toEqual([
      dispatchedThought(managerRow.issueUrl),
    ]);
    expect(childThoughts).not.toContain(ackBody(issue));

    const created = await api.db.db
      .select()
      .from(triggerEvents)
      .where(eq(triggerEvents.outcome, "duplicate_of_dispatch"));
    expect(
      created.some(
        (e) =>
          (e.payload as { agentSession?: { id?: string } }).agentSession?.id ===
          data.externalSessionId,
      ),
    ).toBe(true);

    const managerActions = (await activityRows(manager.sessionId)).filter(
      (r) => r.contentType === "action",
    );
    expect(
      managerActions.map((r) => (r.content as { action: string }).action),
    ).toContain("Dispatched");

    const [audit] = await api.db.db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.action, "agent:dispatch"),
          eq(auditLogs.targetPath, String(child.id)),
        ),
      );
    expect(audit.userId).toBe(universe.mario.userId);
    expect(audit.metadata).toMatchObject({
      managerSessionId: manager.sessionId,
      issue,
      mode: "new",
    });
    expect(
      await api.redis.redis.hlen(dispatchInflightKey(manager.sessionId)),
    ).toBe(0);

    // The worker's turn carries the dispatch.
    await settle();
    const assignment = await mario.claim([items[0].id]);
    expect(assignment?.kind).toBe("dispatch");
    expect(assignment?.role).toBe("worker");
    expect(assignment?.dispatch).toMatchObject({
      mode: "new",
      instructions: "Use the existing session store.",
      parent: {
        agentSessionId: manager.sessionId,
        issueIdentifier: manager.issue.identifier,
      },
    });
  });

  test("LC-SES-23 when Linear's created arrives before the dispatch recorded it, the webhook records it, once", async () => {
    const manager = await managerSession("Plan the export");
    const issue = await subIssue(universe.url, mario, manager, "CSV export");
    // finear starts the session and takes the delegation, but its answer to
    // the delegation is lost: the dispatch cannot record the child itself.
    linear.fault({
      kind: "drop",
      match: (r) => r.operationName === "UpdateIssue",
    });
    const lost = await dispatch(manager, { issue });
    expect(lost.status).not.toBe(200);
    expect(await sessionsOnIssue(issue)).toHaveLength(0);

    await deliverAndSettle();
    const rows = await sessionsOnIssue(issue);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      role: "worker",
      parentAgentSessionId: manager.sessionId,
      dispatchMode: "new",
    });
    const items = await itemsOf(rows[0].id);
    expect(items.map((i) => i.kind)).toEqual(["dispatch"]);
    // The event log links the adopted session and the dispatch's turn.
    const [adoption] = await api.db.db
      .select()
      .from(triggerEvents)
      .where(
        and(
          eq(triggerEvents.agentSessionId, rows[0].id),
          eq(triggerEvents.action, "created"),
        ),
      );
    expect(adoption).toMatchObject({
      outcome: "handled",
      workItemId: items[0].id,
      summary: expect.stringContaining("Adopted as the worker session"),
    });
    const childThoughts = await thoughts(rows[0].id);
    expect(
      childThoughts.filter((t) => t.startsWith("Dispatched by")),
    ).toHaveLength(1);
    expect(childThoughts).not.toContain(ackBody(issue));

    // The manager tries again: the issue is already dispatched.
    const again = await dispatch(manager, { issue });
    expect(again.status).toBe(406);
    expect(await sessionsOnIssue(issue)).toHaveLength(1);
  });
});

describe("the guards", () => {
  let manager: Held;
  beforeAll(async () => {
    manager = await managerSession("Plan the guards");
  });

  test("a worker session cannot dispatch, with the uniform refusal", async () => {
    const worker = await heldSession(
      linear,
      appUserId,
      mario,
      "Implement a thing",
      "worker",
    );
    const issue = await subIssue(universe.url, mario, manager, "Guarded");
    const answer = await callTool(
      universe.url,
      mario,
      "hypotenuse_dispatch",
      worker.sessionId,
      { issue },
    );
    expect(answer.status).toBe(403);
    expect(answer.body.error?.message).toBe(NOT_PERMITTED_MESSAGE);
    expect(await sessionsOnIssue(issue)).toHaveLength(0);
  });

  test("another project's runner cannot dispatch for this session", async () => {
    const bowser = await ScriptedDaemon.register(
      universe.url,
      universe.bowser,
      universe.bowser.projectId,
      "dispatch-bowser",
    );
    const issue = await subIssue(universe.url, mario, manager, "Not Bowser's");
    const answer = await callTool(
      universe.url,
      bowser,
      "hypotenuse_dispatch",
      manager.sessionId,
      { issue },
    );
    expect(answer.status).toBe(403);
    expect(answer.body.error?.message).toBe(NOT_PERMITTED_MESSAGE);
  });

  test("a manager cannot dispatch its own issue", async () => {
    const answer = await dispatch(manager, { issue: manager.issue.identifier });
    expect(answer.status).toBe(406);
    expect(answer.body.error?.message).toContain(
      "the issue you are working on",
    );
  });

  test("an issue already under way cannot be dispatched again", async () => {
    const issue = await subIssue(universe.url, mario, manager, "Once only");
    expect((await dispatch(manager, { issue })).status).toBe(200);
    const again = await dispatch(manager, { issue });
    expect(again.status).toBe(406);
    expect(again.body.error?.message).toContain("already dispatched");
    await deliverAndSettle();
    expect(await sessionsOnIssue(issue)).toHaveLength(1);
  });

  test("while one manager dispatches an issue, another cannot, and a person's own session there is not taken as the worker", async () => {
    const other = await managerSession("Another plan");
    const issue = await subIssue(universe.url, mario, manager, "Contested");
    const integration = await integrationRow(universe.projectId);
    const issueId = (
      await linear.graphql<{ issue: { id: string } }>(
        FINEAR_PRIMARY_KEY,
        `query($id: String!) { issue(id: $id) { id } }`,
        { id: issue },
      )
    ).data!.issue.id;
    // The other manager's dispatch is in flight: reserved, its Linear session
    // not yet known.
    const intent: DispatchIntent = {
      managerSessionId: other.sessionId,
      projectId: universe.projectId,
      integrationId: integration.id,
      externalIssueId: issueId,
      mode: "new",
      reviewRound: 0,
      instructions: null,
      agentPreference: null,
      preferredUserId: null,
      parentIssueIdentifier: other.issue.identifier,
      parentIssueUrl: null,
      externalSessionId: null,
    };
    await writeDispatchIntent(intent);

    const refused = await dispatch(manager, { issue });
    expect(refused.status).toBe(406);
    expect(refused.body.error?.message).toContain("another planning session");

    // A person delegates the issue meanwhile: an ordinary session.
    const externalSessionId = await delegate(linear, issueId, appUserId);
    await recordedEvent(
      (e) =>
        (e.payload as { agentSession?: { id?: string } }).agentSession?.id ===
        externalSessionId,
    );
    await settle();
    const [mine] = await sessionsOnIssue(issue);
    expect(mine).toMatchObject({ parentAgentSessionId: null });
    expect(await thoughts(mine.id)).toContain(ackBody(issue));

    await clearDispatchIntent(intent);
  });

  test("changes on an issue never dispatched are refused", async () => {
    const issue = await subIssue(universe.url, mario, manager, "Never sent");
    const answer = await dispatch(manager, { issue, mode: "changes" });
    expect(answer.status).toBe(406);
    expect(answer.body.error?.message).toContain('mode "new"');
  });
});

describe("the parallel cap", () => {
  test("cap × 4 concurrent dispatches from one turn: exactly cap succeed", async () => {
    const cap = 2;
    const edited = await editSettings({
      manager: { maxParallelDispatch: cap },
    });
    expect(edited.status).toBe(200);
    expect(
      ((await edited.json()) as { settings: { manager: unknown } }).settings
        .manager,
    ).toEqual({ canCompleteIssues: false, maxParallelDispatch: cap });

    const manager = await managerSession("Plan a burst");
    const issues: string[] = [];
    for (let i = 0; i < cap * 4; i++) {
      issues.push(await subIssue(universe.url, mario, manager, `Burst ${i}`));
    }
    const answers = await Promise.all(
      issues.map((issue) => dispatch(manager, { issue })),
    );
    const statuses = answers.map((a) => a.status);
    expect(statuses.filter((s) => s === 200)).toHaveLength(cap);
    expect(statuses.filter((s) => s === 406)).toHaveLength(cap * 3);
    await deliverAndSettle();
    expect(await childrenOf(manager.sessionId)).toHaveLength(cap);
    const refused = answers.find((a) => a.status === 406)!;
    expect(refused.body.error?.message).toContain("under way");

    await editSettings({ manager: { maxParallelDispatch: null } });
  });
});

describe("requesting changes", () => {
  test("sends a finished worker back to its own session, sticky, one round up, until the round limit", async () => {
    const manager = await managerSession("Plan the review");
    const issue = await subIssue(universe.url, mario, manager, "Rate limits");
    const first = await dispatch(manager, { issue });
    expect(first.status).toBe(200);
    await deliverAndSettle();
    const [child] = await sessionsOnIssue(issue);
    const [turn] = await itemsOf(child.id);
    const assignment = await mario.claim([turn.id]);
    expect(assignment).not.toBeNull();
    await mario.events(turn.id, [
      { type: "response", body: "Added the limiter." },
    ]);
    expect((await mario.complete(turn.id, "completed")).status).toBe(200);

    // Changes while the worker runs are refused; once it ends, accepted.
    const changes = await dispatch(manager, {
      issue,
      mode: "changes",
      instructions: "Cover the burst case with a test.",
    });
    expect(changes.status).toBe(200);
    expect(changes.body.result!.data.dispatch).toMatchObject({
      agentSessionId: child.id,
      mode: "changes",
      reviewRound: 1,
    });
    const after = (await sessionsOnIssue(issue))[0];
    expect(after).toMatchObject({ reviewRound: 1, dispatchMode: "changes" });
    const items = await itemsOf(child.id);
    const sent = items.at(-1)!;
    expect(sent).toMatchObject({
      kind: "prompt",
      status: "queued",
      stickyRunnerId: mario.id,
      payload: {
        dispatch: {
          mode: "changes",
          reviewRound: 1,
          instructions: "Cover the burst case with a test.",
        },
      },
    });
    expect(await thoughts(child.id)).toContain(
      changesThought("Cover the burst case with a test."),
    );
    // LC-ACT-08 No prompt activity is faked into the worker's session.
    expect(
      (await activityRows(child.id)).filter(
        (r) => r.direction === "outbound" && r.contentType === "prompt",
      ),
    ).toHaveLength(0);

    // Still running: a second request is refused.
    const busy = await dispatch(manager, { issue, mode: "changes" });
    expect(busy.status).toBe(406);
    expect(busy.body.error?.message).toContain("still working");

    // The round limit.
    const settings = await editSettings({ routing: { maxReviewRounds: 1 } });
    expect(settings.status).toBe(200);
    await settle();
    const claimed = await mario.claim([sent.id]);
    expect(claimed?.dispatch).toMatchObject({
      mode: "changes",
      instructions: "Cover the burst case with a test.",
    });
    await mario.events(sent.id, [{ type: "response", body: "Tested." }]);
    await mario.complete(sent.id, "completed");
    const limited = await dispatch(manager, { issue, mode: "changes" });
    expect(limited.status).toBe(406);
    expect(limited.body.error?.message).toContain("Review round limit");

    await editSettings({ routing: { maxReviewRounds: null } });
  });
});
