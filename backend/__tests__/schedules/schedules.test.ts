import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { and, desc, eq } from "drizzle-orm";
import { api, config } from "keryx";
import {
  claimDue,
  fireRun,
  latestSlot,
  upcomingSlots,
} from "../../ops/ScheduleOps";
import { auditLogs } from "../../schema/audit_logs";
import { conversationEntries } from "../../schema/conversation_entries";
import { conversationInbox } from "../../schema/conversation_inbox";
import { conversations } from "../../schema/conversations";
import { goals } from "../../schema/goals";
import { outboxMessages } from "../../schema/outbox_messages";
import { scheduleRuns } from "../../schema/schedule_runs";
import { schedules } from "../../schema/schedules";
import {
  type AgentStage,
  buildAgentStage,
  clearLoopQueues,
  drainQueue,
  startConversation,
} from "../agent/harness";
import { call, HOOK_TIMEOUT, runAction } from "../setup";

/**
 * Schedules over HTTP and through the clock: a person attaches a cron
 * schedule to a bot; `schedules:due` writes one run per slot and fires it;
 * the guard, the disengagement checks, and the bot's own silence decide what
 * the slot does. Time moves by writing `nextRunAt`, never by waiting.
 */
let stage: AgentStage;

beforeAll(async () => {
  stage = await buildAgentStage("anthropic");
}, HOOK_TIMEOUT);

afterEach(async () => {
  await clearLoopQueues();
  await api.db.db.delete(schedules);
  await api.db.db.delete(conversations);
  await api.db.db.delete(goals);
  expect(stage.models.expectationFailures).toEqual([]);
  stage.models.reset();
});

afterAll(async () => {
  await stage.models.stop();
  await api.stop();
}, HOOK_TIMEOUT);

/** A step that ends the turn silently. */
const silent = { toolCalls: [{ name: "complete", input: { silent: true } }] };

/**
 * Create a schedule for the stage's bot as Peach.
 * @param body - The `schedule:create` inputs.
 * @returns The status and body.
 */
async function create(body: Record<string, unknown>) {
  return call<{
    schedule: {
      id: number;
      nextRunAt: number;
      nextSlots: number[];
      description: string;
    };
    error?: { key?: string; message: string };
  }>(
    stage.u.url,
    stage.u.peach,
    "PUT",
    `/project/${stage.u.projectId}/bot/${stage.botId}/schedule`,
    {
      name: "Check in",
      targetType: "none",
      cron: "*/5 * * * *",
      instruction: "Check whether anything needs a person.",
      ...body,
    },
  );
}

/**
 * Create a schedule and make its newest slot due now.
 * @param body - The `schedule:create` inputs.
 * @returns The schedule's id and the due slot.
 */
async function dueSchedule(
  body: Record<string, unknown> = {},
): Promise<{ id: number; slot: Date }> {
  const res = await create(body);
  if (res.status !== 200) throw new Error(JSON.stringify(res.body));
  const [row] = await api.db.db
    .select()
    .from(schedules)
    .where(eq(schedules.id, res.body.schedule.id));
  const slot = latestSlot(row.cron, row.timeZone, new Date()) as Date;
  await api.db.db
    .update(schedules)
    .set({ nextRunAt: slot })
    .where(eq(schedules.id, row.id));
  return { id: row.id, slot };
}

/**
 * A schedule's runs, oldest slot first.
 * @param scheduleId - The schedule.
 * @returns The rows.
 */
async function runsOf(scheduleId: number) {
  return api.db.db
    .select()
    .from(scheduleRuns)
    .where(eq(scheduleRuns.scheduleId, scheduleId))
    .orderBy(scheduleRuns.slot);
}

/**
 * Run the clock once, then fire and tick what it enqueued.
 * @returns The jobs run.
 */
async function clockAndDrain(): Promise<string[]> {
  await runAction("schedules:due");
  return drainQueue("agents");
}

