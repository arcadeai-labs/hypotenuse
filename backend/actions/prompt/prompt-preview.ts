import { and, eq } from "drizzle-orm";
import { type Action, type ActionParams, api, HTTP_METHOD } from "keryx";
import { z } from "zod";
import type { AuditedConnection } from "../../classes/AuditedAction";
import { ProjectMemberMiddleware } from "../../middleware/rbac";
import { loadReadableBot } from "../../ops/BotOps";
import { conversationNotFound } from "../../ops/ConversationOps";
import { idInput } from "../../ops/InputOps";
import { botHasServers } from "../../ops/McpCatalogOps";
import { assemblePrompt, loadPromptInputs } from "../../ops/PromptOps";
import { channels } from "../../schema/channels";
import { conversations } from "../../schema/conversations";

/**
 * `prompt:preview` — the system prompt a bot would be sent, assembled
 * exactly as a tick assembles it: in one of its conversations (its channel,
 * title, and newest message) or in a stand-in API channel, with an optional
 * sample message deciding which contextual sections match.
 */
export class PromptPreview implements Action {
  name = "prompt:preview";
  description =
    "Preview the system prompt a bot would be sent: the exact text, its sha256 hash, which sections were included and which contextual ones matched but were dropped for the token budget, and the context terms they were matched on. Pass a sample message to see which contextual sections it brings in, and a conversationId to assemble it as that conversation's next step would. Needs the bot's read access.";
  middleware = [ProjectMemberMiddleware()];
  web = {
    route: "/project/:projectId/bot/:botId/prompt-preview",
    method: HTTP_METHOD.GET,
  };
  inputs = z.object({
    projectId: idInput("The project"),
    botId: idInput("The bot"),
    message: z
      .string()
      .max(20_000)
      .optional()
      .describe(
        "A sample message, as the latest a person sent; decides which contextual sections match",
      ),
    conversationId: idInput(
      "Assemble as this conversation's next step would",
    ).optional(),
  });

  /**
   * @param params - The inputs.
   * @param connection - The caller's connection.
   * @returns The prompt.
   */
  async run(
    params: ActionParams<PromptPreview>,
    connection: AuditedConnection,
  ) {
    const db = api.db.db;
    const bot = await loadReadableBot(
      db,
      params.projectId,
      params.botId,
      connection.metadata.callerTags ?? [],
    );
    let channel: { type: string; name: string } = {
      type: "api",
      name: "default",
    };
    let conversation: { id: number; title: string | null } | null = null;
    if (params.conversationId !== undefined) {
      const [row] = await db
        .select({ conversation: conversations, channel: channels })
        .from(conversations)
        .innerJoin(channels, eq(channels.id, conversations.channelId))
        .where(
          and(
            eq(conversations.id, params.conversationId),
            eq(conversations.botId, bot.id),
          ),
        );
      if (!row) throw conversationNotFound();
      channel = row.channel;
      conversation = row.conversation;
    }
    const mcp = await botHasServers(db, bot.id);
    const inputs = await loadPromptInputs(db, bot, {
      channel: channel as { type: "api"; name: string },
      conversation,
      message: params.message ?? null,
      mcp,
    });
    const assembled = assemblePrompt(inputs);
    const byId = new Map(inputs.sections.map((s) => [s.id, s]));
    const describe = (ref: { id: number; version: number }) => {
      const s = byId.get(ref.id);
      return {
        id: ref.id,
        key: s?.key ?? "",
        title: s?.title ?? "",
        scope: s?.scope ?? "bot",
        loading: s?.loading ?? "always",
        version: ref.version,
        estimatedTokens: s ? Math.ceil(s.body.length / 4) : 0,
      };
    };
    return {
      prompt: {
        system: assembled.system,
        hash: assembled.hash,
        sections: assembled.sections.map(describe),
        dropped: assembled.dropped.map(describe),
        contextTerms: assembled.contextTerms,
        estimatedTokens: assembled.estimatedTokens,
        budgetTokens: assembled.budgetTokens,
        overBudget: assembled.overBudget,
        mcp,
      },
    };
  }
}
