import { type Action, type ActionParams, api } from "keryx";
import { z } from "zod";
import { idInput } from "../../ops/InputOps";
import { decayProject } from "../../ops/MemoryDecayOps";

/**
 * `memory:decay-project` — one project's decay run: tombstone channel memory
 * that has faded past use, and delete old non-current versions. Task-only,
 * enqueued by `memory:decay`. Not audited: the clock acting, recorded as each
 * tombstone's `changeNote = "faded"`.
 */
export class MemoryDecayProject implements Action {
  name = "memory:decay-project";
  description =
    "Fade and prune one project's memory. Enqueued by the decay clock; not exposed over HTTP.";
  mcp = { tool: false };
  timeout = 0;
  task = { queue: "default" };
  inputs = z.object({ projectId: idInput("The project") });

  /**
   * @param params - The project.
   * @returns What was faded and pruned.
   */
  async run(params: ActionParams<MemoryDecayProject>) {
    const result = await decayProject(params.projectId);
    if (result.faded.length > 0 || result.pruned > 0) {
      api.logger.info("memory decayed", {
        projectId: params.projectId,
        faded: result.faded.length,
        pruned: result.pruned,
      });
    }
    return result;
  }
}
