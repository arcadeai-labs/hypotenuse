import {
  type Action,
  type ActionParams,
  api,
  type Connection,
  ErrorType,
  HTTP_METHOD,
  TypedError,
} from "keryx";
import { z } from "zod";
import {
  ProjectMemberMiddleware,
  type RbacConnectionMeta,
} from "../../middleware/rbac";
import type { SessionImpl } from "../../middleware/session";
import { loadReadableBot } from "../../ops/BotOps";
import { idInput } from "../../ops/InputOps";

/**
 * `bot:avatar` — a bot's avatar image, as the raw bytes. Requires membership
 * and the bot's read list. Never an MCP tool: the answer is binary.
 *
 * Served from our own database rather than linked, so the dashboard never
 * depends on a third-party URL staying up. The `v` query parameter in
 * `avatarUrl` changes with every edit, so the image may be cached privately.
 */
export class BotAvatar implements Action {
  name = "bot:avatar";
  description =
    "Get a bot's avatar image (PNG or JPEG bytes). Requires membership and the bot's read access.";
  middleware = [ProjectMemberMiddleware()];
  web = {
    route: "/project/:projectId/bot/:botId/avatar",
    method: HTTP_METHOD.GET,
  };
  inputs = z.object({
    projectId: idInput("The project"),
    botId: idInput("The bot whose avatar to get"),
    v: z
      .string()
      .max(32)
      .optional()
      .describe("A cache-busting version; ignored"),
  });

  /**
   * @param params - `projectId` and `botId`.
   * @param connection - The caller's connection (tags set by the middleware).
   * @returns The image as a raw `Response`.
   * @throws {TypedError} `CONNECTION_ACTION_NOT_FOUND` for a bot the caller cannot
   *   read, or one with no avatar.
   */
  async run(
    params: ActionParams<BotAvatar>,
    connection: Connection<SessionImpl, RbacConnectionMeta>,
  ) {
    const bot = await loadReadableBot(
      api.db.db,
      params.projectId,
      params.botId,
      connection.metadata.callerTags ?? [],
    );
    if (!bot.avatar || !bot.avatarMimeType) {
      throw new TypedError({
        message: "This bot has no avatar",
        type: ErrorType.CONNECTION_ACTION_NOT_FOUND,
      });
    }
    return new Response(new Uint8Array(bot.avatar), {
      status: 200,
      headers: {
        "Content-Type": bot.avatarMimeType,
        "Content-Length": String(bot.avatar.length),
        "Cache-Control": "private, max-age=86400",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }
}
