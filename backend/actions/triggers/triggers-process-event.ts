import type { Action, ActionParams } from "keryx";
import { z } from "zod";
import { idInput } from "../../ops/InputOps";
import { processTriggerEvent } from "../../ops/TriggerEventOps";

/**
 * `triggers:process-event` — apply the processing rules to one recorded
 * platform delivery. Enqueued by ingress. Not audited: machine work,
 * recorded in `trigger_events` and `conversation_inbox` (an approval a
 * participant decides is audited inside, as `actorType: participant`).
 */
export class TriggersProcessEvent implements Action {
  name = "triggers:process-event";
  description =
    "Process one platform delivery. Enqueued by the server; not exposed over HTTP.";
  mcp = { tool: false };
  task = { queue: "ingress" };
  inputs = z.object({ triggerEventId: idInput("The event") });

  /**
   * @param params - The event.
   * @returns Its status and outcome, or null when it was not ours.
   */
  async run(params: ActionParams<TriggersProcessEvent>) {
    return { result: await processTriggerEvent(params.triggerEventId, true) };
  }
}
