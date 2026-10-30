import { askQuestion } from "./ask-question";
import { complete } from "./complete";
import { fail } from "./fail";
import { memoryEdit } from "./memory-edit";
import { memoryForget } from "./memory-forget";
import { memoryList } from "./memory-list";
import { memoryRead } from "./memory-read";
import { memorySearch } from "./memory-search";
import { memoryWrite } from "./memory-write";
import { replyAndWait } from "./reply-and-wait";
import { searchHistory } from "./search-history";
import type { ToolContext, ToolDefinition } from "./types";
import { waitFor } from "./wait-for";

/**
 * The tool registry: every tool a bot may be offered, by name. The built-in
 * tools and the memory tools register here; MCP and code mode add theirs through
 * {@link registerTool}.
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
export function availableTools(
  ctx: Pick<ToolContext, "bot" | "conversation">,
): ToolDefinition[] {
  return [...TOOLS.values()]
    .filter((tool) => tool.available(ctx))
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
] as ToolDefinition[]) {
  registerTool(tool);
}
