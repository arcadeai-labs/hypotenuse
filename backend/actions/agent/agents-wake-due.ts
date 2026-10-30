import { type Action, config } from "keryx";
import { z } from "zod";
// Type-only, purely for the `declare module "keryx"` augmentation inside.
import type {} from "../../config/agents";
import { wakeDue } from "../../ops/AgentClockOps";

/**
 * `agents:wake-due` — re-enqueue ticks that are owed but were never run, wake
 * conversations whose timer is due, and wake those whose question went
 * unanswered past its timeout. A clock: task-only, never an HTTP route, and
 * not audited.
 */
export class AgentsWakeDue implements Action {
  name = "agents:wake-due";
  description =
    "Wake conversations that are owed a tick, whose timer is due, or whose question timed out. Runs automatically on a timer; not exposed over HTTP.";
  mcp = { tool: false };
  task = { queue: "orchestrator", frequency: config.agents.wakeDueFrequencyMs };
  inputs = z.object({});

  /** @returns What it woke. */
  async run() {
    return wakeDue();
  }
}
