import { api, config } from "keryx";
import { z } from "zod";
// Type-only, purely for the `declare module "keryx"` augmentation inside.
import type {} from "../../config/memory";
import { scrubCredentials } from "../../tools/mcp-exec";
import { mcpInfo } from "../../tools/mcp-info";
import { mcpListTools } from "../../tools/mcp-list-tools";
import { mcpSearch } from "../../tools/mcp-search";
import { resolveTool } from "../../tools/mcp-shared";
import { botWrite } from "../../tools/memory-shared";
import { ToolError } from "../../tools/types";
import {
  approvalForInterruption,
  consumeApproval,
  infoWasRead,
  markExecuting,
  outcomeOfApproval,
} from "../ApprovalOps";
import { allowance, callKey } from "../ApprovalPatternOps";
import { botServers } from "../McpCatalogOps";
import { callServerTool, McpUnauthorized } from "../McpClientOps";
import { credentialValues } from "../McpServerOps";
import { memoryPathInput } from "../MemoryChunkOps";
import {
  type HostFunctionDef,
  type HostResult,
  type HostScope,
  hostToolContext,
  refusal,
} from "./host-shared";
import { parseWith } from "./memory";
import { hostContext } from "./runtime";

/**
 * `mcp.*` in a program: the MCP meta-tools, and `mcp_exec`'s client and gate.
 *
 * | Allowlisted (or read-only with `autoAllowReadOnly`) | Resuming this interruption | Its approval | Then |
 * |---|---|---|---|
 * | yes | — | — | call it |
 * | no | no | — | **interrupt** before anything is sent; the tick writes an approval |
 * | no | yes | `approved`, not executing | mark it executing (committed), call it, consume it |
 * | no | yes | `denied` or `expired` | throw `approval_denied`, which the program may catch |
 * | no | yes | executing or consumed | refuse as `interrupted`: it may have been sent |
 * | no | yes | none, or a different call's | refuse; nothing is sent |
 *
 * `mcp_info` must have been read for the tool in this conversation, by the
 * model or by the program (`mcp.info`), as `mcp_exec` requires.
 */

/** The JSON a tool's arguments must be. */
const argsInput = z.record(z.string(), z.unknown());

/**
 * Split a guest's `(server, tool)` — or a single `server/tool` — into a name.
 * @param server - The server, or `server/tool`.
 * @param tool - The tool, when given apart.
 * @returns `server/tool`.
 */
function nameOf(server: string, tool: string | undefined): string {
  return tool === undefined ? server : `${server}/${tool}`;
}

/**
 * A tool's answer as a program wants it: JSON parsed when the text is JSON,
 * the structured content when there is no text, otherwise the text.
 * @param text - The result's text parts, joined and scrubbed.
 * @param structured - Its structured content, scrubbed.
 * @returns The value.
 */
function valueOf(text: string, structured: unknown): unknown {
  if (!text && structured !== undefined) return structured;
  const t = text.trim();
  if (t.startsWith("{") || t.startsWith("[")) {
    try {
      return JSON.parse(t);
    } catch {
      return text;
    }
  }
  return text;
}

/**
 * Gate and run one MCP call from a program.
 * @param scope - Where it runs.
 * @param name - `server/tool`.
 * @param args - Its arguments.
 * @returns The tool's text, structured content, and how the gate let it through,
 *   or an interruption for the tick to turn into an approval.
 * @throws {ToolError} A refusal the program reads.
 */
async function gatedCall(
  scope: HostScope,
  name: string,
  args: Record<string, unknown>,
): Promise<
  | {
      text: string;
      structured: unknown;
      name: string;
      gate: "allowed" | "approved";
      approvalId?: number;
    }
  | { interrupt: Record<string, unknown> }
> {
  const { ctx, run } = scope;
  const resolved = await resolveTool(ctx, name);
  const { server, binding, tool } = resolved;
  const full = resolved.name;
  if (!(await infoWasRead(ctx.db, ctx.conversation.id, full))) {
    throw new ToolError(
      "info_required",
      `Read ${full}'s input schema before calling it.`,
      `Call mcp.info("${server.name}", "${tool.name}") first — in this program or with mcp_info.`,
    );
  }
  const key = callKey(server.name, tool.name, args);
  let approvalId: number | undefined;
  if (!allowance(binding, server.name, tool).allowed) {
    const resume = hostContext().resume;
    if (!resume) {
      return {
        interrupt: {
          server: server.name,
          tool: tool.name,
          args,
          callKey: key,
        },
      };
    }
    const approval = await approvalForInterruption(
      ctx.db,
      run.id,
      resume.interruptionId,
    );
    if (!approval) {
      throw refusal(
        "approval_required",
        `${full} needs a person's approval, and this call has none.`,
        "Run the program again; the call will wait for an approval.",
        { name: full },
      );
    }
    const outcome = await outcomeOfApproval(ctx.db, approval, key);
    switch (outcome.kind) {
      case "run-approved": {
        const mine = await api.db.db.transaction((tx) =>
          markExecuting(tx, approval.id),
        );
        if (!mine) {
          throw refusal(
            "interrupted",
            `${full} may already have been sent by another worker.`,
            "Check its effect before calling it again.",
            { name: full, approvalId: approval.id },
          );
        }
        approvalId = approval.id;
        break;
      }
      case "refuse":
        throw refusal(
          outcome.output.error_type === "denied"
            ? "approval_denied"
            : outcome.output.error_type,
          outcome.output.message,
          outcome.output.next_action_hint,
          { name: full, gate: "denied", approvalId: approval.id },
        );
      default:
        throw refusal(
          "interrupted",
          `${full} may already have been sent before the worker stopped.`,
          "Check its effect before calling it again.",
          { name: full, approvalId: approval.id },
        );
    }
  }
  let result: Awaited<ReturnType<typeof callServerTool>>;
  try {
    result = await callServerTool(server, ctx.bot, tool.name, args, ctx.signal);
  } catch (error) {
    if (ctx.signal.aborted) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw refusal(
      error instanceof McpUnauthorized ? "unauthorized" : "server_error",
      `${full} failed: ${message.slice(0, 500)}`,
      error instanceof McpUnauthorized
        ? "The server's credentials need a person's attention; do not retry."
        : "It may or may not have taken effect. Check before calling it again.",
      { name: full, ...(approvalId ? { approvalId } : {}) },
    );
  } finally {
    if (approvalId !== undefined) {
      const id = approvalId;
      await api.db.db.transaction((tx) => consumeApproval(tx, id));
    }
  }
  const secrets = credentialValues(server, ctx.bot);
  const text = scrubCredentials(result.text, secrets);
  if (result.isError) {
    throw refusal(
      "tool_error",
      `${full} reported an error: ${text.slice(0, 2_000)}`,
      "Read the error; fix the arguments, or report it.",
      { name: full, ...(approvalId ? { approvalId } : {}) },
    );
  }
  const structured =
    result.structuredContent === undefined
      ? undefined
      : JSON.parse(
          scrubCredentials(JSON.stringify(result.structuredContent), secrets),
        );
  return {
    text,
    structured,
    name: full,
    gate: approvalId ? "approved" : "allowed",
    ...(approvalId ? { approvalId } : {}),
  };
}

