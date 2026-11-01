import { type Action, type ActionParams } from "keryx";
import { z } from "zod";
import { idInput } from "../../ops/InputOps";
import { startSandboxJob } from "../../ops/SandboxProvisionOps";

/**
 * `sandbox-job:start` — bring one claimed job up: token, sandbox, files,
 * supervisor. Task-only on the `sandboxes` queue, with no timeout (a
 * provider can take minutes). Not audited: machine work recorded on
 * `sandbox_jobs` and `sandboxes`.
 */
export class SandboxJobStart implements Action {
  name = "sandbox-job:start";
  description =
    "Provision a claimed sandbox job and launch its coding agent. Enqueued by the dispatcher; not exposed over HTTP.";
  mcp = { tool: false };
  timeout = 0;
  task = { queue: "sandboxes" };
  inputs = z.object({ jobId: idInput("The job to start") });

  /**
   * @param params - The job.
   * @returns What happened.
   */
  async run(params: ActionParams<SandboxJobStart>) {
    return { outcome: await startSandboxJob(params.jobId) };
  }
}
