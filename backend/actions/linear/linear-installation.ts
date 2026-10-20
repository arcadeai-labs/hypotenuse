import { type Action, type ActionParams, HTTP_METHOD } from "keryx";
import { z } from "zod";
import { ProjectMemberMiddleware } from "../../middleware/rbac";
import {
  getInstallationForProject,
  linearConfigured,
  serializeLinearInstallation,
} from "../../ops/LinearOps";

/**
 * `linear:installation` — which Linear workspace the project is connected to,
 * as which app user, and how healthy the connection is. `installation` is
 * `null` when it never connected; `configured` is whether this deployment has
 * a Linear app at all, so a client can say why Connect is unavailable.
 */
export class LinearInstallationView implements Action {
  name = "linear:installation";
  description =
    "Show the project's Linear connection: the workspace, the @hypotenuse app user, granted scopes and teams, token expiry, any refresh error, and the last-seen rate-limit headroom. Never returns a token.";
  middleware = [ProjectMemberMiddleware()];
  web = { route: "/linear/installation", method: HTTP_METHOD.GET };
  inputs = z.object({
    projectId: z.coerce
      .number()
      .int()
      .positive()
      .describe("The project whose Linear connection to show"),
  });

  /**
   * @param params - The project.
   * @returns The installation (or null) and whether Linear is configured here.
   */
  async run(params: ActionParams<LinearInstallationView>) {
    const row = await getInstallationForProject(params.projectId);
    return {
      installation: row ? serializeLinearInstallation(row) : null,
      configured: linearConfigured(),
    };
  }
}