describe("schedule:create and its checks", () => {
  test("answers the next slots and the cron in words, and audits the decision", async () => {
    const res = await create({
      name: "Monday summary",
      cron: "0 9 * * 1",
      timeZone: "Europe/Berlin",
    });
    expect(res.status).toBe(200);
    expect(res.body.schedule.description).toBe("Mondays at 09:00");
    expect(res.body.schedule.nextSlots).toHaveLength(5);
    expect(res.body.schedule.nextRunAt).toBe(res.body.schedule.nextSlots[0]);
    const local = new Intl.DateTimeFormat("en-US", {
      timeZone: "Europe/Berlin",
      weekday: "long",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(res.body.schedule.nextRunAt));
    expect(local).toBe("Monday 09:00");
    const [audit] = await api.db.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, "schedule:create"))
      .orderBy(desc(auditLogs.id))
      .limit(1);
    expect(audit.targetType).toBe("schedule");
  });

  test("refuses what cannot run, keyed on the input at fault", async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ cron: "every monday" }, "cron"],
      [{ cron: "* * * * *" }, "cron"],
      [{ cron: "*/2 * * * *" }, "cron"],
      [{ cron: "0 0 0 * * *" }, "cron"],
      [{ timeZone: "Mars/Olympus" }, "timeZone"],
      [{ instruction: "" }, "instruction"],
      [{ targetType: "channel" }, "channelId"],
      [
        { targetType: "conversation", conversationId: 999_999 },
        "conversationId",
      ],
    ];
    for (const [body, key] of cases) {
      const res = await create(body);
      expect(res.status, JSON.stringify(body)).toBe(406);
      expect(res.body.error?.key, JSON.stringify(body)).toBe(key);
    }
    // goal-review needs no instruction of its own.
    expect(
      (await create({ kind: "goal-review", instruction: "" })).status,
    ).toBe(200);
  });

  test("a bot holds at most the limit, proposals included", async () => {
    const max = config.schedules.maxPerBot;
    for (let i = 0; i < max; i++) {
      expect((await create({ name: `s${i}` })).status).toBe(200);
    }
    const over = await create({ name: "one more" });
    expect(over.status).toBe(406);
    expect(over.body.error?.message).toContain(`at most ${max}`);
  });

  test("needs the bot's write access; reading needs read access", async () => {
    await call(
      stage.u.url,
      stage.u.peach,
      "POST",
      `/project/${stage.u.projectId}/bot/${stage.botId}`,
      { accessRead: ["operators", "viewers"], accessWrite: ["operators"] },
    );
    try {
      const body = {
        name: "Luigi's",
        targetType: "none",
        cron: "0 9 * * *",
        instruction: "Hi",
      };
      const path = `/project/${stage.u.projectId}/bot/${stage.botId}/schedule`;
      const luigi = await call(stage.u.url, stage.u.luigi, "PUT", path, body);
      expect(luigi.status).toBe(403);
      const mario = await call<{ schedule: { id: number } }>(
        stage.u.url,
        stage.u.mario,
        "PUT",
        path,
        body,
      );
      expect(mario.status).toBe(200);
      const list = await call<{ schedules: unknown[]; pagination: unknown }>(
        stage.u.url,
        stage.u.luigi,
        "GET",
        `/project/${stage.u.projectId}/bot/${stage.botId}/schedules`,
      );
      expect(list.status).toBe(200);
      expect(list.body.schedules).toHaveLength(1);
      expect(list.body.pagination).toMatchObject({ page: 1, total: 1 });
      const bowser = await call(
        stage.u.url,
        stage.u.bowser,
        "GET",
        `/project/${stage.u.projectId}/schedule/${mario.body.schedule.id}`,
      );
      expect(bowser.status).toBe(403);
    } finally {
      await call(
        stage.u.url,
        stage.u.peach,
        "POST",
        `/project/${stage.u.projectId}/bot/${stage.botId}`,
        { accessRead: [], accessWrite: [] },
      );
    }
  });

  test("schedule:preview checks an expression without saving it", async () => {
    const ok = await call<{
      preview: { description: string; nextSlots: number[] };
    }>(
      stage.u.url,
      stage.u.toad,
      "GET",
      `/project/${stage.u.projectId}/schedule-preview?cron=${encodeURIComponent("30 8 * * 1-5")}&timeZone=America/New_York`,
    );
    expect(ok.status).toBe(200);
    expect(ok.body.preview.description).toBe("Weekdays at 08:30");
    expect(ok.body.preview.nextSlots).toHaveLength(5);
    const bad = await call(
      stage.u.url,
      stage.u.toad,
      "GET",
      `/project/${stage.u.projectId}/schedule-preview?cron=${encodeURIComponent("* * * * *")}`,
    );
    expect(bad.status).toBe(406);
    expect(await api.db.db.select().from(schedules)).toHaveLength(0);
  });
});

