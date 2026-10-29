import { type Action, type ActionParams, api, HTTP_METHOD } from "keryx";
import { z } from "zod";
import { ProjectMemberMiddleware } from "../../middleware/rbac";
import { idInput } from "../../ops/InputOps";
import {
  loadModelConnection,
  serializeModelConnection,
} from "../../ops/ModelOps";

/**
 * `model-connection:view` — one model connection of a project, without its key.
 * Requires membership: every member may see which providers the project uses.
 */
export class ModelConnectionView implements Action {
  name = "model-connection:view";
  description =
    "Get one model connection of a project: its provider, base URL, the last four characters of its key, and whether the key last worked. The key itself is never returned. Requires membership in the project.";
  middleware = [ProjectMemberMiddleware()];
  web = {
    route: "/project/:projectId/model-connection/:connectionId",
    method: HTTP_METHOD.GET,
  };
  inputs = z.object({
    projectId: idInput("The project"),
    connectionId: idInput("The model connection to view"),
  });

  /**
   * @param params - `projectId` and `connectionId`.
   * @returns The connection.
   * @throws {TypedError} `CONNECTION_ACTION_NOT_FOUND`.
   */
  async run(params: ActionParams<ModelConnectionView>) {
    const row = await loadModelConnection(
      api.db.db,
      params.projectId,
      params.connectionId,
    );
    return { modelConnection: serializeModelConnection(row) };
  }
}
