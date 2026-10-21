import { type ActionParams, HTTP_METHOD } from "keryx";
import { z } from "zod";
import {
  AuditedAction,
  type AuditedConnection,
  type TxHandle,
} from "../../classes/AuditedAction";
import { ProjectMemberMiddleware } from "../../middleware/rbac";
import {
  serializeAgentSession,
  sessionInProject,
} from "../../ops/AgentSessionOps";
import {
  applyEffects,
  cancelSessionWork,
  lockSession,
  type WorkEffects,
} from "../../ops/WorkItemOps";

/** The effects each in-flight cancel leaves for its `afterCommit`. */
const pending = new WeakMap<AuditedConnection, WorkEffects>();

/**
 * `agent-session:cancel` — stop a session's work from Hypotenuse, as Linear's
 * Stop does: a turn not yet taken is cancelled and the session told so; a
 * running turn's runner is told to stop and answer, and the server answers if
 * it does not within the project's stop grace. Queued follow-ups go too.
 * Audited: it is a person's decision. Requires membership.
 */
export class AgentSessionCancel extends AuditedAction {
  name = "agent-session:cancel";
  description =
    "Stop an agent session's work, as pressing Stop in Linear does: work not yet started is cancelled; a running turn is told to stop and report the state it left things in. Requires membership in the project.";
  middleware = [ProjectMemberMiddleware()];
  web = { route: "/agent-session/:id/cancel", method: HTTP_METHOD.POST };
  inputs = z.object({
    projectId: z.coerce
      .number()
      .int()
      .positive()
      .describe("The project the session belongs to"),
    id: z.coerce.number().int().positive().describe("The agent session's id"),
  });

  /**
   * @param tx - The transaction the cancel and its audit row share.
   * @param params - The session.
   * @param connection - The caller's connection.
   * @returns The session.
   * @throws {TypedError} `CONNECTION_ACTION_NOT_FOUND` when it is not in the project.
   */
  async runWithAudit(
    tx: TxHandle,
    params: ActionParams<AgentSessionCancel>,
    connection: AuditedConnection,
  ) {
    const found = await sessionInProject(params.projectId, params.id);
    const before = await lockSession(tx, found.id);
    const effects = await cancelSessionWork(tx, before.id, {
      reason: "dashboard",
      announce: true,
    });
    pending.set(connection, effects);
    const after = await lockSession(tx, found.id);
    connection.metadata.auditBefore = serializeAgentSession(before);
    connection.metadata.auditAfter = serializeAgentSession(after);
    connection.metadata.auditTargetType = "agent_session";
    connection.metadata.auditTargetPath =
      before.issueIdentifier ?? String(before.id);
    connection.metadata.auditMetadata = { reason: "dashboard" };
    return { agentSession: serializeAgentSession(after) };
  }

  /**
   * Send the answer, wake the runner, and run routing.
   * @param _result - Unused.
   * @param _params - Unused.
   * @param connection - The caller's connection.
   */
  async afterCommit(
    _result: unknown,
    _params: unknown,
    connection: AuditedConnection,
  ) {
    const effects = pending.get(connection);
    pending.delete(connection);
    if (effects) await applyEffects(effects);
  }
}
