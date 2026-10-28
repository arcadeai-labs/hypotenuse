import { type Action, type ActionParams, api, HTTP_METHOD } from "keryx";
import { z } from "zod";
import { ProjectMemberMiddleware } from "../../middleware/rbac";
import { idInput } from "../../ops/InputOps";
import {
  getOrCreateSettings,
  serializeProjectSettings,
} from "../../ops/ProjectSettingsOps";

/**
 * `project:settings-view` — a project's settings row. Member-gated: every member
 * may read how their project is configured, though only admins change it. The
 * row carries no setting yet; each feature that needs one adds a column and
 * members read it here.
 */
export class ProjectSettingsView implements Action {
  name = "project:settings-view";
  description =
    "Read a project's settings. Requires member standing in the project.";
  middleware = [ProjectMemberMiddleware()];
  web = { route: "/project/:projectId/settings", method: HTTP_METHOD.GET };
  inputs = z.object({
    projectId: idInput("The project whose settings to read"),
  });

  /**
   * @param params - The validated inputs.
   * @returns The project's settings.
   */
  async run(params: ActionParams<ProjectSettingsView>) {
    const settings = await getOrCreateSettings(api.db.db, params.projectId);
    return { settings: serializeProjectSettings(settings) };
  }
}
