import { type Action, type ActionParams } from "keryx";
import { z } from "zod";
import { broadcastSessionsChanged } from "../../ops/SessionChannelOps";

/**
 * `sessions:broadcast` — the trailing frame of a coalesced burst: when the
 * outbox sends a session's activities faster than one frame a second, the
 * frames after the first are folded into this one, enqueued for the end of
 * the window, so the burst's last activity still wakes the dashboard.
 *
 * Task-only, never MCP, unaudited: it writes nothing.
 */
export class SessionsBroadcast implements Action {
  name = "sessions:broadcast";
  description =
    "Tell a project's dashboards one agent session changed. Enqueued by the activity outbox; not exposed over HTTP.";
  mcp = { tool: false };
  task = { queue: "triggers" };
  inputs = z.object({
    agentSessionId: z.coerce
      .number()
      .int()
      .positive()
      .describe("The agent session that changed"),
  });

  /**
   * @param params - The session.
   * @returns The session announced.
   */
  async run(params: ActionParams<SessionsBroadcast>) {
    await broadcastSessionsChanged([params.agentSessionId]);
    return { agentSessionId: params.agentSessionId };
  }
}
