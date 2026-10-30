import { sql } from "drizzle-orm";
import { api } from "keryx";
import {
  type AgentStage,
  buildAgentStage,
  conversationRow,
  drainQueue,
  MODEL_KEY,
  readEntries,
  runTicks,
  sendMessage,
  startConversation,
} from "../agent/harness";
import type { ScriptedResponse } from "../fixtures/model-server";
import { call, type TestUser } from "../setup";

/**
 * The memory suites' stage: the agent stage (an Anthropic-speaking scripted
 * model for `default` and `fast`, and Toadsworth), plus an OpenAI-compatible
 * connection to the same scripted server with an `embedding` alias, so
 * memory is embedded by the real `@ai-sdk/openai-compatible` provider.
 */

/** The memory stage. */
export interface MemoryStage extends AgentStage {
  embeddingConnectionId: number;
}

/**
 * Build the stage.
 * @param options.embedding - Define the `embedding` alias (default true).
 * @returns The stage.
 */
export async function buildMemoryStage(
  options: { embedding?: boolean } = {},
): Promise<MemoryStage> {
  const stage = await buildAgentStage("anthropic");
  const created = await call<{ modelConnection: { id: number } }>(
    stage.u.url,
    stage.u.peach,
    "PUT",
    `/project/${stage.u.projectId}/model-connection`,
    {
      name: "Scripted embeddings",
      provider: "openai-compatible",
      baseUrl: stage.models.baseUrl("openai-compatible"),
      apiKey: MODEL_KEY,
    },
  );
  if (created.status !== 200) throw new Error(JSON.stringify(created.body));
  const embeddingConnectionId = created.body.modelConnection.id;
  if (options.embedding !== false) {
    const alias = await call(
      stage.u.url,
      stage.u.peach,
      "PUT",
      `/project/${stage.u.projectId}/model-alias`,
      {
        name: "embedding",
        kind: "embedding",
        connectionId: embeddingConnectionId,
        modelId: "scripted-embed",
      },
    );
    if (alias.status !== 200) throw new Error(JSON.stringify(alias.body));
  }
  return { ...stage, embeddingConnectionId };
}

/**
 * Run the queued jobs of one memory action the way a worker would, leaving
 * the others queued — by default the embeds, so a suite that is not about
 * consolidation never asks the scripted model for facts.
 * @param only - The action to run.
 * @returns The jobs run.
 */
export async function runMemoryJobs(only = "memory:embed"): Promise<string[]> {
  return drainQueue("default", { max: 200, only });
}

/**
 * Have the bot call tools in a new conversation on a channel: each scripted
 * step makes its calls, and a final `reply_and_wait` ends the turn. Ticks run.
 * @param stage - The stage.
 * @param channelKey - The API channel.
 * @param steps - The tool calls, one step each.
 * @returns The conversation id.
 */
export async function botCalls(
  stage: MemoryStage,
  channelKey: string,
  steps: { name: string; input: Record<string, unknown> }[][],
): Promise<number> {
  stage.models.play([
    ...steps.map((toolCalls): ScriptedResponse => ({ toolCalls })),
    { toolCalls: [{ name: "reply_and_wait", input: { text: "Done." } }] },
  ]);
  const res = await startConversation(stage, "Please remember.", {
    channelKey,
  });
  if (res.status !== 200) throw new Error(JSON.stringify(res.body));
  await runTicks();
  return res.body.conversation.id;
}

/**
 * Continue a conversation with more tool steps.
 * @param stage - The stage.
 * @param conversationId - The conversation.
 * @param steps - The tool calls, one step each.
 */
export async function botCallsIn(
  stage: MemoryStage,
  conversationId: number,
  steps: { name: string; input: Record<string, unknown> }[][],
): Promise<void> {
  stage.models.play([
    ...steps.map((toolCalls): ScriptedResponse => ({ toolCalls })),
    { toolCalls: [{ name: "reply_and_wait", input: { text: "Done." } }] },
  ]);
  const res = await sendMessage(stage, conversationId, "Go on.");
  if (res.status !== 200) throw new Error(JSON.stringify(res.body));
  await runTicks();
}

/**
 * The outputs of a conversation's tool results, by tool name, in order.
 * @param stage - The stage.
 * @param conversationId - The conversation.
 * @param toolName - The tool.
 * @returns Each call's stored output.
 */
export async function toolOutputs(
  stage: MemoryStage,
  conversationId: number,
  toolName: string,
): Promise<Record<string, unknown>[]> {
  const { entries } = await readEntries(stage, conversationId);
  return entries
    .filter((e) => e.kind === "tool_result" && e.toolName === toolName)
    .map((e) => (e.content as { output: Record<string, unknown> }).output);
}

/**
 * A conversation's channel id.
 * @param conversationId - The conversation.
 * @returns The channel id.
 */
export async function channelOf(conversationId: number): Promise<number> {
  return (await conversationRow(conversationId)).channelId;
}

/**
 * Write a memory document over HTTP.
 * @param stage - The stage.
 * @param body - The `memory:write` inputs (without projectId).
 * @param user - Who writes (Peach by default).
 * @returns The status and body.
 */
export async function writeMemory(
  stage: MemoryStage,
  body: Record<string, unknown>,
  user: TestUser = stage.u.peach,
) {
  return call<{ document: Record<string, unknown> & { versionId: number } }>(
    stage.u.url,
    user,
    "PUT",
    `/project/${stage.u.projectId}/memory/document`,
    body,
  );
}

/**
 * GET a memory route with a query string.
 * @param stage - The stage.
 * @param route - The route beneath the project, e.g. `memory/search`.
 * @param query - The query parameters.
 * @param user - Who asks (Peach by default).
 * @returns The status and body.
 */
export async function getMemory<T = Record<string, unknown>>(
  stage: MemoryStage,
  route: string,
  query: Record<string, string | number | boolean | undefined>,
  user: TestUser = stage.u.peach,
) {
  const qs = new URLSearchParams(
    Object.entries(query)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]): [string, string] => [k, String(v)]),
  );
  return call<T>(
    stage.u.url,
    user,
    "GET",
    `/project/${stage.u.projectId}/${route}?${qs}`,
  );
}

/**
 * Empty the memory tables and the embed marks between tests (the universe
 * stays; Redis outlives a truncate).
 */
export async function clearMemory(): Promise<void> {
  await api.db.db.execute(
    sql`truncate memory_chunks, memory_documents restart identity cascade`,
  );
  await forgetEmbedMarks();
}

/**
 * Drop the Redis marks that say an embed run is queued, as when a queued job
 * is lost with them.
 */
export async function forgetEmbedMarks(): Promise<void> {
  const keys = await api.redis.redis.keys("hyp:memory-embed:*");
  if (keys.length > 0) await api.redis.redis.del(...keys);
}