describe("one slot, one run", () => {
  test("two clocks racing over the same due row write one run and one inbox row", async () => {
    const { id, slot } = await dueSchedule();
    const claimed = await Promise.all([claimDue(), claimDue(), claimDue()]);
    expect(claimed.flat()).toHaveLength(1);
    const runs = await runsOf(id);
    expect(runs).toHaveLength(1);
    expect(runs[0].slot.getTime()).toBe(slot.getTime());
    // Two fires of one run: one takes it, the other finds it taken.
    stage.models.play([silent]);
    const fired = await Promise.all([fireRun(runs[0].id), fireRun(runs[0].id)]);
    expect([...fired].sort()).toEqual(["busy", "woken"]);
    const inbox = await api.db.db
      .select()
      .from(conversationInbox)
      .where(eq(conversationInbox.source, "schedule"));
    expect(inbox).toHaveLength(1);
    expect(inbox[0].deliveryKey).toBe(`schedule:${id}:${slot.toISOString()}`);
    // The schedule moved on to its next slot.
    const [row] = await api.db.db
      .select()
      .from(schedules)
      .where(eq(schedules.id, id));
    expect(row.nextRunAt.getTime()).toBeGreaterThan(Date.now());
    expect(row.lastRunAt?.getTime()).toBe(slot.getTime());
    await drainQueue("agents");
    expect((await runsOf(id))[0].status).toBe("silent");
  });

  test("six missed slots run once with catchUp latest, and not at all with none", async () => {
    const latest = await create({
      name: "latest",
      catchUp: "latest",
      cron: "0 9 * * *",
    });
    const none = await create({
      name: "none",
      catchUp: "none",
      cron: "0 9 * * *",
    });
    // Down since six days of 09:00 slots ago; back at noon.
    for (const s of [latest, none]) {
      await api.db.db
        .update(schedules)
        .set({ nextRunAt: new Date("2026-05-01T09:00:00Z") })
        .where(eq(schedules.id, s.body.schedule.id));
    }
    const noon = new Date("2026-05-07T12:00:00Z");
    expect(await claimDue(noon)).toHaveLength(1);
    const latestRuns = await runsOf(latest.body.schedule.id);
    expect(latestRuns.map((r) => r.slot.toISOString())).toEqual([
      "2026-05-07T09:00:00.000Z",
    ]);
    expect(await runsOf(none.body.schedule.id)).toHaveLength(0);
    for (const s of [latest, none]) {
      const [row] = await api.db.db
        .select()
        .from(schedules)
        .where(eq(schedules.id, s.body.schedule.id));
      expect(row.nextRunAt.toISOString()).toBe("2026-05-08T09:00:00.000Z");
    }
    // A second clock run writes nothing more.
    expect(await claimDue(noon)).toHaveLength(0);
    expect(await runsOf(latest.body.schedule.id)).toHaveLength(1);
  });

  test("with catchUp none, a slot within the grace still runs", async () => {
    const res = await create({ catchUp: "none", cron: "0 9 * * *" });
    await api.db.db
      .update(schedules)
      .set({ nextRunAt: new Date("2026-05-07T09:00:00Z") })
      .where(eq(schedules.id, res.body.schedule.id));
    expect(await claimDue(new Date("2026-05-07T09:01:00Z"))).toHaveLength(1);
  });

  test("a disabled schedule never fires, however long it is overdue", async () => {
    const { id } = await dueSchedule({ enabled: false });
    await clockAndDrain();
    expect(await runsOf(id)).toHaveLength(0);
  });
});

