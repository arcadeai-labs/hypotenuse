import { eq } from "drizzle-orm";
import { type ActionResponse, api } from "keryx";
import type { BotCreate } from "../../actions/bot/bot-create";
import type { ConversationCreate } from "../../actions/conversation/conversation-create";
import type { ConversationEntries } from "../../actions/conversation/conversation-entries";
import type { ConversationMessage } from "../../actions/conversation/conversation-message";
import { conversationEntries } from "../../schema/conversation_entries";
import { type Conversation, conversations } from "../../schema/conversations";
import { type ModelServer, startModelServer } from "../fixtures/model-server";
import {
  buildTestUniverse,
  call,
  runAction,
  type TestUniverse,
  type TestUser,
} from "../setup";

/**
 * The agent suites' shared stage: the seeded universe, a scripted model
 * server, a model connection of one provider kind pointing at it with
 * `default` and `fast` defined, and a bot in Castle. Everything is set up
 * over HTTP, and every tick is run the way a worker runs it — by taking the
 * job off its Redis queue and acting it.
 */

// The AI SDK warns on the console about unknown model ids; these are scripted.
(globalThis as { AI_SDK_LOG_WARNINGS?: boolean }).AI_SDK_LOG_WARNINGS = false;

/** The key the scripted model server accepts. */
export const MODEL_KEY = "sk-agent-suite-key-0000";

/** The agent suites' stage. */
export interface AgentStage {
  u: TestUniverse;
  models: ModelServer;
  botId: number;
  connectionId: number;
}

/** The queues the loop uses, cleared at the start of every suite. */
const LOOP_QUEUES = ["agents", "outbox", "orchestrator", "default"];

/**
 * Build the stage.
 * @param provider - Which wire format the bot's models speak.
 * @returns The stage.
 */
export async function buildAgentStage(
  provider: "anthropic" | "openai-compatible" = "anthropic",
): Promise<AgentStage> {
  const u = await buildTestUniverse();
  await clearLoopQueues();
  const models = startModelServer({ apiKey: MODEL_KEY });
  const created = await call<{ modelConnection: { id: number } }>(
    u.url,
    u.peach,
    "PUT",
    `/project/${u.projectId}/model-connection`,
    {
      name: "Scripted",
      provider,
      baseUrl: models.baseUrl(provider),
      apiKey: MODEL_KEY,
    },
  );
  if (created.status !== 200) throw new Error(JSON.stringify(created.body));
  const connectionId = created.body.modelConnection.id;
  for (const [name, modelId] of [
    ["default", "scripted-large"],
    ["fast", "scripted-small"],
  ]) {
    const alias = await call(
      u.url,
      u.peach,
      "PUT",
      `/project/${u.projectId}/model-alias`,
      { name, connectionId, modelId },
    );
    if (alias.status !== 200) throw new Error(JSON.stringify(alias.body));
  }
  const bot = await call<ActionResponse<BotCreate>>(
    u.url,
    u.peach,
    "PUT",
    `/project/${u.projectId}/bot`,
    {
      name: "Toadsworth",
      persona: "You are the castle steward. You are brief and kind.",
    },
  );
  if (bot.status !== 200) throw new Error(JSON.stringify(bot.body));
  return { u, models, botId: bot.body.bot.id, connectionId };
}

/** Empty the loop's queues and delayed jobs, which outlive a suite's database. */
export async function clearLoopQueues(): Promise<void> {
  for (const q of LOOP_QUEUES) await api.resque.queue.delQueue(q);
  for (const timestamp of await api.resque.queue.timestamps()) {
    for (const job of await api.resque.queue
      .delayedAt(timestamp)
      .then((d) => d.tasks)) {
      await api.resque.queue.delDelayed(job.queue, job.class, job.args);
    }
  }
}

/** One job as Resque stores it. */
interface QueuedJob {
  class: string;
  queue: string;
  args: Record<string, unknown>[];
}

/**
 * Take every job off a queue, oldest first, and act it the way a worker
 * would, repeating until the queue stays empty. Jobs the acted ones enqueue
 * are run too.
 * @param queue - The queue.
 * @param options.max - Give up after this many jobs (a loop that never settles is a bug).
 * @param options.only - Run only jobs of this action; others are put back.
 * @param options.limit - Stop quietly after this many jobs, leaving the rest queued.
 * @returns The jobs run, by action name.
 */
export async function drainQueue(
  queue = "agents",
  options: { max?: number; only?: string; limit?: number } = {},
): Promise<string[]> {
  const ran: string[] = [];
  const max = options.max ?? 100;
  const skipped: QueuedJob[] = [];
  for (;;) {
    if (options.limit !== undefined && ran.length >= options.limit) break;
    const [job] = (await api.resque.queue.queued(queue, 0, 0)) as QueuedJob[];
    if (!job) break;
    await api.resque.queue.del(queue, job.class, job.args, 1);
    if (options.only && job.class !== options.only) {
      skipped.push(job);
      continue;
    }
    if (ran.length >= max)
      throw new Error(`${queue} did not settle in ${max} jobs`);
    ran.push(job.class);
    await runAction(job.class, job.args[0] ?? {});
  }
  for (const job of skipped) {
    await api.resque.queue.enqueue(queue, job.class, job.args);
  }
  return ran;
}

