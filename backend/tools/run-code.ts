import { z } from "zod";
import {
  type RunCodeInput,
  resumeCodeRun,
  startCodeRun,
} from "../ops/CodeRunOps";
import { fullPrimer } from "../ops/code/primer";
import { memoryPathInput } from "../ops/MemoryChunkOps";
import type { ToolDefinition } from "./types";

const input = z.object({
  source: z
    .string()
    .min(1)
    .describe(
      'A TypeScript or JavaScript function body; top-level await and return work. Pass "?" to get the API, limits, and examples instead of running anything',
    ),
  saveTo: z
    .object({
      path: memoryPathInput,
      scope: z
        .literal("channel")
        .optional()
        .describe("Only channel memory: what you learned here"),
    })
    .optional()
    .describe(
      "Write the returned value into channel memory at this path, as JSON, instead of returning it; you get an acknowledgement and a preview",
    ),
  changeNote: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .optional()
    .describe("Why you are saving it, with saveTo"),
});

const output = z.record(z.string(), z.unknown());

/**
 * `run_code` — code mode: a short program in a WebAssembly sandbox that
 * calls the bot's memory and MCP tools and returns a small answer, so large
 * intermediate data never passes through the model. Unsafe to replay and
 * never parallel. A gated call inside the program pauses it before the call's
 * effect; the conversation waits for every approval of the batch, and
 * recovery resumes the same program (`resume`), never a rewritten one.
 */
export const runCode: ToolDefinition<
  z.infer<typeof input>,
  z.infer<typeof output>
> = {
  name: "run_code",
  description:
    "[[ bash equivalent command: bun -e '<source>' ]] Run a short TypeScript program in an isolated sandbox whose globals are your memory (memory.search/list/read/write), your MCP tools (mcp.search/info/exec/capture), and console.log. Prefer it to calling tools one by one when you would fetch, filter, join, or count more data than you need to see: fetch once, reduce in the program, return a small answer. Calls that need approval pause the program until a person decides, then it continues. Pass source \"?\" for the API and examples.",
  inputSchema: input,
  outputSchema: output,
  replay: "unsafe",
  parallelSafe: false,
  available: (ctx) => ctx.bot.codeModeEnabled,
  run: async (args, ctx) => {
    if (args.source.trim() === "?") return { primer: fullPrimer() };
    return startCodeRun(args as RunCodeInput, ctx) as Promise<
      z.infer<typeof output>
    >;
  },
  resume: async (args, ctx) => {
    if (args.source.trim() === "?") return { primer: fullPrimer() };
    return resumeCodeRun(args as RunCodeInput, ctx) as Promise<
      z.infer<typeof output>
    >;
  },
};