describe("slots across daylight saving time", () => {
  const NY = "America/New_York";
  const local = (d: Date) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: NY,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(d);

  test("02:30 daily runs once every day: at 03:00 on the spring gap, once on the fall overlap", () => {
    const spring = upcomingSlots(
      "30 2 * * *",
      NY,
      3,
      new Date("2026-03-07T00:00:00Z"),
    );
    expect(spring.map((d) => d.toISOString())).toEqual([
      "2026-03-07T07:30:00.000Z",
      "2026-03-08T07:00:00.000Z",
      "2026-03-09T06:30:00.000Z",
    ]);
    expect(local(spring[1])).toBe("2026-03-08, 03:00");
    const fall = upcomingSlots(
      "30 2 * * *",
      NY,
      3,
      new Date("2026-10-31T00:00:00Z"),
    );
    expect(fall.map((d) => d.toISOString())).toEqual([
      "2026-10-31T06:30:00.000Z",
      "2026-11-01T07:30:00.000Z",
      "2026-11-02T07:30:00.000Z",
    ]);
  });

  test("01:30, the hour the fall overlap repeats, runs once that night", () => {
    const fall = upcomingSlots(
      "30 1 * * *",
      NY,
      3,
      new Date("2026-10-31T12:00:00Z"),
    );
    expect(fall.map((d) => d.toISOString())).toEqual([
      "2026-11-01T05:30:00.000Z",
      "2026-11-02T06:30:00.000Z",
      "2026-11-03T06:30:00.000Z",
    ]);
  });

  test("the clock advances a slot across the spring gap to the next local 02:30", async () => {
    const res = await create({ cron: "30 2 * * *", timeZone: NY });
    const id = res.body.schedule.id;
    // Claimed at the gap's shifted slot, the next is the following night.
    const gap = new Date("2026-03-08T07:00:00Z");
    await api.db.db
      .update(schedules)
      .set({ nextRunAt: gap })
      .where(eq(schedules.id, id));
    const ids = await claimDue(new Date("2026-03-08T07:00:30Z"));
    expect(ids).toHaveLength(1);
    const [row] = await api.db.db
      .select()
      .from(schedules)
      .where(eq(schedules.id, id));
    expect(row.nextRunAt.toISOString()).toBe("2026-03-09T06:30:00.000Z");
    expect((await runsOf(id))[0].slot.toISOString()).toBe(gap.toISOString());
  });
});

