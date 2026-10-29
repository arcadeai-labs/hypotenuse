import { type Action, type ActionParams, api, HTTP_METHOD } from "keryx";
import { z } from "zod";
import { AdminMiddleware } from "../../middleware/rbac";
import { idInput } from "../../ops/InputOps";
import { listConnectionModels, loadModelConnection } from "../../ops/ModelOps";

/**
 * `model-connection:models` — the models a connection's endpoint reports, asked
 * live and stored nowhere. Requires admin standing, because each call spends
 * the project's key. Feeds the model picker; a provider that does not list is
 * answered with a refusal saying to type the id.
 */
export class ModelConnectionModels implements Action {
  name = "model-connection:models";
  description =
    "List the model ids a model connection's provider reports, asked live through the server (nothing is stored). Use one as a model alias's modelId. Requires admin standing in the project.";
  middleware = [AdminMiddleware()];
  web = {
    route: "/project/:projectId/model-connection/:connectionId/models",
    method: HTTP_METHOD.GET,
  };
  inputs = z.object({
    projectId: idInput("The project"),
    connectionId: idInput("The model connection to ask"),
  });

  /**
   * @param params - `projectId` and `connectionId`.
   * @returns The models the endpoint reported.
   * @throws {TypedError} `CONNECTION_ACTION_NOT_FOUND`; `CONNECTION_ACTION_RUN`
   *   when the endpoint did not list.
   */
  async run(params: ActionParams<ModelConnectionModels>) {
    const row = await loadModelConnection(
      api.db.db,
      params.projectId,
      params.connectionId,
    );
    return { models: await listConnectionModels(row) };
  }
}
