import { createHash } from "node:crypto";
import type { Bot } from "../schema/bots";
import type { Channel } from "../schema/channels";

/**
 * The prompt assembler: the system prompt a bot thinks with, built from what
 * the bot stores. Prompt sections, skills, goals, and a generated
 * capabilities section extend it later; what it returns must stay a pure
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
 * Assemble a bot's system prompt for a conversation.
 * @param bot - The bot.
 * @param channel - Where the conversation is.
 * @returns The prompt text.
 */
export function assembleSystemPrompt(bot: Bot, channel: Channel): string {
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
  return [identity, "", bot.persona.trim(), "", where, "", LOOP_RULES].join(
    "\n",
  );
}

/**
 * The sha256 of a prompt, recorded on every step so a change is visible.
 * @param prompt - The prompt text.
 * @returns The hex digest.
 */
export function promptHash(prompt: string): string {
  return createHash("sha256").update(prompt).digest("hex");
}
