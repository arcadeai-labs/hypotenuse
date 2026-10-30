import { type Action, config } from "keryx";
import { z } from "zod";
// Type-only, purely for the `declare module "keryx"` augmentation inside.
import type {} from "../../config/agents";
import { reapExpiredLeases } from "../../ops/AgentClockOps";

/**
 * `agents:reap` — find `working` conversations whose lease expired (a tick
 * died holding it), owe each a tick, and enqueue it. A clock: task-only,
 * never an HTTP route, and not audited.
 */
export class AgentsReap implements Action {
  name = "agents:reap";
  description =
    "Re-wake conversations whose tick died holding them. Runs automatically on a timer; not exposed over HTTP.";
  mcp = { tool: false };
  task = { queue: "orchestrator", frequency: config.agents.reapFrequencyMs };
  inputs = z.object({});

  /** @returns The conversations reaped. */
  async run() {
    const reaped = await reapExpiredLeases();
    return { reaped };
  }
}
