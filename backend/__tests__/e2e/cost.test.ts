import { beforeAll, describe, expect, test } from "bun:test";
import { asc, eq } from "drizzle-orm";
import { api } from "keryx";
import { costRecords } from "../../schema/cost_records";
import { until } from "../daemon/helpers";
import { HOOK_TIMEOUT } from "../setup";
import { useE2E } from "./harness";

/**
 * Cost attribution across every process: the real daemon runs the fake agent
 * playing `costed`, which reports its session's cumulative cost and each
 * prompt's tokens. The first turn opens a new ACP session and costs all it
 * reports; the follow-up resumes that session and costs only what it spent
 * past the figure the daemon recorded at the first turn's end. Each lands as
 * a cost record attributed to the runner and its owner.
 */

const e2e = useE2E();

beforeAll(async () => {
  await e2e.daemon(e2e.universe.mario, "cost-laptop", { scenario: "costed" });
}, HOOK_TIMEOUT);

/**
 * A session's cost records, oldest claim first.
 * @param agentSessionId - The session.
 * @returns Its rows.
 */
async function recordsOf(agentSessionId: number) {
  return api.db.db
    .select()
    .from(costRecords)
    .where(eq(costRecords.agentSessionId, agentSessionId))
    .orderBy(asc(costRecords.claimedAt));
}

describe("cost attribution end to end", () => {
  test("a turn and its resumed follow-up each record what they spent", async () => {
    const { externalSessionId, agentSessionId } =
      await e2e.delegate("Price the work");
    await e2e.linearSession(externalSessionId, (s) => s.status === "complete");
    await until(async () => (await recordsOf(agentSessionId)).length === 1);

    await e2e.say(externalSessionId, "And once more");
    await until(async () => (await recordsOf(agentSessionId)).length === 2);

    const records = await recordsOf(agentSessionId);
    expect(
      records.map((r) => ({
        kind: r.kind,
        ending: r.ending,
        runnerName: r.runnerName,
        runnerUserId: r.runnerUserId,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        costUsd: r.costUsd,
      })),
    ).toEqual([
      {
        kind: "session_created",
        ending: "completed",
        runnerName: "cost-laptop",
        runnerUserId: e2e.universe.mario.userId,
        inputTokens: 1200,
        outputTokens: 300,
        costUsd: 1.25,
      },
      {
        kind: "prompt",
        ending: "completed",
        runnerName: "cost-laptop",
        runnerUserId: e2e.universe.mario.userId,
        inputTokens: 50,
        outputTokens: 10,
        costUsd: 0.35,
      },
    ]);
  });
});
