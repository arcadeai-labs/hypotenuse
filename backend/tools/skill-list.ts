import { z } from "zod";
import { loadSkillIndex } from "../ops/PromptOps";
import type { ToolDefinition } from "./types";

const input = z.object({});

const output = z.object({
  skills: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      arguments: z.array(
        z.object({
          name: z.string(),
          description: z.string().optional(),
          required: z.boolean(),
          default: z.string().optional(),
        }),
      ),
    }),
  ),
});

/** `skill_list` — the skills attached to the bot, with their arguments. Replay safe. */
export const skillList: ToolDefinition<
  z.infer<typeof input>,
  z.infer<typeof output>
> = {
  name: "skill_list",
  description:
    "List the skills you may use — procedures your team wrote down — with each one's arguments: which are required, and their defaults.",
  inputSchema: input,
  outputSchema: output,
  replay: "safe",
  parallelSafe: true,
  available: () => true,
  run: async (_args, ctx) => ({
    skills: (await loadSkillIndex(ctx.db, ctx.bot.id)).sort((a, b) =>
      a.name.localeCompare(b.name),
    ),
  }),
};
