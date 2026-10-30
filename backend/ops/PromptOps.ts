import { createHash } from "node:crypto";
import type { Bot } from "../schema/bots";
import type { Channel } from "../schema/channels";

/**
 * The prompt assembler: the system prompt a bot thinks with, built from what
 * the bot stores. Its MCP section carries the bot's generated capabilities;
 * prompt sections, skills, and goals extend it later; what it returns must stay a pure
 * function of stored rows, so its hash changes only when they do.
 */

/**
 * The rules every bot follows about ending a turn, stated once.
 */
const LOOP_RULES = [
  "## How you work",
  "",
  "You are in a conversation that may last a long time and outlive any one process. Every turn you take must end by calling exactly one of these tools:",
  "",
  "- `reply_and_wait` — post your reply and wait for the next message.",
  "- `ask_question` — ask something you need to know, and wait for the answer.",
  "- `wait_for` — pause until a time, then carry on.",
  "- `complete` — the work is done; post a summary and close the conversation.",
  "- `fail` — you cannot do it; say why and what would help.",
  "",
  "Text you write outside those tools is not shown to anyone. Call other tools as often as you need first. If a tool result says a call was interrupted, check its effects before repeating it.",
].join("\n");

/**
 * How memory works, stated once: the two scopes, and search before write.
 */
const MEMORY_RULES = [
  "## What you remember",
  "",
  "You have a memory that outlasts this conversation, in two scopes:",
  "",
  "- **channel** — what you have learned in this channel. Only you, here, can see it.",
  "- **project** — what is shared by every bot in every channel of the project. Only a person adds to it.",
  "",
  "Before answering from what you think you know, `memory_search` it. When you learn something durable — a decision, a preference, how something is done, who is who — `memory_write` it to channel memory, or `memory_edit` the document that already covers it. `memory_forget` what turns out to be wrong. Memories you do not use fade over time.",
].join("\n");

/**
 * How MCP tools work, stated once: search, read, then call; approvals.
 */
const MCP_RULES = [
  "## Your tools",
  "",
  "You can use tools on MCP servers your project connected. You do not see them all at once:",
  "",
  "1. `mcp_search` for what you want to do (or `mcp_list_tools` for one server).",
  "2. `mcp_info` on the tool you choose — required before you call it, once per conversation.",
  "3. `mcp_exec` it with arguments that match its input schema.",
  "",
  "Some calls wait for a person to approve them; the conversation pauses until they decide. If a call is denied, do not retry it — try another way, or ask. A result too long to show comes back as a preview with an id for `read_large_result`.",
].join("\n");

/**
 * Assemble a bot's system prompt for a conversation.
 * @param bot - The bot.
 * @param channel - Where the conversation is.
 * @param extras.mcp - Whether the bot has MCP servers, so the tools section
 *   and its capabilities are included.
 * @returns The prompt text.
 */
export function assembleSystemPrompt(
  bot: Bot,
  channel: Channel,
  extras: { mcp?: boolean } = {},
): string {
  const identity = [
    `You are ${bot.displayName}${bot.name !== bot.displayName ? ` (${bot.name})` : ""}, a bot.`,
    bot.description ? bot.description : null,
  ]
    .filter(Boolean)
    .join(" ");
  const where =
    channel.type === "api"
      ? `You are talking to a person or program over the HTTP API, in the "${channel.name}" channel. Your replies are markdown.`
      : `You are in the ${channel.type} channel "${channel.name}".`;
  return [
    identity,
    "",
    bot.persona.trim(),
    "",
    where,
    "",
    LOOP_RULES,
    "",
    MEMORY_RULES,
    ...(extras.mcp
      ? [
          "",
          MCP_RULES,
          ...(bot.capabilities
            ? ["", "What your tools can do:", "", bot.capabilities.trim()]
            : []),
        ]
      : []),
  ].join("\n");
}

/**
 * The sha256 of a prompt, recorded on every step so a change is visible.
 * @param prompt - The prompt text.
 * @returns The hex digest.
 */
export function promptHash(prompt: string): string {
  return createHash("sha256").update(prompt).digest("hex");
}
