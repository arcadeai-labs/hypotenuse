import { beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { api } from "keryx";
import { agentSessions } from "../../schema/agent_sessions";
import { triggerEvents } from "../../schema/trigger_events";
import { type DaemonHome, outbound, until } from "../daemon/helpers";
import { deliver } from "../linear/inject";
import { itemsOf } from "../routing/helpers";
import { HOOK_TIMEOUT } from "../setup";
import { bodies, useE2E } from "./harness";

/**
 * Linear delivers at least once: a delivery it thinks failed is sent again
 * with the same `Linear-Delivery`, and the same event can arrive as a second
 * delivery. End to end, with a real daemon running the turn, neither makes a
 * second session, a second turn, or a second acknowledgement: the person
 * sees one thought saying the agent is on it, one turn's work, and one
 * answer.
 */

const e2e = useE2E();

let home: DaemonHome;
beforeAll(async () => {
  home = await e2e.daemon(e2e.universe.mario, "dedupe-laptop", {
    scenario: "happy",
  });
}, HOOK_TIMEOUT);

/**
 * Whether a recorded delivery is about a session.
 * @param payload - The delivery's body.
 * @param externalSessionId - Linear's session id.
 * @returns True when it names that session.
 */
function forSession(
  payload: Record<string, unknown>,
  externalSessionId: string,
): boolean {
  return (
    (payload as { agentSession?: { id?: string } }).agentSession?.id ===
    externalSessionId
  );
}

describe("duplicate webhook deliveries", () => {
  test("a retried delivery and a re-sent event make one session, one turn, and one acknowledgement", async () => {
    const { externalSessionId, agentSessionId, issue } =
      await e2e.delegate("Deduplicate me");
    const original = await until(async () => {
      const rows = await api.db.db
        .select()
        .from(triggerEvents)
        .where(
          and(
            eq(triggerEvents.eventType, "AgentSessionEvent"),
            eq(triggerEvents.action, "created"),
          ),
        );
      return rows.find((r) => forSession(r.payload, externalSessionId));
    });

    // Linear's retry: the same delivery, byte for byte in meaning, same id.
    const retry = await deliver(e2e.universe.url, original.payload, {
      deliveryId: original.deliveryId,
    });
    expect(retry.status).toBe(200);
    // The same event again under a delivery id of its own.
    const again = await deliver(e2e.universe.url, original.payload);
    expect(again.status).toBe(200);

    const view = await e2e.linearSession(
      externalSessionId,
      (s) => s.status === "complete",
    );
    // Both re-deliveries were processed (or refused as recorded) before the
    // assertions: no unprocessed row remains for this session.
    await until(async () => {
      const rows = await api.db.db
        .select()
        .from(triggerEvents)
        .where(eq(triggerEvents.eventType, "AgentSessionEvent"));
      return rows
        .filter((r) => forSession(r.payload, externalSessionId))
        .every((r) => r.processedAt !== null);
    });

    const sessions = await api.db.db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.externalSessionId, externalSessionId));
    expect(sessions.map((s) => s.id)).toEqual([agentSessionId]);
    const items = await itemsOf(agentSessionId);
    expect(items.map((i) => [i.kind, i.status, i.runnerId])).toEqual([
      ["session_created", "completed", home.runner.id],
    ]);
    const ack = `On it — finding a runner for ${issue.identifier}.`;
    expect(
      (await outbound(agentSessionId)).filter(
        (r) => (r.content as { body?: string }).body === ack,
      ),
    ).toHaveLength(1);
    expect(
      bodies(view, "AgentActivityThoughtContent").filter((b) => b === ack),
    ).toHaveLength(1);
    expect(bodies(view, "AgentActivityResponseContent")).toHaveLength(1);
    // The agent ran once.
    expect(
      home
        .received()
        .filter(
          (r) =>
            r.method === "session/prompt" &&
            r.session === String(agentSessionId),
        ),
    ).toHaveLength(1);
  }, 60_000);
});
