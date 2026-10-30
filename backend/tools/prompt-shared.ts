import { and, eq, isNull, or } from "drizzle-orm";
import { z } from "zod";
import type { DbHandle } from "../ops/DbOps";
import { type PromptSection, promptSections } from "../schema/prompt_sections";
import { type ToolContext, ToolError } from "./types";

/**
 * What the prompt tools share: the input naming a section, and the lookup
 * that confines every call to the bot's own sections and its project's — a
 * section of another bot is the same not-found as a missing one.
 */

/** The input naming a section: its id or its key. */
export const sectionRefInput = z
  .union([z.number().int().positive(), z.string().trim().min(1).max(64)])
  .describe("The section's id or key, as prompt_list shows them");

/**
 * Find a section the bot can see: its own, or its project's.
 * @param db - A database handle.
 * @param ctx - The call's context.
 * @param ref - An id or a key.
 * @param options.lock - Take its row lock.
 * @returns The section.
 * @throws {ToolError} `not_found`.
 */
export async function findVisibleSection(
  db: DbHandle,
  ctx: Pick<ToolContext, "bot">,
  ref: number | string,
  options: { lock?: boolean } = {},
): Promise<PromptSection> {
  const visible = or(
    eq(promptSections.botId, ctx.bot.id),
    and(eq(promptSections.scope, "project"), isNull(promptSections.botId)),
  );
  const query = db
    .select()
    .from(promptSections)
    .where(
      and(
        eq(promptSections.projectId, ctx.bot.projectId),
        eq(promptSections.archived, false),
        visible,
        typeof ref === "number"
          ? eq(promptSections.id, ref)
          : eq(promptSections.key, ref.toLowerCase()),
      ),
    )
    // A key may name both a bot section and a project section: the bot's wins.
    .orderBy(promptSections.scope);
  const rows = options.lock ? await query.for("update") : await query;
  const row = rows[0];
  if (!row) {
    throw new ToolError(
      "not_found",
      `No section ${typeof ref === "number" ? ref : `"${ref}"`} in your prompt.`,
      "Call prompt_list for the sections you have, by id and key.",
    );
  }
  return row;
}

/**
 * Refuse a change to a section the bot may not edit, naming who can.
 * @param section - The section.
 * @throws {ToolError} `not_editable`.
 */
export function assertAgentEditable(section: PromptSection): void {
  if (section.scope === "project") {
    throw new ToolError(
      "not_editable",
      `"${section.title}" is a project section, shared by every bot in the project; no bot can change it.`,
      "A project admin changes it on the project's Prompt settings. If it is wrong, say so in your reply; to keep something yourself, write it into one of your editable sections.",
    );
  }
  if (!section.agentEditable) {
    throw new ToolError(
      "not_editable",
      `"${section.title}" is not editable by you.`,
      "A person who can edit this bot changes it on the bot's Prompt tab. To keep something yourself, write it into a section prompt_list shows as editable, or prompt_create one.",
    );
  }
}
