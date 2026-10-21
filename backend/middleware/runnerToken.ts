import { and, eq } from "drizzle-orm";
import { api, ErrorType, TypedError } from "keryx";
import {
  afterRunnersRevoked,
  hashRunnerToken,
  INVALID_RUNNER_TOKEN_MESSAGE,
  revokeRunners,
} from "../ops/RunnerOps";
import { projectMemberships } from "../schema/project_memberships";
import { type Project, projects } from "../schema/projects";
import { type Runner, runners } from "../schema/runners";

/**
 * Resolving a runner: the half of the principal hook that reads a runner
 * token (`Authorization: Bearer hyp_rt_…`) or a WebSocket session that
 * `daemon:connect` minted (`session.data.runnerId`). Modelled on ToolExec's
 * run-token middleware: every permission is derived from the row the
 * credential resolves to, and no `daemon:*` action ever reads a `projectId`
 * or `runnerId` param.
 *
 * The protocol header is checked before any of this, at the HTTP edge
 * (`initializers/daemonPolicy.ts`), because Keryx's typed errors have no 426.
 */

/** The connection metadata a resolved runner writes. */
export interface RunnerMeta {
  /** The runner this request is, re-read from Postgres on every request. */
  runner?: Runner;
  /** The runner's project. */
  project?: Project;
}

/** How the runner presented itself. */
export type RunnerCredential =
  | { kind: "token"; token: string }
  | { kind: "session"; runnerId: number };

/**
 * Resolve a runner credential to a live runner, or refuse it.
 *
 * 1. Missing or revoked → 401.
 * 2. Disabled → 401, except for `daemon:heartbeat`: a paused runner still
 *    heartbeats, so the dashboard shows it online but paused.
 * 3. The owner is no longer a member of the project → the runner is revoked
 *    now (this is the backstop; `membership:delete` revokes eagerly) → 401.
 *
 * Every refusal is the same 401 with the same message, so a probe learns
 * nothing about why.
 * @param credential - The token, or the session's runner id.
 * @param actionName - The action being run.
 * @returns The runner and its project.
 * @throws {TypedError} `CONNECTION_SESSION_NOT_FOUND` for every refusal.
 */
export async function resolveRunner(
  credential: RunnerCredential,
  actionName: string,
): Promise<{ runner: Runner; project: Project }> {
  const [runner] = await api.db.db
    .select()
    .from(runners)
    .where(
      credential.kind === "token"
        ? eq(runners.tokenHash, hashRunnerToken(credential.token))
        : eq(runners.id, credential.runnerId),
    )
    .limit(1);
  if (!runner || runner.status === "revoked") throw invalidRunner();
  if (!runner.enabled && actionName !== "daemon:heartbeat") {
    throw invalidRunner();
  }

  const [membership] = await api.db.db
    .select({ id: projectMemberships.id })
    .from(projectMemberships)
    .where(
      and(
        eq(projectMemberships.userId, runner.userId),
        eq(projectMemberships.projectId, runner.projectId),
      ),
    )
    .limit(1);
  if (!membership) {
    const revoked = await api.db.db.transaction((tx) =>
      revokeRunners(tx, [runner.id], "membership_removed"),
    );
    await afterRunnersRevoked(revoked);
    throw invalidRunner();
  }

  const [project] = await api.db.db
    .select()
    .from(projects)
    .where(eq(projects.id, runner.projectId))
    .limit(1);
  if (!project) throw invalidRunner();
  return { runner, project };
}

/**
 * The single refusal for a runner credential that does not authenticate.
 * @returns A 401 typed error.
 */
export function invalidRunner(): TypedError {
  return new TypedError({
    message: INVALID_RUNNER_TOKEN_MESSAGE,
    type: ErrorType.CONNECTION_SESSION_NOT_FOUND,
  });
}
