import { type Action, config } from "keryx";
import { z } from "zod";
// Type-only, purely for the `declare module "keryx"` augmentation inside.
import type {} from "../../config/platforms";
import { expireDueHelpRequests } from "../../ops/HelpOps";

/**
 * `help:expire` — expire help requests nobody answered in time, telling each
 * conversation so (and waking a blocked one). A clock: task-only, never an
 * HTTP route, and not audited, since nobody decided.
 */
export class HelpExpire implements Action {
  name = "help:expire";
  description =
    "Expire help requests nobody answered in time. Runs automatically on a timer; not exposed over HTTP.";
  mcp = { tool: false };
  task = {
    queue: "orchestrator",
    frequency: config.platforms.helpExpireFrequencyMs,
  };
  inputs = z.object({});

  /** @returns How many expired. */
  async run() {
    return { expired: await expireDueHelpRequests() };
  }
}
