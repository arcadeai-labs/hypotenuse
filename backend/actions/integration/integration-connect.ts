import {
  type Action,
  type ActionParams,
  type Connection,
  ErrorType,
  HTTP_METHOD,
  RateLimitMiddleware,
  TypedError,
} from "keryx";
import { z } from "zod";
import { AdminMiddleware } from "../../middleware/rbac";
import type { SessionImpl } from "../../middleware/session";
import { integrationConfigured } from "../../ops/IntegrationOps";
import { parkState } from "../../ops/LinearOAuthOps";
import { TRIGGER_TYPES } from "../../schema/integrations";

/**
 * `integration:connect` — start connecting the project to a workspace of one
 * trigger system. For `linear`, answers the URL of Linear's consent screen,
 * which a Linear workspace admin approves; Linear then redirects their browser
 * to `linear:callback`.
 *
 * Not audited: it writes only a short-lived Redis key. The decision — a
 * workspace being attached to this project — is the callback, which is.
 */
export class IntegrationConnect implements Action {
  name = "integration:connect";
  description =
    "Start connecting this project to a workspace of a trigger system (today: linear) as the @hypotenuse app. Returns the URL of that system's consent screen, which a workspace admin there must open and approve in a browser. Requires the admin tag on the project.";
  middleware = [RateLimitMiddleware, AdminMiddleware()];
  web = { route: "/integration/connect", method: HTTP_METHOD.GET };
  inputs = z.object({
    projectId: z.coerce
      .number()
      .int()
      .positive()
      .describe("The project to connect"),
    type: z.enum(TRIGGER_TYPES).describe("The trigger system, e.g. linear"),
  });

  /**
   * @param params - The project and type.
   * @param connection - The admin's connection.
   * @returns The authorize URL and how many seconds it stays usable.
   * @throws {TypedError} `CONNECTION_ACTION_PARAM_VALIDATION` when this
   *   deployment has no Linear OAuth app configured.
   */
  async run(
    params: ActionParams<IntegrationConnect>,
    connection: Connection<SessionImpl>,
  ) {
    if (!integrationConfigured(params.type)) {
      throw new TypedError({
        message:
          "This deployment has no Linear app configured (LINEAR_CLIENT_ID, LINEAR_CLIENT_SECRET, LINEAR_WEBHOOK_SECRET)",
        type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
      });
    }
    return parkState({
      projectId: params.projectId,
      userId: connection.session!.data.userId!,
    });
  }
}
