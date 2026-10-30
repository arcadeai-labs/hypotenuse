import { and, eq } from "drizzle-orm";
import { api } from "keryx";
import { z } from "zod";
import {
  agentSectionCount,
  alwaysTokensAfter,
  freeKey,
  keyFromTitle,
  nextPosition,
  overBudgetMessage,
  SECTION_BODY_MAX,
} from "../ops/PromptSectionOps";
import { bots } from "../schema/bots";
import {
  promptSections,
  promptSectionVersions,
} from "../schema/prompt_sections";
import { findVisibleSection } from "./prompt-shared";
import { type ToolDefinition, ToolError } from "./types";

const input = z.object({
  title: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .describe("The section's heading, e.g. Release process"),
  body: z
    .string()
    .min(1)
    .max(SECTION_BODY_MAX)
    .describe("What the section says, markdown"),
  loading: z
    .enum(["always", "contextual"])
    .optional()
    .describe(
      "contextual (the default): included only when one of its keywords comes up; always: in every step",
    ),
  keywords: z
    .array(z.string().trim().toLowerCase().min(1).max(40))
    .max(30)
    .optional()
    .describe(
      "Words that bring a contextual section in; omit to use the title's words",
    ),
  changeNote: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .describe("Why you are adding it, in a sentence a person will read"),
});

const output = z.object({
  id: z.number(),
  key: z.string(),
  version: z.number(),
});

/**
 * `prompt_create` — add a section of the bot's own, always editable by it and
 * contextual unless asked otherwise, capped at `bots.maxAgentSections`. Unsafe
 * to replay; a retried call finds the section its intent already created.
 */
export const promptCreate: ToolDefinition<
  z.infer<typeof input>,
  z.infer<typeof output>
> = {
  name: "prompt_create",
  description:
    "Add a section to your own instructions for something you should always know how to do here — a procedure, a convention, a team's vocabulary. It is contextual by default: included only when one of its keywords comes up. You may edit it later with prompt_edit, and people can see and revert it. Facts about the work belong in memory instead.",
  inputSchema: input,
  outputSchema: output,
  replay: "unsafe",
  parallelSafe: false,
  available: () => true,
  run: async (args, ctx) => {
    const [already] = await ctx.db
      .select()
      .from(promptSectionVersions)
      .where(
        and(
          eq(promptSectionVersions.entryId, ctx.intentEntryId),
          eq(promptSectionVersions.conversationId, ctx.conversation.id),
        ),
      );
    if (already) {
      const section = await findVisibleSection(ctx.db, ctx, already.sectionId);
      return { id: section.id, key: section.key, version: already.version };
    }
    return api.db.db.transaction(async (tx) => {
      // The bot's row lock serializes creations, so the cap holds under races.
      const [bot] = await tx
        .select()
        .from(bots)
        .where(eq(bots.id, ctx.bot.id))
        .for("update");
      const made = await agentSectionCount(tx, bot.id);
      if (made >= bot.maxAgentSections) {
        throw new ToolError(
          "limit_reached",
          `You have created ${made} sections, the most this bot may (${bot.maxAgentSections}).`,
          "Fold this into a section you already created with prompt_edit, or keep it in memory with memory_write.",
        );
      }
      const loading = args.loading ?? "contextual";
      const position = await nextPosition(tx, bot.projectId, bot.id);
      const key = await freeKey(
        tx,
        bot.projectId,
        bot.id,
        keyFromTitle(args.title),
      );
      if (loading === "always") {
        const { tokens, budget } = await alwaysTokensAfter(tx, bot, {
          id: -1,
          key,
          scope: "bot",
          loading,
          keywords: args.keywords ?? [],
          agentEditable: true,
          position,
          version: 1,
          title: args.title,
          body: args.body,
        });
        if (tokens > budget) {
          throw new ToolError(
            "over_budget",
            overBudgetMessage(bot.name, tokens, budget),
            "Create it contextual instead, with keywords that bring it in when it matters.",
          );
        }
      }
      const [section] = await tx
        .insert(promptSections)
        .values({
          projectId: bot.projectId,
          scope: "bot",
          botId: bot.id,
          key,
          title: args.title,
          loading,
          keywords: args.keywords ?? [],
          agentEditable: true,
          position,
          origin: "agent",
          currentVersion: 1,
        })
        .returning();
      await tx.insert(promptSectionVersions).values({
        sectionId: section.id,
        version: 1,
        title: args.title,
        body: args.body,
        source: "agent",
        conversationId: ctx.conversation.id,
        entryId: ctx.intentEntryId,
        changeNote: args.changeNote,
      });
      return { id: section.id, key: section.key, version: 1 };
    });
  },
};
