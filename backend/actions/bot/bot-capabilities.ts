import { type Action, type ActionParams } from "keryx";
import { z } from "zod";
import { regenerateCapabilities } from "../../ops/CapabilitiesOps";
import { idInput } from "../../ops/InputOps";

/**
 * `bot:capabilities` — regenerate a bot's capabilities summary from the MCP
 * catalog it can see. Task-only, never an HTTP route; unaudited machine work
 * recorded on `bots.capabilities`.
 */
export class BotCapabilities implements Action {
  name = "bot:capabilities";
  description =
    "Regenerate the summary of what a bot's MCP tools can do. Runs in the background; not exposed over HTTP.";
  mcp = { tool: false };
  task = { queue: "default" };
  inputs = z.object({ botId: idInput("The bot") });

  /**
   * @param params - The bot.
   * @returns Whether the summary changed.
   */
  async run(params: ActionParams<BotCapabilities>) {
    return { changed: await regenerateCapabilities(params.botId) };
  }
}
