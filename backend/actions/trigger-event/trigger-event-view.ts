import { eq } from "drizzle-orm";
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
import { isAdmin } from "../../ops/MembershipOps";
import {
  eventLogQuery,
  serializeTriggerEvent,
} from "../../ops/TriggerEventOps";
import { triggerEvents } from "../../schema/trigger_events";

/**
 * `trigger-event:view` — one event of a project's log: what it did and how
 * it was routed, and, for an admin, the body Linear sent. The payload is
 * admin-only because the workspace sends every issue change, not only the
 * issues `@hypotenuse` works on, so it carries more than a member otherwise
 * sees. Requires membership; the same not-found for another project's event
 * as for none.
 */
export class TriggerEventView implements Action {
  name = "trigger-event:view";
  description =
    "Show one webhook event a project's Linear workspace sent: what it did and how its work was routed (role, routing rule, runner, or why it is waiting). Includes the raw payload for project admins only. Requires membership in the project.";
  middleware = [ProjectMemberMiddleware()];
  web = { route: "/trigger-event/:id", method: HTTP_METHOD.GET };
  inputs = z.object({
    projectId: z.coerce
      .number()
      .int()
      .positive()
      .describe("The project the event belongs to"),
    id: z.coerce.number().int().positive().describe("The event's id"),
  });

  /**
   * @param params - The project and event.
   * @param connection - The caller, whose tags decide whether the payload is shown.
   * @returns The event, and its payload or null.
   * @throws {TypedError} `CONNECTION_ACTION_NOT_FOUND` when it is not in the project.
   */
  async run(
    params: ActionParams<TriggerEventView>,
    connection: Connection<SessionImpl, RbacConnectionMeta>,
  ) {
    const [row] = await eventLogQuery(
      params.projectId,
      eq(triggerEvents.id, params.id),
    );
    if (!row) {
      throw new TypedError({
        message: "Event not found",
        type: ErrorType.CONNECTION_ACTION_NOT_FOUND,
      });
    }
    const admin = isAdmin(connection.metadata.callerTags ?? []);
    const payload = admin
      ? ((
          await api.db.db
            .select({ payload: triggerEvents.payload })
            .from(triggerEvents)
            .where(eq(triggerEvents.id, row.event.id))
        )[0]?.payload ?? null)
      : null;
    return { triggerEvent: serializeTriggerEvent(row), payload };
  }
}
