import type { LanguageModelUsage } from "ai";
import { and, eq, gte, sql } from "drizzle-orm";
import type { Bot } from "../schema/bots";
import type { Conversation } from "../schema/conversations";
import { costRecords } from "../schema/cost_records";
import type { DbHandle } from "./DbOps";

/**
 * The spend ledger: one `cost_records` row per model step, written in the
 * step's transaction, with usage exactly as the provider reported it.
 */

/** What a step's cost row is attributed to, copied rather than joined. */
export interface StepAttribution {
  conversation: Conversation;
  stepId: string;
  modelConnectionId: number | null;
  provider: string;
  model: string;
}

/**
 * The cost a provider reported for a call, when it reported one. The Vercel
 * AI Gateway puts it in its provider metadata; nobody else reports a price.
 * @param providerMetadata - The step's provider metadata.
 * @returns US dollars, or `null`.
 */
export function reportedCostUsd(providerMetadata: unknown): number | null {
  const gateway = (providerMetadata as { gateway?: { cost?: unknown } } | null)
    ?.gateway;
  const cost = Number(gateway?.cost);
  return gateway?.cost !== undefined && Number.isFinite(cost) ? cost : null;
}

/**
 * Write a step's cost row.
 * @param tx - The step's transaction.
 * @param attribution - Who and what the step was.
 * @param usage - The AI SDK's usage.
 * @param costUsd - What the provider said it cost, if it said.
 */
export async function recordStepCost(
  tx: DbHandle,
  attribution: StepAttribution,
  usage: LanguageModelUsage,
  costUsd: number | null,
): Promise<void> {
  const c = attribution.conversation;
  await tx.insert(costRecords).values({
    projectId: c.projectId,
    botId: c.botId,
    channelId: c.channelId,
    conversationId: c.id,
    epoch: c.epoch,
    stepId: attribution.stepId,
    modelConnectionId: attribution.modelConnectionId,
    provider: attribution.provider,
    model: attribution.model,
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    cachedInputTokens: usage.inputTokenDetails?.cacheReadTokens ?? 0,
    reasoningTokens: usage.outputTokenDetails?.reasoningTokens ?? 0,
    costUsd: costUsd === null ? null : String(costUsd),
  });
}

/**
 * Whether a bot's monthly budget is already spent, counting only the cost
 * providers reported. A bot with no budget is never over it.
 * @param db - A database handle.
 * @param bot - The bot.
 * @returns The spend and the budget when over, else `null`.
 */
export async function budgetExceeded(
  db: DbHandle,
  bot: Bot,
): Promise<{ spent: number; budget: number } | null> {
  if (bot.monthlyBudgetUsd === null) return null;
  const budget = Number(bot.monthlyBudgetUsd);
  const now = new Date();
  const monthStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
  );
  const [row] = await db
    .select({
      spent: sql<string>`coalesce(sum(${costRecords.costUsd}), 0)`,
    })
    .from(costRecords)
    .where(
      and(
        eq(costRecords.botId, bot.id),
        gte(costRecords.createdAt, monthStart),
      ),
    );
  const spent = Number(row?.spent ?? 0);
  return spent >= budget ? { spent, budget } : null;
}