describe("the guard", () => {
  test("a no from the fast model skips the slot: no tick, nothing posted, one model call", async () => {
    const { id } = await dueSchedule({
      guard: "only if there are new P0 issues",
    });
    stage.models.play([
      {
        toolCalls: [
          { name: "json", input: { act: false, reason: "No new P0 issues." } },
        ],
        expect: { anyMessageIncludes: "only if there are new P0 issues" },
      },
    ]);
    const ran = await clockAndDrain();
    expect(ran).not.toContain("agent:tick");
    const [run] = await runsOf(id);
    expect(run.status).toBe("skipped");
    expect(run.reason).toBe("Guard: No new P0 issues.");
    expect(run.guard).toEqual({ act: false, reason: "No new P0 issues." });
    expect(run.conversationId).toBeNull();
    expect(stage.models.completions).toHaveLength(1);
    expect(stage.models.completions[0].body.model).toBe("scripted-small");
    expect(await api.db.db.select().from(outboxMessages)).toHaveLength(0);
  });

  test("a yes wakes the bot, which reads the instruction and its goals", async () => {
    await call(
      stage.u.url,
      stage.u.peach,
      "PUT",
      `/project/${stage.u.projectId}/bot/${stage.botId}/goal`,
      { title: "Keep the moat clean" },
    );
    const { id } = await dueSchedule({ guard: "only on a sunny day" });
    stage.models.play([
      {
        toolCalls: [{ name: "json", input: { act: true, reason: "Sunny." } }],
        expect: { anyMessageIncludes: "Keep the moat clean" },
      },
      {
        toolCalls: [
          { name: "complete", input: { summary: "The moat is clean." } },
        ],
        expect: {
          anyMessageIncludes: "Check whether anything needs a person.",
        },
      },
    ]);
    await clockAndDrain();
    const [run] = await runsOf(id);
    expect(run.status).toBe("posted");
    expect(run.guard).toEqual({ act: true, reason: "Sunny." });
    const message = await api.db.db
      .select()
      .from(conversationEntries)
      .where(
        and(
          eq(conversationEntries.conversationId, run.conversationId as number),
          eq(conversationEntries.kind, "message"),
        ),
      );
    expect(JSON.stringify(message[0].content)).toContain("Keep the moat clean");
    expect((message[0].content as { source: string }).source).toBe("schedule");
  });

  test("a guard that cannot answer fails the run, and nothing wakes", async () => {
    const { id } = await dueSchedule({ guard: "only if needed" });
    stage.models.play([{ fail: { status: 400, message: "bad request" } }]);
    const ran = await clockAndDrain();
    expect(ran).not.toContain("agent:tick");
    const [run] = await runsOf(id);
    expect(run.status).toBe("failed");
    expect(run.reason).toContain("The guard could not decide");
  });
});

describe("silent completion", () => {
  test("a scheduled turn may end silent: recorded, and nothing posted", async () => {
    const { id } = await dueSchedule();
    stage.models.play([silent]);
    await clockAndDrain();
    const [run] = await runsOf(id);
    expect(run.status).toBe("silent");
    expect(run.finishedAt).not.toBeNull();
    const [conversation] = await api.db.db
      .select()
      .from(conversations)
      .where(eq(conversations.id, run.conversationId as number));
    expect(conversation.state).toBe("ended");
    expect(conversation.outcome).toBe("completed");
    const rows = await api.db.db
      .select()
      .from(outboxMessages)
      .where(eq(outboxMessages.conversationId, conversation.id));
    expect(rows.filter((r) => r.kind === "message")).toHaveLength(0);
  });

  test("a turn a person started may not end silent", async () => {
    stage.models.play([
      silent,
      { toolCalls: [{ name: "complete", input: { summary: "Done." } }] },
    ]);
    const started = await startConversation(stage, "Hello");
    await drainQueue("agents");
    const results = await api.db.db
      .select()
      .from(conversationEntries)
      .where(
        and(
          eq(conversationEntries.conversationId, started.body.conversation.id),
          eq(conversationEntries.kind, "tool_result"),
        ),
      )
      .orderBy(conversationEntries.seq);
    expect(JSON.stringify(results[0].content)).toContain("not_scheduled");
  });
});

