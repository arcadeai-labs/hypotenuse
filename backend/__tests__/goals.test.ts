import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { desc, eq } from "drizzle-orm";
import { api } from "keryx";
import { auditLogs } from "../schema/audit_logs";
import { goals } from "../schema/goals";
import {
  type AgentStage,
  buildAgentStage,
  clearLoopQueues,
} from "./agent/harness";
import { botCalls, sentSystem, toolOutputs } from "./prompt/harness";
import { call, HOOK_TIMEOUT } from "./setup";

/**
 * Goals: people create and change them (audited); the bot reads its active
 * goals in its prompt and changes only their status and notes.
 */
let stage: AgentStage;

beforeAll(async () => {
  stage = await buildAgentStage("anthropic");
}, HOOK_TIMEOUT);

afterEach(async () => {
  await clearLoopQueues();
  expect(stage.models.expectationFailures).toEqual([]);
  stage.models.reset();
});

afterAll(async () => {
  await stage.models.stop();
  await api.stop();
}, HOOK_TIMEOUT);

/**
 * Create a goal for the stage's bot as Peach.
 * @param body - The `goal:create` inputs.
 * @returns The goal's id.
 */
async function createGoal(body: Record<string, unknown>): Promise<number> {
  const res = await call<{ goal: { id: number } }>(
    stage.u.url,
    stage.u.peach,
    "PUT",
    `/project/${stage.u.projectId}/bot/${stage.botId}/goal`,
    body,
  );
  if (res.status !== 200) throw new Error(JSON.stringify(res.body));
  return res.body.goal.id;
}

describe("goal_update", () => {
  test("changes only status and notes, marks a review done, and the prompt follows", async () => {
    const id = await createGoal({
      title: "Ship the drawbridge",
      description: "It opens and closes.",
      priority: "high",
      reviewEverySeconds: 3_600,
    });
    await api.db.db
      .update(goals)
      .set({ createdAt: new Date(Date.now() - 2 * 3_600_000) })
      .where(eq(goals.id, id));

    stage.models.play([
      {
        toolCalls: [{ name: "goal_list", input: {} }],
        expect: {
          systemIncludes: `Review goal ${id} (\\"Ship the drawbridge\\")`,
        },
      },
      {
        toolCalls: [
          {
            name: "goal_update",
            input: {
              goalId: id,
              notes: "Hinges ordered.",
              // Not inputs of goal_update: dropped by its schema.
              title: "Retitled by the bot",
              priority: "low",
            },
          },
        ],
      },
      {
        toolCalls: [
          { name: "goal_update", input: { goalId: id, status: "achieved" } },
        ],
      },
      {
        toolCalls: [
          { name: "goal_update", input: { goalId: 999_999, notes: "x" } },
        ],
      },
      { toolCalls: [{ name: "reply_and_wait", input: { text: "Done." } }] },
    ]);
    const res = await call<{ conversation: { id: number } }>(
      stage.u.url,
      stage.u.peach,
      "PUT",
      `/project/${stage.u.projectId}/bot/${stage.botId}/conversation`,
      { text: "How is the drawbridge?" },
    );
    const { runTicks } = await import("./agent/harness");
    await runTicks();
    const conversationId = res.body.conversation.id;

    const [listed] = await toolOutputs(stage, conversationId, "goal_list");
    expect(listed.goals).toEqual([
      expect.objectContaining({
        id,
        title: "Ship the drawbridge",
        reviewDue: true,
      }),
    ]);
    const updates = await toolOutputs(stage, conversationId, "goal_update");
    expect(updates[0]).toEqual({
      id,
      status: "active",
      notes: "Hinges ordered.",
    });
    expect(updates[1]).toEqual({
      id,
      status: "achieved",
      notes: "Hinges ordered.",
    });
    expect(updates[2]).toMatchObject({
      is_error: true,
      error_type: "not_found",
    });

    const [row] = await api.db.db.select().from(goals).where(eq(goals.id, id));
    expect(row).toMatchObject({
      title: "Ship the drawbridge",
      priority: "high",
      status: "achieved",
      notes: "Hinges ordered.",
    });
    expect(row.lastReviewedAt).not.toBeNull();
    // An achieved goal leaves the prompt.
    expect(sentSystem(stage)).not.toContain("Ship the drawbridge");

    // The bot's edits are in the transcript, not the audit log.
    const audits = await api.db.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, "goal:edit"));
    expect(audits).toHaveLength(0);
  });

  test("another bot's goal is not found", async () => {
    const other = await call<{ bot: { id: number } }>(
      stage.u.url,
      stage.u.peach,
      "PUT",
      `/project/${stage.u.projectId}/bot`,
      { name: "Kamek", persona: "A wizard." },
    );
    const theirs = await call<{ goal: { id: number } }>(
      stage.u.url,
      stage.u.peach,
      "PUT",
      `/project/${stage.u.projectId}/bot/${other.body.bot.id}/goal`,
      { title: "Their goal" },
    );
    const id = await botCalls(stage, [
      [
        {
          name: "goal_update",
          input: { goalId: theirs.body.goal.id, status: "dropped" },
        },
      ],
    ]);
    const [out] = await toolOutputs(stage, id, "goal_update");
    expect(out).toMatchObject({ is_error: true, error_type: "not_found" });
  });
});

