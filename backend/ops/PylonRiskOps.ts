import { generateText, Output } from "ai";
import { z } from "zod";
import type { Bot } from "../schema/bots";
import { languageModel } from "./ModelOps";

/**
 * **The risk check** a customer reply passes before it may be sent without a
 * person, under `customerReplyPolicy: auto-on-low-risk`. The bot's `fast`
 * model reads the draft and answers `low` or `high`; anything it cannot
 * answer — a failed call, an unreadable answer — is `high`, so a doubt
 * always goes to a person.
 */

/** What the risk check answers. */
export interface ReplyRisk {
  risk: "low" | "high";
  reason: string;
}

/** The answer the fast model must give. */
const riskSchema = z.object({
  risk: z.enum(["low", "high"]),
  reason: z.string().max(500),
});

/** What the fast model is told. */
const INSTRUCTIONS = `You review a support agent's draft reply to a customer before it is sent with nobody checking it.

Answer "high" if the draft does any of these, or if you are unsure:
- promises or discusses a refund, credit, discount, price, invoice, or contract term;
- touches anything legal, compliance, privacy, or a security incident or vulnerability;
- commits the company to a date, a fix, a feature, or any other promise;
- answers a customer who is angry, threatening to leave, or escalating;
- asks the customer for a password, a token, or other secret.

Answer "low" only for a plainly informational answer (how to use the product, where a setting is, a documented procedure) that commits to nothing.

Give a one-sentence reason.`;

/**
 * Rate a draft reply.
 * @param bot - The bot, whose `fast` alias is used.
 * @param draft - The reply's text.
 * @param signal - Aborts the call when the tick stops.
 * @returns The rating; `high` on any failure.
 */
export async function rateReplyRisk(
  bot: Bot,
  draft: string,
  signal?: AbortSignal,
): Promise<ReplyRisk> {
  try {
    const fast = await languageModel(bot.projectId, bot.fastModelAlias);
    const { output } = await generateText({
      model: fast.model,
      instructions: INSTRUCTIONS,
      prompt: `The draft reply:\n\n${draft.slice(0, 8000)}`,
      output: Output.object({ schema: riskSchema }),
      maxRetries: 1,
      ...(signal ? { abortSignal: signal } : {}),
    });
    return { risk: output.risk, reason: output.reason };
  } catch (e) {
    if (signal?.aborted) throw e;
    return {
      risk: "high",
      reason: `The risk check could not decide (${e instanceof Error ? e.message.slice(0, 200) : "unknown"}), so a person decides.`,
    };
  }
}
