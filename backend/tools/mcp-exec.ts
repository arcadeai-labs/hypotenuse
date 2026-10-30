import { config } from "keryx";
import { z } from "zod";
// Type-only, purely for the `declare module "keryx"` augmentation inside.
import type {} from "../config/mcp";
import type {} from "../config/memory";
import {
  approvalForIntent,
  infoWasRead,
  outcomeOfApproval,
} from "../ops/ApprovalOps";
import { allowance, callKey } from "../ops/ApprovalPatternOps";
import { previewOf, storeLargeResult } from "../ops/LargeResultOps";
import { callServerTool, McpUnauthorized } from "../ops/McpClientOps";
import { credentialValues } from "../ops/McpServerOps";
import { memoryPathInput } from "../ops/MemoryChunkOps";
import { hasServers, resolveTool, toolNameInput } from "./mcp-shared";
import { botWrite } from "./memory-shared";
import { type ToolDefinition, ToolError } from "./types";

const input = z.object({
  name: toolNameInput,
  args: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("The tool's arguments, matching the input schema mcp_info gave"),
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
      "Write the whole result into channel memory at this path instead of showing it to you; you get an acknowledgement. Use it for results you will search or reduce later",
    ),
});

const output = z.record(z.string(), z.unknown());

/**
 * Remove every credential value of the server from a text, as a backstop: no
 * credential should reach a result in the first place.
 * @param text - The text.
 * @param secrets - The values, longest first.
 * @returns The text, each value replaced by `[redacted]`.
 */
export function scrubCredentials(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) out = out.replaceAll(s, "[redacted]");
  return out;
}

/**
 * `mcp_exec` — call one tool on one of the bot's MCP servers. Unsafe to
 * replay. Refused until `mcp_info` was called for the tool in this
 * conversation; gated by the approval table in `ApprovalOps`.
 */
export const mcpExec: ToolDefinition<
  z.infer<typeof input>,
  z.infer<typeof output>
> = {
  name: "mcp_exec",
  description:
    "Call a tool on one of your MCP servers, by server/tool, with arguments matching its input schema. Call mcp_info for the tool first, in this conversation. A call that is not allowlisted waits for a person to approve it; the conversation pauses until they decide, and you then get its result, or a refusal you must not retry. A result too long to show whole comes back as a preview and an id for read_large_result; with saveTo, the whole result goes into channel memory instead.",
  inputSchema: input,
  outputSchema: output,
  replay: "unsafe",
  parallelSafe: false,
  available: hasServers,
  gate: async (args, ctx) => {
    const { server, binding, tool, name } = await resolveTool(ctx, args.name);
    if (!(await infoWasRead(ctx.db, ctx.conversation.id, name))) {
      throw new ToolError(
        "info_required",
        `Read ${name}'s input schema before calling it.`,
        `Call mcp_info with name "${name}", then call mcp_exec again with arguments that match it.`,
      );
    }
    const key = callKey(server.name, tool.name, args.args ?? {});
    const existing = await approvalForIntent(ctx.db, ctx.intentEntryId);
    if (existing) return outcomeOfApproval(ctx.db, existing, key);
    if (allowance(binding, server.name, tool).allowed) return { kind: "run" };
    return {
      kind: "park",
      draft: {
        callKey: key,
        server: server.name,
        tool: tool.name,
        args: args.args ?? {},
        reason: "not-allowlisted",
      },
    };
  },
  run: async (args, ctx) => {
    const { server, binding, tool, name } = await resolveTool(ctx, args.name);
    const callArgs = args.args ?? {};
    // Defense in depth: the tick runs this only after the gate said so.
    if (!allowance(binding, server.name, tool).allowed) {
      const approval = await approvalForIntent(ctx.db, ctx.intentEntryId);
      if (
        !approval ||
        approval.status !== "approved" ||
        !approval.executingAt ||
        approval.callKey !== callKey(server.name, tool.name, callArgs)
      ) {
        throw new ToolError(
          "approval_required",
          `${name} needs a person's approval, and this call has none.`,
          "Call it again through mcp_exec; it will wait for an approval.",
        );
      }
    }
    let result: Awaited<ReturnType<typeof callServerTool>>;
    try {
      result = await callServerTool(
        server,
        ctx.bot,
        tool.name,
        callArgs,
        ctx.signal,
      );
    } catch (error) {
      if (ctx.signal.aborted) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new ToolError(
        error instanceof McpUnauthorized ? "unauthorized" : "server_error",
        `${name} failed: ${message.slice(0, 500)}`,
        error instanceof McpUnauthorized
          ? "Tell the person the server's credentials need attention; do not retry."
          : "It may or may not have taken effect. Check before calling it again, or tell the person.",
      );
    }
    const secrets = credentialValues(server, ctx.bot);
    const text = scrubCredentials(result.text, secrets);
    if (result.isError) {
      throw new ToolError(
        "tool_error",
        `${name} reported an error: ${text.slice(0, 2_000)}`,
        "Read the error; fix the arguments and try again, or tell the person.",
      );
    }
    const body: Record<string, unknown> = { name, text };
    if (result.structuredContent !== undefined) {
      body.structuredContent = JSON.parse(
        scrubCredentials(JSON.stringify(result.structuredContent), secrets),
      );
    }
    if (result.attachments) body.attachments = result.attachments;
    const serialized = JSON.stringify(body);

    if (args.saveTo) {
      const content =
        result.structuredContent !== undefined && !text
          ? `\`\`\`json\n${JSON.stringify(body.structuredContent, null, 2)}\n\`\`\``
          : text;
      if (content.length > config.memory.maxDocumentChars) {
        const stored = await storeLargeResult(ctx.db, {
          projectId: ctx.bot.projectId,
          conversationId: ctx.conversation.id,
          entryId: ctx.intentEntryId,
          content,
          mimeType: "text/plain",
        });
        throw new ToolError(
          "too_large",
          `The result has ${content.length} characters, more than one memory document holds (${config.memory.maxDocumentChars}). It was stored as ${previewOf(stored).id} instead.`,
          "Read it with read_large_result and save the parts you need to memory with memory_write.",
        );
      }
      const { row } = await botWrite(ctx, "channel", args.saveTo.path, () => ({
        content: content || "(empty result)",
        description: `Result of ${name}`,
        changeNote: `Saved from ${name}`,
      }));
      return {
        name,
        saved: {
          path: row.logicalPath,
          scope: row.scope,
          versionId: row.versionId.getTime(),
        },
        totalChars: content.length,
      };
    }
    if (serialized.length > config.mcp.maxInlineChars) {
      const stored = await storeLargeResult(ctx.db, {
        projectId: ctx.bot.projectId,
        conversationId: ctx.conversation.id,
        entryId: ctx.intentEntryId,
        content: text || serialized,
        mimeType: text ? "text/plain" : "application/json",
      });
      return { name, ...previewOf(stored) };
    }
    return body;
  },
};
