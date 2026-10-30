import { type Action, type ActionParams, api } from "keryx";
import { z } from "zod";
import { idInput } from "../../ops/InputOps";
import { embedPending } from "../../ops/MemoryOps";

/**
 * `memory:embed` — embed a batch of a project's memory chunks that have no
 * vector for its current embedding model, re-enqueueing itself while any
 * remain. Task-only. Not audited: machine work whose record is the
 * `embeddingRevision` it stamps on each chunk.
 */
export class MemoryEmbed implements Action {
  name = "memory:embed";
  description =
    "Embed a project's memory chunks in the background. Enqueued by the server; not exposed over HTTP.";
  mcp = { tool: false };
  timeout = 0;
  task = { queue: "default" };
  inputs = z.object({ projectId: idInput("The project") });

  /**
   * @param params - The project.
   * @returns How many chunks were embedded, and how many remain.
   */
  async run(params: ActionParams<MemoryEmbed>) {
    const result = await embedPending(params.projectId);
    if (result.embedded > 0) {
      api.logger.info("memory embedded", {
        projectId: params.projectId,
        ...result,
      });
    }
    return result;
  }
}
