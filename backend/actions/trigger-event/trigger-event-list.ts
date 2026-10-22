import { and, count, eq, gte, ne } from "drizzle-orm";
import {
  type Action,
  type ActionParams,
  api,
  HTTP_METHOD,
  paginate,
  paginationInputs,
} from "keryx";
import { z } from "zod";
import { ProjectMemberMiddleware } from "../../middleware/rbac";
import { booleanInput } from "../../ops/RoutingOps";
import {
  eventLogQuery,
  serializeTriggerEvent,
} from "../../ops/TriggerEventOps";
import { integrations } from "../../schema/integrations";
import {
  TRIGGER_EVENT_OUTCOMES,
  triggerEvents,
} from "../../schema/trigger_events";

/**
 * `trigger-event:list` — a project's event log: every webhook delivery its
 * Linear workspace sent, newest first, with what processing did and how the
 * work was routed — the session's role and the rule that chose it, and the
 * turn's status, runner, or why it waits, read live. Kept for
 * `LINEAR_EVENT_RETENTION_DAYS`. Never the payload (`trigger-event:view`
 * shows it to admins). Requires membership. Paginated.
 */
export class TriggerEventList implements Action {
  name = "trigger-event:list";
  description =
    "List the webhook events a project's Linear workspace sent, newest first, with what each did and how its work was routed (role, routing rule, runner, or why it is waiting). Optionally filtered by event type, outcome, agent session, or time. Requires membership in the project. Paginated.";
  middleware = [ProjectMemberMiddleware()];
  web = { route: "/trigger-events", method: HTTP_METHOD.GET };
  inputs = paginationInputs({ defaultLimit: 25 }).extend({
    projectId: z.coerce
      .number()
      .int()
      .positive()
      .describe("The project whose events to list"),
    eventType: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .optional()
      .describe(
        "Only events of this type, e.g. AgentSessionEvent, Issue, PermissionChange",
      ),
    outcome: z
      .enum(TRIGGER_EVENT_OUTCOMES)
      .optional()
      .describe("Only events with this outcome"),
    hideIgnored: booleanInput
      .optional()
      .describe("Leave out events Hypotenuse did not act on"),
    agentSessionId: z.coerce
      .number()
      .int()
      .positive()
      .optional()
      .describe("Only events about this agent session"),
    // An all-digits string is epoch ms: `new Date("1754000000000")` is invalid.
    since: z
      .preprocess(
        (v) => (typeof v === "string" && /^\d+$/.test(v) ? Number(v) : v),
        z.coerce.date(),
      )
      .optional()
      .describe(
        "Only events received at or after this time, as ISO-8601 or epoch milliseconds",
      ),
  });

  /**
   * @param params - The project, filters, and pagination.
   * @returns This page of events plus pagination metadata.
   */
  async run(params: ActionParams<TriggerEventList>) {
    const where = and(
      params.eventType
        ? eq(triggerEvents.eventType, params.eventType)
        : undefined,
      params.outcome ? eq(triggerEvents.outcome, params.outcome) : undefined,
      params.hideIgnored ? ne(triggerEvents.outcome, "ignored") : undefined,
      params.agentSessionId
        ? eq(triggerEvents.agentSessionId, params.agentSessionId)
        : undefined,
      params.since ? gte(triggerEvents.receivedAt, params.since) : undefined,
    );
    const result = await paginate(
      eventLogQuery(params.projectId, where),
      api.db.db
        .select({ count: count() })
        .from(triggerEvents)
        .innerJoin(
          integrations,
          eq(integrations.id, triggerEvents.integrationId),
        )
        .where(and(eq(integrations.projectId, params.projectId), where)),
      params,
    );
    return {
      triggerEvents: result.data.map(serializeTriggerEvent),
      pagination: result.pagination,
    };
  }
}
