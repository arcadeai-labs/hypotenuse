import { and, count, desc, eq, like, ne } from "drizzle-orm";
import {
  type Action,
  type ActionParams,
  api,
  HTTP_METHOD,
  paginate,
  paginationInputs,
} from "keryx";
import { z } from "zod";
import { AdminMiddleware } from "../../middleware/rbac";
import { idInput } from "../../ops/InputOps";
import { serializeTriggerEvent } from "../../ops/TriggerEventOps";
import {
  TRIGGER_EVENT_STATUSES,
  triggerEvents,
} from "../../schema/trigger_events";

/**
 * `trigger-event:list` — every platform delivery the project's bots
 * received, newest first, with what processing decided. Project admins only:
 * the payloads are what people wrote.
 *
 * A `github` event's `botInstallationId` column holds a
 * `github_installations` id, not a bot installation's, so the
 * `botInstallationId` filter never matches one (a bot installation and a
 * GitHub installation can share a number); `githubInstallationId` filters
 * GitHub's, and `type` filters by platform.
 */
export class TriggerEventList implements Action {
  name = "trigger-event:list";
  description =
    "List the platform deliveries this project's bots received, newest first, each with its outcome (processed: message, ignored: unbound, ignored: loop, ignored: rate-limited…). Filter by status, outcome, platform type, a bot installation, or a GitHub installation. Project admins only. Paginated.";
  middleware = [AdminMiddleware()];
  web = {
    route: "/project/:projectId/trigger-events",
    method: HTTP_METHOD.GET,
  };
  inputs = paginationInputs({ defaultLimit: 25 }).extend({
    projectId: idInput("The project"),
    status: z
      .enum(TRIGGER_EVENT_STATUSES)
      .optional()
      .describe("Only this status"),
    outcome: z
      .string()
      .trim()
      .max(60)
      .optional()
      .describe(
        "Only this outcome, or outcomes starting with it, e.g. unbound",
      ),
    type: z
      .string()
      .trim()
      .regex(/^[a-z][a-z0-9_-]*$/)
      .max(40)
      .optional()
      .describe("Only this platform's: slack, linear, pylon, webhook, github…"),
    botInstallationId: idInput(
      "Only this bot installation's (never a github event)",
    ).optional(),
    githubInstallationId: idInput(
      "Only this attached GitHub installation's github events",
    ).optional(),
  });

  /**
   * @param params - The inputs.
   * @returns The events and pagination metadata.
   */
  async run(params: ActionParams<TriggerEventList>) {
    const where = and(
      eq(triggerEvents.projectId, params.projectId),
      params.status ? eq(triggerEvents.status, params.status) : undefined,
      params.outcome
        ? like(triggerEvents.outcome, `${params.outcome.replace(/[%_]/g, "")}%`)
        : undefined,
      params.type ? eq(triggerEvents.type, params.type) : undefined,
      // The column means a bot installation on every type but github.
      params.botInstallationId
        ? and(
            eq(triggerEvents.botInstallationId, params.botInstallationId),
            ne(triggerEvents.type, "github"),
          )
        : undefined,
      params.githubInstallationId
        ? and(
            eq(triggerEvents.botInstallationId, params.githubInstallationId),
            eq(triggerEvents.type, "github"),
          )
        : undefined,
    );
    const result = await paginate(
      api.db.db
        .select()
        .from(triggerEvents)
        .where(where)
        .orderBy(desc(triggerEvents.id))
        .$dynamic(),
      api.db.db.select({ count: count() }).from(triggerEvents).where(where),
      params,
    );
    return {
      triggerEvents: result.data.map(serializeTriggerEvent),
      pagination: result.pagination,
    };
  }
}
