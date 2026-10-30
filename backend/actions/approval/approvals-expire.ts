import { type Action, config } from "keryx";
import { z } from "zod";
// Type-only, purely for the `declare module "keryx"` augmentation inside.
import type {} from "../../config/mcp";
import { expireDueApprovals } from "../../ops/ApprovalOps";

/**
 * `approvals:expire` — every minute, expire the approvals nobody decided in
 * time (read as denied) and wake their conversations. A clock: task-only,
 * never an HTTP route, unaudited, since nobody decided.
 */
export class ApprovalsExpire implements Action {
  name = "approvals:expire";
  description =
    "Expire tool-call approvals nobody decided in time and wake their conversations. Runs automatically on a timer; not exposed over HTTP.";
  mcp = { tool: false };
  task = { queue: "orchestrator", frequency: config.mcp.expireFrequencyMs };
  inputs = z.object({});

  /** @returns How many expired. */
  async run() {
    return { expired: await expireDueApprovals() };
  }
}
