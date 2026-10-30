import { type Action, config } from "keryx";
import { z } from "zod";
// Type-only, purely for the `declare module "keryx"` augmentation inside.
import type {} from "../../config/mcp";
import { sweepLargeResults } from "../../ops/LargeResultOps";

/**
 * `large-results:sweep` — daily, delete the large results of conversations
 * that ended more than `MCP_LARGE_RESULT_RETENTION_DAYS` ago. A clock:
 * task-only, never an HTTP route, unaudited.
 */
export class LargeResultsSweep implements Action {
  name = "large-results:sweep";
  description =
    "Delete stored large tool results of conversations that ended long ago. Runs automatically on a timer; not exposed over HTTP.";
  mcp = { tool: false };
  task = {
    queue: "orchestrator",
    frequency: config.mcp.largeResultSweepFrequencyMs,
  };
  inputs = z.object({});

  /** @returns How many were deleted. */
  async run() {
    return { deleted: await sweepLargeResults() };
  }
}
