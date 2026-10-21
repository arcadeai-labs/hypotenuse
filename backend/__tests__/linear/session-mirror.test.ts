import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { api } from "keryx";
import {
  deliverSession,
  enqueueActivity,
  type OutboundContent,
} from "../../ops/ActivityOutboxOps";
import {
  type AgentSessionEventPayload,
  upsertFromWebhook,
} from "../../ops/AgentSessionOps";
import { LINEAR_OPERATIONS } from "../../ops/linear/operations";
import type { AgentSession } from "../../schema/agent_sessions";
import {
  buildTestUniverse,
  HOOK_TIMEOUT,
  runAction,
  type TestUniverse,
} from "../setup";
import { useFinear } from "./finear";
import { appToken, integrationRow } from "./helpers";
import { agentSessionEvent, webhookSession } from "./inject";
import {
  finearSession,
  mirroredQuietly,
  recordedEvent,
  sessionRow,
} from "./sessions";

/**
 * `agent_sessions.status` follows Linear's: it is derived from the last
 * activity, Linear's own reports arrive on every webhook, and Hypotenuse never
 * sets one. One session is walked through every status the agent can cause,
 * comparing the mirror with finear at each step.
 */

let universe: TestUniverse;
beforeAll(async () => {
  universe = await buildTestUniverse();
}, HOOK_TIMEOUT);
afterAll(async () => {
  await api.stop();
}, HOOK_TIMEOUT);

const linear = useFinear();

let token: string;
let appUserId: string;
beforeAll(async () => {
  await linear.install(universe.projectId, universe.peach.sessionId);
  appUserId = (await integrationRow(universe.projectId)).externalAppUserId;
  token = await appToken(universe.projectId);
}, HOOK_TIMEOUT);

/**
 * Send one activity and compare the mirror with finear.
 * @param session - The session.
 * @param content - What to send.
 * @returns The status both agree on.
 */
async function after(
  session: AgentSession,
  content: OutboundContent,
): Promise<string> {
  await api.db.db.transaction((tx) => enqueueActivity(tx, session.id, content));
  await deliverSession(session.id);
  return agreed(session);
}

/**
 * The session's status, asserting the mirror and finear agree on it.
 * @param session - The session.
 * @returns The status.
 */
async function agreed(session: AgentSession): Promise<string> {
  const mirror = (await sessionRow(session.externalSessionId))?.status;
  const finear = (await finearSession(linear, token, session.externalSessionId))
    .status;
  expect(String(mirror)).toBe(finear);
  return String(mirror);
}

/**
 * A person types into the session; the `prompted` webhook is processed, but
 * nothing is sent back yet.
 * @param session - The session.
 * @param body - What they type.
 */
async function personPrompts(session: AgentSession, body: string) {
  await linear.control("/__test/agents/prompt", {
    sessionId: session.externalSessionId,
    body,
  });
  await recordedEvent(
    (e) =>
      e.action === "prompted" &&
      (e.payload as { agentActivity?: { content?: { body?: string } } })
        .agentActivity?.content?.body === body,
  );
  await runAction("triggers:process-pending", { graceMs: 0 });
}

describe("the session mirror", () => {
  test("LC-SES-04 LC-SES-05 LC-SES-06 LC-SES-07 LC-SES-08 LC-SES-11 status follows the last activity, in the mirror as in Linear", async () => {
    const session = await mirroredQuietly(
      linear,
      universe.projectId,
      appUserId,
      "Every status",
    );
    expect(await agreed(session)).toBe("pending");
    expect(await after(session, { type: "thought", body: "Looking" })).toBe(
      "active",
    );
    expect(
      await after(session, {
        type: "action",
        action: "Reading",
        parameter: "README.md",
      }),
    ).toBe("active");
    expect(
      await after(session, { type: "elicitation", body: "Which branch?" }),
    ).toBe("awaitingInput");

    // A person's answer: Linear reports `pending` on the webhook.
    await personPrompts(session, "main");
    expect(await agreed(session)).toBe("pending");
    // …and the interim reply it was answered with is now waiting to go.
    await deliverSession(session.id);
    expect(await agreed(session)).toBe("error");
    expect(
      (await sessionRow(session.externalSessionId))?.endedAt,
    ).not.toBeNull();

    await personPrompts(session, "please finish");
    expect((await sessionRow(session.externalSessionId))?.endedAt).toBeNull();
    // Replace the queued interim error with a real answer.
    const { failPending } = await import("../../ops/ActivityOutboxOps");
    await failPending(api.db.db, { agentSessionId: session.id }, "test");
    expect(await after(session, { type: "response", body: "Done." })).toBe(
      "complete",
    );
  });

  test("two events for a session nobody has mirrored yet, processed at once, make one row and both succeed", async () => {
    const integration = await integrationRow(universe.projectId);
    const payload = agentSessionEvent(
      {
        organizationId: integration.externalWorkspaceId,
        appUserId: integration.externalAppUserId,
      },
      { action: "created", agentSession: webhookSession() },
    ) as unknown as AgentSessionEventPayload;
    const results = await Promise.all(
      [0, 1].map(() =>
        api.db.db.transaction((tx) =>
          upsertFromWebhook(tx, integration, payload),
        ),
      ),
    );
    expect(results.map((r) => r.created).sort()).toEqual([false, true]);
    expect(results[0].session.id).toBe(results[1].session.id);
  });

  test("LC-SES-11 no operation Hypotenuse sends sets a status", () => {
    for (const op of LINEAR_OPERATIONS) {
      if (!op.query.trimStart().startsWith("mutation")) continue;
      // A status may be read back in a selection set, never sent as input.
      const inputs = op.query.slice(0, op.query.indexOf("{"));
      expect(inputs, op.name).not.toMatch(/status/i);
    }
  });
});
