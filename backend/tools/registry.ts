import { askQuestion } from "./ask-question";
import { complete } from "./complete";
import { escalateToHuman } from "./escalate-to-human";
import { fail } from "./fail";
import { goalList } from "./goal-list";
import { goalUpdate } from "./goal-update";
import { linearCommentCreate } from "./linear-comment-create";
import { linearIssueView } from "./linear-issue-view";
import { mcpExec } from "./mcp-exec";
import { mcpInfo } from "./mcp-info";
import { mcpListTools } from "./mcp-list-tools";
import { mcpSearch } from "./mcp-search";
import { memoryEdit } from "./memory-edit";
import { memoryForget } from "./memory-forget";
import { memoryList } from "./memory-list";
import { memoryRead } from "./memory-read";
import { memorySearch } from "./memory-search";
import { memoryWrite } from "./memory-write";
import { promptCreate } from "./prompt-create";
import { promptEdit } from "./prompt-edit";
import { promptList } from "./prompt-list";
import { promptRead } from "./prompt-read";
import {
  pylonAccountIssues,
  pylonAccountView,
  pylonContactView,
  pylonIssueView,
} from "./pylon-read";
import { pylonIssueUpdate, pylonReplyToCustomer } from "./pylon-write";
import { readLargeResult } from "./read-large-result";
import { replyAndWait } from "./reply-and-wait";
import { runCode } from "./run-code";
import { sandboxCancel } from "./sandbox-cancel";
import { sandboxMessage } from "./sandbox-message";
import { sandboxStart } from "./sandbox-start";
import { sandboxStatus } from "./sandbox-status";
import { sandboxWait } from "./sandbox-wait";
import { searchHistory } from "./search-history";
import { skillList } from "./skill-list";
import type { ToolContext, ToolDefinition } from "./types";
import { useSkill } from "./use-skill";
import { waitFor } from "./wait-for";

/**
 * The tool registry: every tool a bot may be offered, by name. The built-in
 * tools, the memory tools, the MCP meta-tools, the prompt, goal, and skill
 * tools, code mode's `run_code`, and — in a Linear session only — the
 * `linear_*` tools, and — on a Pylon issue only — the `pylon_*` tools
 * register here, as do the `sandbox_*` tools (`sandbox_start` when the bot's
 * sandbox policy allows it; the rest once the conversation has a job).
 */

/** Every registered tool. */
const TOOLS = new Map<string, ToolDefinition>();

/** The names of the terminal tools, which end a turn. */
export const TERMINAL_TOOL_NAMES = [
  "reply_and_wait",
  "complete",
  "fail",
  "wait_for",
  "ask_question",
  "escalate_to_human",
  "sandbox_wait",
] as const;

/**
 * Add a tool. A name already registered is refused, so two tools can never
 * shadow each other.
 * @param tool - The definition.
 * @throws {Error} When the name is taken or not `snake_case`.
 */
export function registerTool<I, O>(tool: ToolDefinition<I, O>): void {
  if (!/^[a-z][a-z0-9_]*$/.test(tool.name)) {
    throw new Error(`Tool names are snake_case: "${tool.name}"`);
  }
  if (TOOLS.has(tool.name)) {
    throw new Error(`A tool named "${tool.name}" is already registered`);
  }
  TOOLS.set(tool.name, tool as ToolDefinition);
}

/**
 * Remove a tool, if registered.
 * @param name - The tool's name.
 */
export function unregisterTool(name: string): void {
  TOOLS.delete(name);
}

/**
 * A tool by name.
 * @param name - The tool's name.
 * @returns The definition, or `undefined`.
 */
export function getTool(name: string): ToolDefinition | undefined {
  return TOOLS.get(name);
}

/**
 * The tools a bot is offered in a conversation, by name.
 * @param ctx - The bot and conversation.
 * @returns Every available tool, sorted by name so the prompt is stable.
 */
export async function availableTools(
  ctx: Pick<ToolContext, "bot" | "conversation">,
): Promise<ToolDefinition[]> {
  const all = [...TOOLS.values()];
  const shown = await Promise.all(all.map((tool) => tool.available(ctx)));
  return all
    .filter((_, i) => shown[i])
    .sort((a, b) => a.name.localeCompare(b.name));
}

for (const tool of [
  replyAndWait,
  complete,
  fail,
  waitFor,
  askQuestion,
  searchHistory,
  memorySearch,
  memoryList,
  memoryRead,
  memoryWrite,
  memoryEdit,
  memoryForget,
  mcpSearch,
  mcpListTools,
  mcpInfo,
  mcpExec,
  readLargeResult,
  promptList,
  promptRead,
  promptEdit,
  promptCreate,
  goalList,
  goalUpdate,
  skillList,
  useSkill,
  runCode,
  escalateToHuman,
  linearIssueView,
  linearCommentCreate,
  pylonIssueView,
  pylonAccountView,
  pylonAccountIssues,
  pylonContactView,
  pylonIssueUpdate,
  pylonReplyToCustomer,
  sandboxStart,
  sandboxStatus,
  sandboxMessage,
  sandboxCancel,
  sandboxWait,
] as ToolDefinition[]) {
  registerTool(tool);
}
