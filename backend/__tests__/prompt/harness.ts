import { and, eq } from "drizzle-orm";
import { api } from "keryx";
import { promptSections } from "../../schema/prompt_sections";
import {
  type AgentStage,
  readEntries,
  runTicks,
  sendMessage,
  startConversation,
} from "../agent/harness";
import type { ScriptedResponse } from "../fixtures/model-server";
import { call } from "../setup";

/**
 * What the prompt, goal, and skill suites share on top of the agent stage:
 * scripted tool steps, reading results back, a bot's sections by key, and the
 * system prompt a completion request carried.
 */

/** One scripted tool call. */
export type Step = { name: string; input: Record<string, unknown> }[];

/**
 * Start a conversation in which the model makes these tool calls, a step
 * each, then replies.
 * @param stage - The stage.
 * @param steps - The tool calls.
 * @param text - The first message.
 * @returns The conversation id.
 */
export async function botCalls(
  stage: AgentStage,
  steps: Step[],
  text = "Please help.",
): Promise<number> {
  stage.models.play([
    ...steps.map((toolCalls): ScriptedResponse => ({ toolCalls })),
    { toolCalls: [{ name: "reply_and_wait", input: { text: "Done." } }] },
  ]);
  const res = await startConversation(stage, text);
  if (res.status !== 200) throw new Error(JSON.stringify(res.body));
  await runTicks();
  return res.body.conversation.id;
}

/**
 * Continue a conversation with more tool steps.
 * @param stage - The stage.
 * @param conversationId - The conversation.
 * @param steps - The tool calls, one step each.
 * @param text - The message that starts the turn.
 */
export async function botCallsIn(
  stage: AgentStage,
  conversationId: number,
  steps: Step[],
  text = "Go on.",
): Promise<void> {
  stage.models.play([
    ...steps.map((toolCalls): ScriptedResponse => ({ toolCalls })),
    { toolCalls: [{ name: "reply_and_wait", input: { text: "Done." } }] },
  ]);
  const res = await sendMessage(stage, conversationId, text);
  if (res.status !== 200) throw new Error(JSON.stringify(res.body));
  await runTicks();
}

/**
 * The outputs of a conversation's results for one tool, in order.
 * @param stage - The stage.
 * @param conversationId - The conversation.
 * @param toolName - The tool.
 * @returns Each output.
 */
export async function toolOutputs(
  stage: AgentStage,
  conversationId: number,
  toolName: string,
): Promise<Record<string, unknown>[]> {
  const { entries } = await readEntries(stage, conversationId);
  return entries
    .filter((e) => e.kind === "tool_result" && e.toolName === toolName)
    .map((e) => (e.content as { output: Record<string, unknown> }).output);
}

/**
 * A conversation's `context_update` entries that record a prompt.
 * @param stage - The stage.
 * @param conversationId - The conversation.
 * @returns Each entry.
 */
export async function promptUpdates(stage: AgentStage, conversationId: number) {
  const { entries } = await readEntries(stage, conversationId);
  return entries.filter((e) => e.kind === "context_update" && e.promptHash);
}

/**
 * A bot's section id by key.
 * @param botId - The bot.
 * @param key - The key.
 * @returns The id.
 */
export async function sectionId(botId: number, key: string): Promise<number> {
  const [row] = await api.db.db
    .select({ id: promptSections.id })
    .from(promptSections)
    .where(and(eq(promptSections.botId, botId), eq(promptSections.key, key)));
  if (!row) throw new Error(`no section ${key}`);
  return row.id;
}

/**
 * Edit a section over HTTP as Peach.
 * @param stage - The stage.
 * @param id - The section.
 * @param body - The `prompt-section:edit` inputs.
 * @returns The status and body.
 */
export async function editSection(
  stage: AgentStage,
  id: number,
  body: Record<string, unknown>,
) {
  return call<{ promptSection: { currentVersion: number } }>(
    stage.u.url,
    stage.u.peach,
    "POST",
    `/project/${stage.u.projectId}/prompt-section/${id}`,
    body,
  );
}

/**
 * The system prompt a recorded completion request carried, as text.
 * @param stage - The stage.
 * @param index - Which completion (negative counts from the end).
 * @returns The text.
 */
export function sentSystem(stage: AgentStage, index = -1): string {
  const all = stage.models.completions;
  const req = all[index < 0 ? all.length + index : index];
  const system = req.body.system;
  if (typeof system === "string") return system;
  if (Array.isArray(system)) {
    return system.map((p) => (p as { text: string }).text).join("");
  }
  throw new Error("no system prompt in the request");
}
