import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { api } from "keryx";
import { botMcpServers } from "../../schema/bot_mcp_servers";
import { codeRuns } from "../../schema/code_runs";
import {
  conversationRow,
  drainQueue,
  runTicks,
  setColumns,
  startConversation,
} from "../agent/harness";
import {
  addServer,
  bindServer,
  buildMcpStage,
  clearLoopQueues,
  type McpStage,
  replyStep,
  resultsOf,
} from "../mcp/harness";
import { HOOK_TIMEOUT } from "../setup";
import { codeRunsOf, codeStep } from "./harness";

/**
 * A worker that dies around a program. Its result's insert is refused (a
 * trigger, a real database error), so the tick throws with the intent open.
 * Then: a run left `running` is reported interrupted with its journal of
 * settled host calls, which the model's next request contains, and nothing is
 * run again; a run that had finished has its stored answer written once.
 */
let stage: McpStage;
let serverId: number;

const READ = `await mcp.info("mail", "read_inbox"); const a = await mcp.exec("mail", "read_inbox", {}); return a;`;

beforeAll(async () => {
  stage = await buildMcpStage();
  serverId = (await addServer(stage)).id;
}, HOOK_TIMEOUT);

afterEach(async () => {
  await dropTrigger();
  await clearLoopQueues();
  expect(stage.models.expectationFailures).toEqual([]);
  stage.models.reset();
  stage.fixture.reset();
  await api.db.db.delete(botMcpServers);
});

afterAll(async () => {
  await dropTrigger();
  await stage.fixture.stop();
  await stage.models.stop();
  await api.stop();
}, HOOK_TIMEOUT);

/** Remove the refusing trigger. */
async function dropTrigger(): Promise<void> {
  await api.db.db.execute(
    sql`drop trigger if exists refuse_run_code_result on conversation_entries`,
  );
  await api.db.db.execute(
    sql`drop function if exists refuse_run_code_result()`,
  );
}

/**
 * Run a program whose result cannot be written: the tick throws.
 * @returns The conversation id.
 */
async function dieAfterProgram(): Promise<number> {
  await bindServer(stage, serverId, { allowedTools: ["mail/*"] });
  await api.db.db.execute(sql`
    create or replace function refuse_run_code_result() returns trigger as $$
    begin
      if new.kind = 'tool_result' and new.tool_name = 'run_code' then
        raise exception 'refused by the crash suite';
      end if;
      return new;
    end $$ language plpgsql`);
  await api.db.db.execute(sql`
    create trigger refuse_run_code_result before insert on conversation_entries
    for each row execute function refuse_run_code_result()`);
  stage.models.play([codeStep(READ)]);
  const id = (await startConversation(stage, "Inbox?")).body.conversation.id;
  await expect(drainQueue("agents", { only: "agent:tick" })).rejects.toThrow();
  expect(stage.fixture.calls.map((c) => c.tool)).toEqual(["read_inbox"]);
  expect(await resultsOf(id, "run_code")).toEqual([]);
  await dropTrigger();
  return id;
}

/**
 * Recover the conversation as the wake-due clock would.
 * @param id - The conversation.
 */
async function recover(id: number): Promise<void> {
  await setColumns(id, { leaseOwner: null, leaseExpiresAt: null });
  await api.actions.enqueue(
    "agent:tick",
    { conversationId: id, wake: Date.now() },
    "agents",
  );
  await runTicks();
}

test("a run left running under a dead lease is reported interrupted, with its journal, and not run again", async () => {
  const id = await dieAfterProgram();
  // The worker died mid-program: the run never settled.
  const [run] = await codeRunsOf(id);
  await api.db.db
    .update(codeRuns)
    .set({ status: "running", output: null })
    .where(eq(codeRuns.id, run.id));

  stage.models.play([
    {
      ...replyStep("It was interrupted; the inbox read had settled."),
      expect: { lastMessageIncludes: "mcp.exec" },
    },
  ]);
  await recover(id);

  const [result] = await resultsOf(id, "run_code");
  expect(result).toMatchObject({ is_error: true, error_type: "interrupted" });
  const journal = result.hostCalls as { fn: string; name?: string }[];
  expect(journal.map((h) => h.fn)).toEqual(["mcp.info", "mcp.exec"]);
  expect(journal[1].name).toBe("mail/read_inbox");
  expect(stage.fixture.calls).toHaveLength(1);
  const [after] = await codeRunsOf(id);
  expect(after.status).toBe("interrupted_by_crash");
  expect((await conversationRow(id)).state).toBe("hibernating");
  const request = JSON.stringify(stage.models.completions.at(-1));
  expect(request).toContain("interrupted");
});

test("a run that finished before the worker died has its answer written once", async () => {
  const id = await dieAfterProgram();
  const [run] = await codeRunsOf(id);
  expect(run.status).toBe("completed");
  stage.models.play([
    {
      ...replyStep("The cake is ready."),
      expect: { lastMessageIncludes: "the cake is ready" },
    },
  ]);
  await recover(id);
  const results = await resultsOf(id, "run_code");
  expect(results).toHaveLength(1);
  expect(results[0]).toMatchObject({
    result: "1. From Toad: the cake is ready",
  });
  expect(stage.fixture.calls).toHaveLength(1);
});
