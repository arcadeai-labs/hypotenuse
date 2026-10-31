import { eq } from "drizzle-orm";
import { api } from "keryx";
import { type CodeRun, codeRuns } from "../../schema/code_runs";
import type { McpStage } from "../mcp/harness";
import { call } from "../setup";

/**
 * What the code-mode suites share: a step that runs a program, reading a
 * conversation's code runs, and deciding an approval over HTTP.
 */

/**
 * A step that calls `run_code`.
 * @param source - The program.
 * @param extra - More input (`saveTo`, `changeNote`).
 * @returns The scripted step.
 */
export function codeStep(source: string, extra: Record<string, unknown> = {}) {
  return { toolCalls: [{ name: "run_code", input: { source, ...extra } }] };
}

/**
 * Every code run of a conversation, oldest first.
 * @param conversationId - The conversation.
 * @returns The rows.
 */
export async function codeRunsOf(conversationId: number): Promise<CodeRun[]> {
  return api.db.db
    .select()
    .from(codeRuns)
    .where(eq(codeRuns.conversationId, conversationId))
    .orderBy(codeRuns.id);
}

/**
 * Decide an approval over HTTP, as Peach.
 * @param stage - The stage.
 * @param id - The approval.
 * @param decision - approve or deny.
 * @param note - A note for the model.
 * @returns The response.
 */
export function decide(
  stage: McpStage,
  id: number,
  decision: "approve" | "deny",
  note?: string,
) {
  return call<{ approval: Record<string, unknown> }>(
    stage.u.url,
    stage.u.peach,
    "POST",
    `/project/${stage.u.projectId}/approval/${id}`,
    { decision, via: "dashboard", ...(note ? { note } : {}) },
  );
}

/** A program that reads the inbox, then sends two emails at once. */
export const SEND_TWO = `
await mcp.info("mail", "read_inbox");
await mcp.info("mail", "send_email");
const inbox = await mcp.exec("mail", "read_inbox", {});
const sent = await Promise.all([
  mcp.exec("mail", "send_email", { to: "toad", subject: "cake" }),
  mcp.exec("mail", "send_email", { to: "peach", subject: "cake" }),
]);
return { inbox, sent };
`;
