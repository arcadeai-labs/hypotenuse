import { z } from "zod";
import { numberLines } from "../ops/MemoryChunkOps";
import { sectionVersion } from "../ops/PromptSectionOps";
import { findVisibleSection, sectionRefInput } from "./prompt-shared";
import { type ToolDefinition, ToolError } from "./types";

const input = z.object({
  section: sectionRefInput,
});

const output = z.object({
  id: z.number(),
  key: z.string(),
  title: z.string(),
  scope: z.enum(["bot", "project"]),
  loading: z.enum(["always", "contextual"]),
  editable: z.boolean(),
  version: z.number(),
  content: z.string(),
  totalLines: z.number(),
});

/**
 * `prompt_read` — one section of the bot's prompt, each line numbered for
 * `prompt_edit`, with its version. Replay safe.
 */
export const promptRead: ToolDefinition<
  z.infer<typeof input>,
  z.infer<typeof output>
> = {
  name: "prompt_read",
  description:
    "Read one section of your instructions in full, each line numbered, with its version (prompt_edit needs it as baseVersion) and whether you may edit it. [[ bash equivalent command: cat -n ]]",
  inputSchema: input,
  outputSchema: output,
  replay: "safe",
  parallelSafe: true,
  available: () => true,
  run: async (args, ctx) => {
    const section = await findVisibleSection(ctx.db, ctx, args.section);
    const version = await sectionVersion(
      ctx.db,
      section.id,
      section.currentVersion,
    );
    if (!version) {
      throw new ToolError(
        "not_found",
        `Section "${section.key}" has no text yet.`,
        "Call prompt_list again.",
      );
    }
    const { text, totalLines } = numberLines(version.body);
    return {
      id: section.id,
      key: section.key,
      title: version.title,
      scope: section.scope,
      loading: section.loading,
      editable: section.scope === "bot" && section.agentEditable,
      version: version.version,
      content: text,
      totalLines,
    };
  },
};
