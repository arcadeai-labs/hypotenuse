import { z } from "zod";
import { allowance } from "../ops/ApprovalPatternOps";
import { hasServers, resolveTool, toolNameInput } from "./mcp-shared";
import type { ToolDefinition } from "./types";

const input = z.object({ name: toolNameInput });

const output = z.object({
  name: z.string(),
  title: z.string().nullable(),
  description: z.string(),
  inputSchema: z.record(z.string(), z.unknown()),
  annotations: z.record(z.string(), z.unknown()),
  needsApproval: z.boolean(),
});

/**
 * `mcp_info` — read one tool's description, input schema, and annotations.
 * Its result is the record that the tool's info was read in this
 * conversation, which `mcp_exec` requires first. Safe to replay.
 */
export const mcpInfo: ToolDefinition<
  z.infer<typeof input>,
  z.infer<typeof output>
> = {
  name: "mcp_info",
  description:
    "Read one MCP tool's full description, input schema, and annotations. You must call this for a tool, in this conversation, before you mcp_exec it. Says whether calling it waits for a person's approval.",
  inputSchema: input,
  outputSchema: output,
  replay: "safe",
  parallelSafe: true,
  available: hasServers,
  run: async (args, ctx) => {
    const { server, binding, tool, name } = await resolveTool(ctx, args.name);
    return {
      name,
      title: tool.title ?? tool.annotations?.title ?? null,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: tool.annotations ?? {},
      needsApproval: !allowance(binding, server.name, tool).allowed,
    };
  },
};
