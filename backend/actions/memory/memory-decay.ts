import { type Action, api, config } from "keryx";
import { z } from "zod";
// Type-only, purely for the `declare module "keryx"` augmentation inside.
import type {} from "../../config/memory";
import { projectsWithMemory } from "../../ops/MemoryDecayOps";

/**
 * `memory:decay` — hourly, fan out `memory:decay-project` to every project
 * with memory. A clock: task-only, never an HTTP route, and not audited.
 */
export class MemoryDecay implements Action {
  name = "memory:decay";
  description =
    "Fade unused channel memory and prune old versions, project by project. Runs automatically on a timer; not exposed over HTTP.";
  mcp = { tool: false };
  task = { queue: "orchestrator", frequency: config.memory.decayFrequencyMs };
  inputs = z.object({});

  /** @returns The projects fanned out to. */
  async run() {
    const projectIds = await projectsWithMemory();
    if (projectIds.length > 0) {
      await api.actions.fanOut(
        "memory:decay-project",
        projectIds.map((projectId) => ({ projectId })),
        "default",
      );
    }
    return { projectIds };
  }
}