describe("the human actions", () => {
  test("create, edit, view, list, delete — audited, paginated, gated by the bot's lists", async () => {
    const guarded = await call<{ bot: { id: number } }>(
      stage.u.url,
      stage.u.peach,
      "PUT",
      `/project/${stage.u.projectId}/bot`,
      {
        name: "Guarded",
        persona: "x",
        accessRead: ["operators", "viewers"],
        accessWrite: ["operators"],
      },
    );
    const botId = guarded.body.bot.id;
    const base = `/project/${stage.u.projectId}`;

    // Mario (operators) may write; Luigi (viewers) only read; Toad nothing.
    const created = await call<{ goal: { id: number } }>(
      stage.u.url,
      stage.u.mario,
      "PUT",
      `${base}/bot/${botId}/goal`,
      { title: "Guard the gate", priority: "low" },
    );
    expect(created.status).toBe(200);
    const goalId = created.body.goal.id;
    const [audit] = await api.db.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, "goal:create"))
      .orderBy(desc(auditLogs.id))
      .limit(1);
    expect(audit).toMatchObject({ targetType: "goal" });

    expect(
      (
        await call(
          stage.u.url,
          stage.u.luigi,
          "PUT",
          `${base}/bot/${botId}/goal`,
          { title: "x" },
        )
      ).status,
    ).toBe(403);
    expect(
      (await call(stage.u.url, stage.u.luigi, "GET", `${base}/goal/${goalId}`))
        .status,
    ).toBe(200);
    expect(
      (await call(stage.u.url, stage.u.toad, "GET", `${base}/goal/${goalId}`))
        .status,
    ).toBe(404);
    expect(
      (
        await call(
          stage.u.url,
          stage.u.luigi,
          "POST",
          `${base}/goal/${goalId}`,
          { notes: "x" },
        )
      ).status,
    ).toBe(403);

    const edited = await call<{
      goal: { title: string; reviewEverySeconds: number };
    }>(stage.u.url, stage.u.mario, "POST", `${base}/goal/${goalId}`, {
      title: "Guard both gates",
      reviewEverySeconds: 86_400,
    });
    expect(edited.body.goal).toMatchObject({
      title: "Guard both gates",
      reviewEverySeconds: 86_400,
    });

    for (let i = 0; i < 3; i++) {
      await call(
        stage.u.url,
        stage.u.mario,
        "PUT",
        `${base}/bot/${botId}/goal`,
        {
          title: `Extra ${i}`,
          position: i + 1,
        },
      );
    }
    const page = await call<{
      goals: { title: string }[];
      pagination: { page: number; limit: number; total: number; pages: number };
    }>(
      stage.u.url,
      stage.u.luigi,
      "GET",
      `${base}/bot/${botId}/goals?limit=2&page=2`,
    );
    expect(page.body.pagination).toEqual({
      page: 2,
      limit: 2,
      total: 4,
      pages: 2,
    });
    expect(page.body.goals.map((g) => g.title)).toEqual(["Extra 1", "Extra 2"]);

    const deleted = await call(
      stage.u.url,
      stage.u.mario,
      "DELETE",
      `${base}/goal/${goalId}`,
    );
    expect(deleted.status).toBe(200);
    expect(
      (await call(stage.u.url, stage.u.mario, "GET", `${base}/goal/${goalId}`))
        .status,
    ).toBe(404);
  });
});
