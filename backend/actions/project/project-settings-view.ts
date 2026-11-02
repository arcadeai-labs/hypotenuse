import { type Action, type ActionParams, api, HTTP_METHOD } from "keryx";
import { z } from "zod";
import { describeConnectionKinds } from "../../connections/registry";
import { ProjectMemberMiddleware } from "../../middleware/rbac";
import { idInput } from "../../ops/InputOps";
import {
  getOrCreateSettings,
  serializeProjectSettings,
} from "../../ops/ProjectSettingsOps";
import { describeSandboxProviders } from "../../sandbox/registry";

/**
 * `project:settings-view` — a project's settings row. Member-gated: every member
 * may read how their project is configured, though only admins change it.
 * Answers the sandbox providers this deployment knows (and whether each is
 * allowed here) and the connection kinds, so a client renders the choices
 * the server will accept.
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
    return {
      settings: serializeProjectSettings(settings),
      providers: describeSandboxProviders(),
      connectionKinds: describeConnectionKinds(),
    };
  }
}
