import { and, eq } from "drizzle-orm";
import { api } from "keryx";
import { z } from "zod";
import { applyLinePatches, linePatchInput } from "../ops/MemoryChunkOps";
import {
  alwaysTokensAfter,
  asSectionInput,
  overBudgetMessage,
  SECTION_BODY_MAX,
  sectionVersion,
  writeSectionVersion,
} from "../ops/PromptSectionOps";
import { promptSectionVersions } from "../schema/prompt_sections";
import {
  assertAgentEditable,
  findVisibleSection,
  sectionRefInput,
} from "./prompt-shared";
import { type ToolDefinition, ToolError } from "./types";

const input = z.object({
  section: sectionRefInput,
  patches: z
    .array(linePatchInput)
    .min(1)
    .max(50)
    .describe(
      "Line-range replacements, by the line numbers prompt_read showed",
    ),
  baseVersion: z
    .number()
    .int()
    .positive()
    .describe(
      "The version prompt_read returned; the edit is refused if the section changed since",
    ),
  changeNote: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .describe("Why you are changing it, in a sentence a person will read"),
});

const output = z.object({
  id: z.number(),
  key: z.string(),
  version: z.number(),
});

/**
 * `prompt_edit` — patch lines of one of the bot's own editable sections, as a
 * new version recording the conversation and the call that wrote it. Unsafe
 * to replay; a retried call finds the version its intent already wrote.
 */
export const promptEdit: ToolDefinition<
  z.infer<typeof input>,
  z.infer<typeof output>
> = {
  name: "prompt_edit",
  description:
    "Change lines of one of your own instructions' editable sections: each patch replaces start_line through end_line (as prompt_read numbered them) with content; end_line 0 inserts before start_line; empty content deletes. Pass the version you read as baseVersion. The change applies from your next step, and every version is kept for people to review and revert. Only sections prompt_list marks editable can be changed. [[ bash equivalent command: sed -i ]]",
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
      const section = await findVisibleSection(tx, ctx, args.section, {
        lock: true,
      });
      assertAgentEditable(section);
      if (section.currentVersion !== args.baseVersion) {
        throw new ToolError(
          "version_conflict",
          `"${section.key}" changed since version ${args.baseVersion}; the current version is ${section.currentVersion}.`,
          `Call prompt_read for "${section.key}" again and make your edit against version ${section.currentVersion}.`,
        );
      }
      const current = await sectionVersion(
        tx,
        section.id,
        section.currentVersion,
      );
      let body: string;
      try {
        body = applyLinePatches(current?.body ?? "", args.patches);
      } catch (error) {
        throw new ToolError(
          "invalid_patch",
          error instanceof Error ? error.message : String(error),
          "Read the section again for its line numbers, and send patches that do not overlap.",
        );
      }
      if (body.length > SECTION_BODY_MAX) {
        throw new ToolError(
          "too_long",
          `The section would be ${body.length} characters; the limit is ${SECTION_BODY_MAX}.`,
          "Shorten what you add, or move detail into memory with memory_write.",
        );
      }
      if (section.loading === "always") {
        const { tokens, budget } = await alwaysTokensAfter(
          tx,
          ctx.bot,
          asSectionInput(section, section.title, body),
        );
        if (tokens > budget) {
          throw new ToolError(
            "over_budget",
            overBudgetMessage(ctx.bot.name, tokens, budget),
            "Shorten the section, or keep the detail in memory with memory_write instead.",
          );
        }
      }
      const written = await writeSectionVersion(tx, section, {
        body,
        source: "agent",
        conversationId: ctx.conversation.id,
        entryId: ctx.intentEntryId,
        changeNote: args.changeNote,
      });
      return {
        id: section.id,
        key: section.key,
        version: written.version.version,
      };
    });
  },
};
