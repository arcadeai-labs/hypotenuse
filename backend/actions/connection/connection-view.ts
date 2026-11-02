import { type Action, type ActionParams, api, HTTP_METHOD } from "keryx";
import { z } from "zod";
import { ProjectMemberMiddleware } from "../../middleware/rbac";
import { idInput } from "../../ops/InputOps";
import {
  loadProjectConnectionById,
  serializeProjectConnection,
} from "../../ops/SandboxCredentialOps";

/** `connection:view` — one connection, without its secret. Requires membership. */
export class ConnectionView implements Action {
  name = "connection:view";
  description =
    "Read one of the project's connections to a sandbox provider account, without its token. Requires membership in the project.";
  middleware = [ProjectMemberMiddleware()];
  web = {
    route: "/project/:projectId/connection/:connectionId",
    method: HTTP_METHOD.GET,
  };
  inputs = z.object({
    projectId: idInput("The project"),
    connectionId: idInput("The connection"),
  });

  /**
   * @param params - `projectId` and `connectionId`.
   * @returns The connection.
   */
  async run(params: ActionParams<ConnectionView>) {
    const row = await loadProjectConnectionById(
      api.db.db,
      params.projectId,
      params.connectionId,
    );
    return { connection: serializeProjectConnection(row) };
  }
}
