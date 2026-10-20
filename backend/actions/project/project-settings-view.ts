import { type Action, type ActionParams, api, HTTP_METHOD } from "keryx";
import { z } from "zod";
import { ProjectMemberMiddleware } from "../../middleware/rbac";
import {
  getOrCreateSettings,
  serializeProjectSettings,
} from "../../ops/ProjectSettingsOps";

/**
 * `project:settings-view` — a project's settings row.
 *
 * Member-gated rather than admin-gated: every member may read how their project
 * is configured, even though only admins may change it. The row carries no
 * setting yet beyond its identity; the features that need one (routing rules,
 * the Linear connection's preferences) add their columns by migration, and this
 * action is where members read them.
 */
export class ProjectSettingsView implements Action {
  name = "project:settings-view";
  description =
    "Read a project's settings row. Requires membership in the project.";
  middleware = [ProjectMemberMiddleware()];
  web = { route: "/project/settings", method: HTTP_METHOD.GET };
  inputs = z.object({
    projectId: z.coerce
      .number()
      .int()
      .positive()
      .describe("The project whose settings to read"),
  });

  /**
   * @param params - The validated inputs (`projectId`).
   * @returns The project's settings.
   */
  async run(params: ActionParams<ProjectSettingsView>) {
    const settings = await getOrCreateSettings(api.db.db, params.projectId);
    return { settings: serializeProjectSettings(settings) };
  }
}