/** The `mcp_*` host functions. */
export const mcpHost: Record<string, HostFunctionDef> = {
  mcp_list_tools: {
    fn: "mcp.listTools",
    mcp: true,
    args: z.tuple([z.string().optional()]),
    body: async (scope, [server]) => {
      if (server !== undefined) {
        const input = parseWith(
          mcpListTools.inputSchema,
          { server, limit: 100 },
          "mcp.listTools",
        );
        return {
          name: String(server),
          value: await mcpListTools.run(input, scope.ctx),
        };
      }
      const servers = await botServers(scope.ctx.db, scope.ctx.bot.id);
      const all: unknown[] = [];
      for (const s of servers) {
        all.push(
          await mcpListTools.run(
            { server: s.server.name, limit: 100 },
            scope.ctx,
          ),
        );
      }
      return { value: all };
    },
  },
  mcp_search: {
    fn: "mcp.search",
    mcp: true,
    args: z.tuple([z.string()]),
    body: async (scope, [query]) => {
      const input = parseWith(mcpSearch.inputSchema, { query }, "mcp.search");
      return { value: await mcpSearch.run(input, scope.ctx) };
    },
  },
  mcp_info: {
    fn: "mcp.info",
    mcp: true,
    args: z.tuple([z.string(), z.string().optional()]),
    body: async (scope, [server, tool]) => {
      const input = parseWith(
        mcpInfo.inputSchema,
        { name: nameOf(server as string, tool as string | undefined) },
        "mcp.info",
      );
      const out = (await mcpInfo.run(input, scope.ctx)) as { name: string };
      return { name: out.name, value: out };
    },
  },
  mcp_exec: {
    fn: "mcp.exec",
    mcp: true,
    args: z.union([
      z.tuple([z.string(), z.string(), argsInput.optional()]),
      z.tuple([z.string()]),
    ]),
    body: async (scope, [server, tool, args]) => {
      const name = nameOf(server as string, tool as string | undefined);
      const out = await gatedCall(
        scope,
        name,
        (args ?? {}) as Record<string, unknown>,
      );
      if ("interrupt" in out) return out;
      const result: HostResult = {
        name: out.name,
        gate: out.gate,
        value: valueOf(out.text, out.structured),
      };
      if (out.approvalId) result.approvalId = out.approvalId;
      return result;
    },
  },
  mcp_capture: {
    fn: "mcp.capture",
    mcp: true,
    args: z.tuple([z.string(), z.string(), argsInput, memoryPathInput]),
    body: async (scope, [server, tool, args, path]) => {
      const name = nameOf(server as string, tool as string);
      const out = await gatedCall(scope, name, args as Record<string, unknown>);
      if ("interrupt" in out) return out;
      const content =
        out.structured !== undefined && !out.text
          ? `\`\`\`json\n${JSON.stringify(out.structured, null, 2)}\n\`\`\``
          : out.text;
      if (content.length > config.memory.maxDocumentChars) {
        throw refusal(
          "too_large",
          `${out.name} answered ${content.length} characters, more than one memory document holds (${config.memory.maxDocumentChars}). Nothing was saved.`,
          "Call mcp.exec instead and reduce the result in the program before writing it.",
          { name: out.name, gate: out.gate },
        );
      }
      const { row } = await botWrite(
        hostToolContext(scope),
        "channel",
        path as string,
        () => ({
          content: content || "(empty result)",
          description: `Result of ${out.name}`,
          changeNote: `Captured from ${out.name} by run_code`,
        }),
      );
      return {
        name: out.name,
        gate: out.gate,
        ...(out.approvalId ? { approvalId: out.approvalId } : {}),
        value: {
          path: row.logicalPath,
          scope: row.scope,
          versionId: row.versionId.getTime(),
          bytesWritten: Buffer.byteLength(content, "utf8"),
        },
      };
    },
  },
};