/**
 * Run every queued tick until none is left.
 * @returns How many ticks ran.
 */
export async function runTicks(): Promise<number> {
  return (await drainQueue("agents", { only: "agent:tick" })).length;
}

/**
 * Start a conversation over HTTP.
 * @param stage - The stage.
 * @param text - The first message.
 * @param extra - More inputs.
 * @param user - Who starts it (Peach by default).
 * @returns The status and body.
 */
export async function startConversation(
  stage: AgentStage,
  text: string,
  extra: Record<string, unknown> = {},
  user: TestUser = stage.u.peach,
) {
  return call<ActionResponse<ConversationCreate>>(
    stage.u.url,
    user,
    "PUT",
    `/project/${stage.u.projectId}/bot/${stage.botId}/conversation`,
    { text, ...extra },
  );
}

/**
 * Send a message over HTTP.
 * @param stage - The stage.
 * @param conversationId - The conversation.
 * @param text - The message.
 * @param extra - More inputs (`delivery`, `requestId`).
 * @param user - Who sends it (Peach by default).
 * @returns The status and body.
 */
export async function sendMessage(
  stage: AgentStage,
  conversationId: number,
  text: string,
  extra: Record<string, unknown> = {},
  user: TestUser = stage.u.peach,
) {
  return call<ActionResponse<ConversationMessage>>(
    stage.u.url,
    user,
    "PUT",
    `/project/${stage.u.projectId}/conversation/${conversationId}/message`,
    { text, ...extra },
  );
}

/**
 * Read a transcript over HTTP.
 * @param stage - The stage.
 * @param conversationId - The conversation.
 * @param since - Only entries after this seq.
 * @returns The body.
 */
export async function readEntries(
  stage: AgentStage,
  conversationId: number,
  since?: number,
) {
  const res = await call<ActionResponse<ConversationEntries>>(
    stage.u.url,
    stage.u.peach,
    "GET",
    `/project/${stage.u.projectId}/conversation/${conversationId}/entries?limit=100${since !== undefined ? `&since=${since}` : ""}`,
  );
  if (res.status !== 200) throw new Error(JSON.stringify(res.body));
  return res.body;
}

/**
 * The conversation row.
 * @param id - The conversation.
 * @returns The row.
 */
export async function conversationRow(id: number): Promise<Conversation> {
  const [row] = await api.db.db
    .select()
    .from(conversations)
    .where(eq(conversations.id, id));
  return row;
}

/**
 * The transcript in a compact form for asserting order: `kind` or
 * `kind:role`, `tool_call_intent:<tool>`, `tool_result:<tool>`, and
 * `status_change:<from>→<to>`.
 * @param conversationId - The conversation.
 * @returns One string per entry.
 */
export async function shape(conversationId: number): Promise<string[]> {
  const rows = await api.db.db
    .select()
    .from(conversationEntries)
    .where(eq(conversationEntries.conversationId, conversationId))
    .orderBy(conversationEntries.seq);
  return rows.map((r) => {
    const c = r.content as Record<string, unknown>;
    switch (r.kind) {
      case "message":
        return `message:${r.role}`;
      case "tool_call_intent":
      case "tool_result":
        return `${r.kind}:${r.toolName}`;
      case "status_change":
        return `status_change:${c.from}→${c.to}`;
      default:
        return r.kind;
    }
  });
}

/**
 * Move a conversation's clocks by writing its columns, the way the clock
 * suites move time.
 * @param id - The conversation.
 * @param set - The columns to write.
 */
export async function setColumns(
  id: number,
  set: Partial<typeof conversations.$inferInsert>,
): Promise<void> {
  await api.db.db
    .update(conversations)
    .set(set)
    .where(eq(conversations.id, id));
}

/**
 * Wait until a predicate holds, polling.
 * @param check - The predicate.
 * @param timeoutMs - How long to wait.
 */
export async function until(
  check: () => Promise<boolean> | boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(10);
  }
  throw new Error("timed out waiting");
}

/**
 * Take a queued tick off the `agents` queue — the oldest, or the oldest for
 * one conversation — and start it without waiting, for a test that acts
 * while the tick is mid-step.
 * @param conversationId - Only a tick for this conversation.
 * @returns The running tick.
 */
export async function startTick(conversationId?: number): Promise<unknown> {
  const jobs = (await api.resque.queue.queued("agents", 0, -1)) as QueuedJob[];
  const job = jobs.find(
    (j) =>
      j.class === "agent:tick" &&
      (conversationId === undefined ||
        Number(j.args[0]?.conversationId) === conversationId),
  );
  if (!job) throw new Error("no tick is queued");
  await api.resque.queue.del("agents", job.class, job.args, 1);
  const running = runAction(job.class, job.args[0] ?? {});
  // Surface a failure where the test awaits it, not as unhandled.
  running.catch(() => {});
  return running;
}

/**
 * Wait until the scripted server has received this many completion requests.
 * @param stage - The stage.
 * @param count - How many.
 */
export async function untilRequests(
  stage: AgentStage,
  count: number,
): Promise<void> {
  await until(() => stage.models.completions.length >= count);
}
