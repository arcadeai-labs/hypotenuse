/**
 * Which agent runs a turn. Shared by the supervisor (which counts the agent's
 * jobs) and the agent host (which launches it), so the two cannot disagree.
 */
import type { WorkAssignment } from "../../../protocol/src/index";
import type { Config } from "../config/schema";

/**
 * The agent a turn runs: the one the server recorded for the role, unless a
 * manager dispatched the issue preferring another agent this runner has in
 * `[agents]`. A preference, not a requirement — a runner without it runs the
 * role's agent and says so. Only a new dispatch switches: a follow-up resumes
 * the agent that holds the session.
 * @param assignment - The turn.
 * @param config - The runner's config.
 * @returns The agent id, and a thought to post when the preference was not met.
 */
export function agentForTurn(
  assignment: WorkAssignment,
  config: Config,
): { agentId: string; note: string | null } {
  const roleAgent =
    assignment.agentId ?? config.roles[assignment.role]?.agent ?? "unknown";
  const dispatch = assignment.dispatch;
  const preferred = dispatch?.mode === "new" ? dispatch.agentPreference : null;
  if (!preferred || preferred === roleAgent)
    return { agentId: roleAgent, note: null };
  if (Object.hasOwn(config.agents, preferred))
    return { agentId: preferred, note: null };
  return {
    agentId: roleAgent,
    note: `The planning agent preferred \`${preferred}\`, which this runner does not have; using ${roleAgent}.`,
  };
}
