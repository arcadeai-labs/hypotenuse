import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { api } from "keryx";
import {
  conversationRow,
  drainQueue,
  runTicks,
  setColumns,
  startConversation,
} from "../agent/harness";
import { call, HOOK_TIMEOUT } from "../setup";
import {
  addServer,
  approvalsOf,
  bindServer,
  buildMcpStage,
  type McpStage,
  replyStep,
  resultsOf,
} from "./harness";

/**
 * An approved call's effect and its record: the approval is consumed in the
 * transaction that writes the call's result, and marked executing — committed
 * — before the call is sent. So a worker that dies after the call and before
 * the result is never a second call: this suite makes the result's insert
 * fail (a trigger refusing it, a real database error), and the recovering
 * tick reports the call interrupted instead of sending it again.
 */
let stage: McpStage;

beforeAll(async () => {
  stage = await buildMcpStage();
}, HOOK_TIMEOUT);

afterAll(async () => {
  await api.db.db.execute(
    sql`drop trigger if exists refuse_mcp_exec_result on conversation_entries`,
  );
  await api.db.db.execute(
    sql`drop function if exists refuse_mcp_exec_result()`,
  );
  await stage.fixture.stop();
  await stage.models.stop();
  await api.stop();
}, HOOK_TIMEOUT);

describe("the transaction boundary of an approved call", () => {
  test("a failed result write leaves the approval unconsumed but executing, and recovery never sends it twice", async () => {
    const server = await addServer(stage);
    await bindServer(stage, server.id);
    stage.models.play([
      { toolCalls: [{ name: "mcp_info", input: { name: "mail/send_email" } }] },
      {
        toolCalls: [
          {
            name: "mcp_exec",
            input: {
              name: "mail/send_email",
              args: { to: "toad", subject: "x" },
            },
          },
        ],
      },
    ]);
    const id = (await startConversation(stage, "Email Toad")).body.conversation
      .id;
    await runTicks();
    const [approval] = await approvalsOf(id);

    await api.db.db.execute(sql`
      create or replace function refuse_mcp_exec_result() returns trigger as $$
      begin
        if new.kind = 'tool_result' and new.tool_name = 'mcp_exec' then
          raise exception 'refused by the crash suite';
        end if;
        return new;
      end $$ language plpgsql`);
    await api.db.db.execute(sql`
      create trigger refuse_mcp_exec_result before insert on conversation_entries
      for each row execute function refuse_mcp_exec_result()`);

    const decided = await call(
      stage.u.url,
      stage.u.peach,
      "POST",
      `/project/${stage.u.projectId}/approval/${approval.id}`,
      { decision: "approve" },
    );
    expect(decided.status).toBe(200);
    // The tick sends the call, then fails to write its result: it throws.
    await expect(
      drainQueue("agents", { only: "agent:tick" }),
    ).rejects.toThrow();
    expect(stage.fixture.calls.map((c) => c.tool)).toEqual(["send_email"]);
    const [mid] = await approvalsOf(id);
    expect(mid.status).toBe("approved");
    expect(mid.executingAt).not.toBeNull();
    expect(mid.consumedAt).toBeNull();
    expect(await resultsOf(id, "mcp_exec")).toEqual([]);

    await api.db.db.execute(
      sql`drop trigger refuse_mcp_exec_result on conversation_entries`,
    );
    // The thrown tick released its lease and owes a tick; run it as the
    // wake-due clock would.
    await setColumns(id, { leaseOwner: null, leaseExpiresAt: null });
    stage.models.play([
      {
        ...replyStep("It may have been sent."),
        expect: { lastMessageIncludes: "interrupted" },
      },
    ]);
    await api.actions.enqueue(
      "agent:tick",
      { conversationId: id, wake: Date.now() },
      "agents",
    );
    await runTicks();

    expect(stage.fixture.calls.length).toBe(1);
    const [result] = await resultsOf(id, "mcp_exec");
    expect(result).toMatchObject({ is_error: true, error_type: "interrupted" });
    const [after] = await approvalsOf(id);
    expect(after.status).toBe("consumed");
    expect((await conversationRow(id)).state).toBe("hibernating");
    expect(stage.models.expectationFailures).toEqual([]);
  });
});
