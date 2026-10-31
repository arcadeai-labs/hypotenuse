import { and, eq } from "drizzle-orm";
import {
  type Action,
  type ActionParams,
  api,
  ErrorType,
  HTTP_METHOD,
  TypedError,
} from "keryx";
import { z } from "zod";
import { AdminMiddleware } from "../../middleware/rbac";
import { idInput } from "../../ops/InputOps";
import { serializeTriggerEvent } from "../../ops/TriggerEventOps";
import { triggerEvents } from "../../schema/trigger_events";

/**
 * `trigger-event:view` — one platform delivery, with its payload. Project
 * admins only.
 */
export class TriggerEventView implements Action {
  name = "trigger-event:view";
  description =
    "Get one platform delivery: its payload as received, its outcome, and what processing decided (an automatic binding, the conversation it reached). Project admins only.";
  middleware = [AdminMiddleware()];
  web = {
    route: "/project/:projectId/trigger-event/:triggerEventId",
    method: HTTP_METHOD.GET,
  };
  inputs = z.object({
    projectId: idInput("The project"),
    triggerEventId: idInput("The event"),
  });

  /**
   * @param params - The inputs.
   * @returns The event and its payload.
   */
  async run(params: ActionParams<TriggerEventView>) {
    const [row] = await api.db.db
      .select()
      .from(triggerEvents)
      .where(
        and(
          eq(triggerEvents.id, params.triggerEventId),
          eq(triggerEvents.projectId, params.projectId),
        ),
      )
      .limit(1);
    if (!row) {
      throw new TypedError({
        message: "Event not found in this project",
        type: ErrorType.CONNECTION_ACTION_NOT_FOUND,
      });
    }
    return {
      triggerEvent: { ...serializeTriggerEvent(row), payload: row.payload },
    };
  }
}