describe("a schedule never re-engages what a person disengaged", () => {
  test("a stopped conversation target skips, saying so", async () => {
    stage.models.play([
      { toolCalls: [{ name: "reply_and_wait", input: { text: "Hi." } }] },
    ]);
    const started = await startConversation(stage, "Hello");
    await drainQueue("agents");
    const conversationId = started.body.conversation.id;
    const cancelled = await call(
      stage.u.url,
      stage.u.peach,
      "POST",
      `/project/${stage.u.projectId}/conversation/${conversationId}/cancel`,
    );
    expect(cancelled.status).toBe(200);
    const { id } = await dueSchedule({
      targetType: "conversation",
      conversationId,
    });
    const ran = await clockAndDrain();
    expect(ran).not.toContain("agent:tick");
    const [run] = await runsOf(id);
    expect(run.status).toBe("skipped");
    expect(run.reason).toBe("A person stopped this conversation.");
  });

  test("a resting conversation target gets a new turn in the same conversation", async () => {
    stage.models.play([
      { toolCalls: [{ name: "reply_and_wait", input: { text: "Hi." } }] },
      {
        toolCalls: [
          {
            name: "reply_and_wait",
            input: { text: "Morning check: all well." },
          },
        ],
      },
    ]);
    const started = await startConversation(stage, "Hello");
    await drainQueue("agents");
    const conversationId = started.body.conversation.id;
    const { id } = await dueSchedule({
      targetType: "conversation",
      conversationId,
    });
    await clockAndDrain();
    const [run] = await runsOf(id);
    expect(run.status).toBe("posted");
    expect(run.conversationId).toBe(conversationId);
  });

  test("a conversation cancelled after its slot woke it fails the run", async () => {
    stage.models.play([
      { toolCalls: [{ name: "reply_and_wait", input: { text: "Hi." } }] },
    ]);
    const started = await startConversation(stage, "Hello");
    await drainQueue("agents");
    const conversationId = started.body.conversation.id;
    const { id } = await dueSchedule({
      targetType: "conversation",
      conversationId,
    });
    await runAction("schedules:due");
    await drainQueue("agents", { only: "schedule-run:fire" });
    expect((await runsOf(id))[0].status).toBe("woken");
    await call(
      stage.u.url,
      stage.u.peach,
      "POST",
      `/project/${stage.u.projectId}/conversation/${conversationId}/cancel`,
    );
    await drainQueue("agents");
    const [run] = await runsOf(id);
    expect(run.status).toBe("failed");
    expect(run.reason).toContain("cancelled");
  });
});

describe("a bot proposes; a person arms", () => {
  test("schedule_propose writes a disabled schedule that never fires until a person enables it", async () => {
    stage.models.play([
      {
        toolCalls: [
          {
            name: "schedule_propose",
            input: {
              name: "Daily moat check",
              cron: "*/5 * * * *",
              instruction: "Check the moat.",
              target: "none",
            },
          },
        ],
      },
      {
        toolCalls: [
          { name: "reply_and_wait", input: { text: "I proposed a schedule." } },
        ],
      },
    ]);
    await startConversation(stage, "Could you check the moat every day?");
    await drainQueue("agents");
    const [proposed] = await api.db.db.select().from(schedules);
    expect(proposed).toMatchObject({
      name: "Daily moat check",
      enabled: false,
      proposedByBot: true,
      createdByUserId: null,
    });
    // Overdue and disabled: nothing.
    const slot = latestSlot(
      proposed.cron,
      proposed.timeZone,
      new Date(),
    ) as Date;
    await api.db.db
      .update(schedules)
      .set({ nextRunAt: slot })
      .where(eq(schedules.id, proposed.id));
    await clockAndDrain();
    expect(await runsOf(proposed.id)).toHaveLength(0);
    const created = await api.db.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, "schedule:create"));
    expect(
      created.filter((a) => a.targetPath?.endsWith(`/${proposed.id}`)),
    ).toHaveLength(0);

    const enabled = await call<{
      schedule: { enabled: boolean; nextRunAt: number };
    }>(
      stage.u.url,
      stage.u.peach,
      "POST",
      `/project/${stage.u.projectId}/schedule/${proposed.id}`,
      { enabled: true },
    );
    expect(enabled.status).toBe(200);
    expect(enabled.body.schedule.enabled).toBe(true);
    expect(enabled.body.schedule.nextRunAt).toBeGreaterThan(Date.now());
    const [audit] = await api.db.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, "schedule:edit"));
    expect((audit.before as { enabled: boolean }).enabled).toBe(false);
    expect((audit.after as { enabled: boolean }).enabled).toBe(true);
    // Armed, its slots fire.
    await api.db.db
      .update(schedules)
      .set({
        nextRunAt: latestSlot(
          proposed.cron,
          proposed.timeZone,
          new Date(),
        ) as Date,
      })
      .where(eq(schedules.id, proposed.id));
    stage.models.play([silent]);
    await clockAndDrain();
    expect((await runsOf(proposed.id)).map((r) => r.status)).toEqual([
      "silent",
    ]);
  });

  test("schedule_list shows the bot its schedules", async () => {
    await create({ name: "Weekly", cron: "0 9 * * 1" });
    stage.models.play([
      { toolCalls: [{ name: "schedule_list", input: {} }] },
      {
        toolCalls: [{ name: "reply_and_wait", input: { text: "One." } }],
        expect: { lastMessageIncludes: "Mondays at 09:00" },
      },
    ]);
    await startConversation(stage, "What are your schedules?");
    await drainQueue("agents");
  });
});

