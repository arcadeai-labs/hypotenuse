import { and, asc, eq, isNull, or } from "drizzle-orm";
import { z } from "zod";
import { promptSections } from "../schema/prompt_sections";
import type { ToolDefinition } from "./types";

const input = z.object({});

const output = z.object({
  sections: z.array(
    z.object({
      id: z.number(),
      key: z.string(),
      title: z.string(),
      scope: z.enum(["bot", "project"]),
      loading: z.enum(["always", "contextual"]),
      keywords: z.array(z.string()),
      editable: z.boolean(),
      version: z.number(),
    }),
  ),
  agentSectionsLeft: z.number(),
});

/**
 * `prompt_list` — the sections of the bot's prompt: its own and its
 * project's, with which it may edit. Replay safe: it only reads.
 */
export const promptList: ToolDefinition<
  z.infer<typeof input>,
  z.infer<typeof output>
> = {
  name: "prompt_list",
  description:
    "List the sections of your own instructions: your sections and your project's, each with its id, key, title, when it loads (always, or contextual on its keywords), current version, and whether you may edit it. Also says how many more sections prompt_create may add.",
  inputSchema: input,
  outputSchema: output,
  replay: "safe",
  parallelSafe: true,
  available: () => true,
  run: async (_args, ctx) => {
    const rows = await ctx.db
      .select()
      .from(promptSections)
      .where(
        and(
          eq(promptSections.projectId, ctx.bot.projectId),
          eq(promptSections.archived, false),
          or(
            eq(promptSections.botId, ctx.bot.id),
            and(
              eq(promptSections.scope, "project"),
              isNull(promptSections.botId),
            ),
          ),
        ),
      )
      .orderBy(asc(promptSections.position), asc(promptSections.id));
    const ordered = [
      ...rows.filter((r) => r.scope === "project"),
      ...rows.filter((r) => r.scope === "bot"),
    ];
    const created = rows.filter(
      (r) => r.scope === "bot" && r.origin === "agent",
    ).length;
    return {
      sections: ordered.map((r) => ({
        id: r.id,
        key: r.key,
        title: r.title,
        scope: r.scope,
        loading: r.loading,
        keywords: r.keywords,
        editable: r.scope === "bot" && r.agentEditable,
        version: r.currentVersion,
      })),
      agentSectionsLeft: Math.max(0, ctx.bot.maxAgentSections - created),
    };
  },
};
