import { type Action, type ActionParams, HTTP_METHOD } from "keryx";
import { z } from "zod";
import { ProjectMemberMiddleware } from "../../middleware/rbac";
import {
  getIntegration,
  integrationConfigured,
  serializeIntegration,
} from "../../ops/IntegrationOps";
import { recentDeliveries } from "../../ops/TriggerEventOps";
import { TRIGGER_TYPES } from "../../schema/integrations";

/**
 * `integration:view` — one of the project's integrations, by trigger type:
 * the workspace, the app user, granted scopes, token expiry, any refresh error,
 * and the last-seen rate-limit headroom. Also says whether this deployment can
 * connect that type at all, so a client can explain a disabled Connect button.
 * Never returns a token. Requires membership.
 */
export class IntegrationView implements Action {
  name = "integration:view";
  description =
    "Show the project's integration with one trigger system (today: linear): the workspace, the @hypotenuse app user, granted scopes and teams, token expiry, any refresh error, the last-seen rate-limit headroom, and its most recent webhook deliveries with their outcomes. Never returns a token.";
  middleware = [ProjectMemberMiddleware()];
  web = { route: "/integration", method: HTTP_METHOD.GET };
  inputs = z.object({
    projectId: z.coerce
      .number()
      .int()
      .positive()
      .describe("The project whose integration to show"),
    type: z.enum(TRIGGER_TYPES).describe("The trigger system, e.g. linear"),
  });

  /**
   * @param params - The project and type.
   * @returns The integration (or null), whether the type is configured here,
   *   and its recent webhook deliveries.
   */
  async run(params: ActionParams<IntegrationView>) {
    const row = await getIntegration(params.projectId, params.type);
    return {
      integration: row ? serializeIntegration(row) : null,
      configured: integrationConfigured(params.type),
      deliveries: row ? await recentDeliveries(row.id) : null,
    };
  }
}