describe("goal review and run-now", () => {
  test("a goal-review slot shows the goals and recent conversations, and goal_update changes them", async () => {
    const goal = await call<{ goal: { id: number } }>(
      stage.u.url,
      stage.u.peach,
      "PUT",
      `/project/${stage.u.projectId}/bot/${stage.botId}/goal`,
      { title: "Answer every visitor" },
    );
    const goalId = goal.body.goal.id;
    const { id } = await dueSchedule({ kind: "goal-review", instruction: "" });
    stage.models.play([
      {
        toolCalls: [
          {
            name: "goal_update",
            input: { goalId, notes: "On track: every visitor answered." },
          },
        ],
        expect: {
          anyMessageIncludes: "Your conversations in the last seven days",
        },
      },
      silent,
    ]);
    await clockAndDrain();
    const [row] = await api.db.db
      .select()
      .from(goals)
      .where(eq(goals.id, goalId));
    expect(row.notes).toBe("On track: every visitor answered.");
    expect(row.lastReviewedAt).not.toBeNull();
    expect((await runsOf(id))[0].status).toBe("silent");
  });

  test("schedule:run-now fires a disabled schedule once, audited, and schedule:runs lists it", async () => {
    const res = await create({ enabled: false });
    const scheduleId = res.body.schedule.id;
    const now = await call<{ run: { id: number; trigger: string } }>(
      stage.u.url,
      stage.u.peach,
      "POST",
      `/project/${stage.u.projectId}/schedule/${scheduleId}/run`,
    );
    expect(now.status).toBe(200);
    expect(now.body.run.trigger).toBe("manual");
    stage.models.play([
      { toolCalls: [{ name: "complete", input: { summary: "Checked." } }] },
    ]);
    await drainQueue("agents");
    const runs = await call<{
      runs: { status: string; trigger: string; conversationId: number }[];
      pagination: { total: number };
    }>(
      stage.u.url,
      stage.u.luigi,
      "GET",
      `/project/${stage.u.projectId}/schedule/${scheduleId}/runs`,
    );
    expect(runs.status).toBe(200);
    expect(runs.body.pagination.total).toBe(1);
    expect(runs.body.runs[0]).toMatchObject({
      status: "posted",
      trigger: "manual",
    });
    const [audit] = await api.db.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, "schedule:run-now"));
    expect(audit).toBeDefined();
  });

  test("schedule:delete removes the schedule and its runs, audited", async () => {
    const { id } = await dueSchedule();
    stage.models.play([silent]);
    await clockAndDrain();
    const res = await call(
      stage.u.url,
      stage.u.peach,
      "DELETE",
      `/project/${stage.u.projectId}/schedule/${id}`,
    );
    expect(res.status).toBe(200);
    expect(await runsOf(id)).toHaveLength(0);
    const [audit] = await api.db.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, "schedule:delete"));
    expect(audit).toBeDefined();
  });
});

describe("a run nobody fired", () => {
  test("is fired again by the clock once it is stale", async () => {
    const { id } = await dueSchedule();
    await runAction("schedules:due");
    // The fire task was lost.
    await clearLoopQueues();
    expect((await runsOf(id))[0].status).toBe("pending");
    await api.db.db
      .update(scheduleRuns)
      .set({
        createdAt: new Date(Date.now() - config.schedules.staleRunMs - 1000),
      })
      .where(eq(scheduleRuns.scheduleId, id));
    stage.models.play([silent]);
    const result = await runAction<{ refired: number }>("schedules:due");
    expect(result.refired).toBe(1);
    await drainQueue("agents");
    expect((await runsOf(id))[0].status).toBe("silent");
  });
});
