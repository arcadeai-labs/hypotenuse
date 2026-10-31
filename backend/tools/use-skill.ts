import { z } from "zod";
import {
  attachedSkill,
  renderSkill,
  SkillArgumentError,
} from "../ops/SkillOps";
import { type ToolDefinition, ToolError } from "./types";

const input = z.object({
  name: z.string().trim().min(1).max(64).describe("The skill's name"),
  arguments: z
    .union([z.string().max(4_000), z.record(z.string(), z.string())])
    .optional()
    .describe(
      'The arguments: an object of named values ({"since": "v2.1"}), or a string as a person would type after /<name> ("v2.1 customers", or since:v2.1)',
    ),
});

const output = z.object({
  name: z.string(),
  version: z.number(),
  instructions: z.string(),
});

/**
 * `use_skill` — the rendered body of one of the bot's attached skills, at its
 * pinned or current version, for the model to follow in the same turn.
 * Replay safe: it only reads.
 */
export const useSkill: ToolDefinition<
  z.infer<typeof input>,
  z.infer<typeof output>
> = {
  name: "use_skill",
  description:
    "Get the instructions of one of your skills, filled in with your arguments, then follow them in this turn. Your instructions list the skills you have; skill_list shows their arguments.",
  inputSchema: input,
  outputSchema: output,
  replay: "safe",
  parallelSafe: true,
  available: () => true,
  run: async (args, ctx) => {
    const found = await attachedSkill(ctx.db, ctx.bot.id, args.name);
    if (!found) {
      throw new ToolError(
        "not_found",
        `You have no skill "${args.name}".`,
        "Call skill_list for the skills you have.",
      );
    }
    try {
      return {
        name: found.skill.name,
        version: found.version.version,
        instructions: renderSkill(
          found.version.body,
          found.version.arguments,
          args.arguments,
        ),
      };
    } catch (error) {
      if (error instanceof SkillArgumentError) {
        throw new ToolError(
          "invalid_arguments",
          error.message,
          `Call skill_list for "${found.skill.name}"'s arguments, then use_skill again with every required one.`,
        );
      }
      throw error;
    }
  },
};
