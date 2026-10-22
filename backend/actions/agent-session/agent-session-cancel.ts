import { and, eq, notInArray } from "drizzle-orm";
import { type ActionParams, ErrorType, HTTP_METHOD, TypedError } from "keryx";
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
import { users } from "../../schema/users";
import { TERMINAL_WORK_STATUSES, workItems } from "../../schema/work_items";

/** The effects each in-flight cancel leaves for its `afterCommit`. */
const pending = new WeakMap<AuditedConnection, WorkEffects>();

/**
 * `agent-session:cancel` — stop a session's work from Hypotenuse, as Linear's
 * Stop does: a turn not yet taken is cancelled and the session told so; a
 * running turn's runner is told to stop and answer, and the server answers if
 * it does not within the project's stop grace. Queued follow-ups go too.
 * Every answer names the person (`by` on the runner's cancel). A session
 * waiting on a question has no turn to stop and is answered by the server, so
 * Linear's status leaves `awaitingInput`; one with nothing live and nothing
 * asked is refused (406). Audited: it is a person's decision. Requires
 * membership.
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
   * @throws {TypedError} `CONNECTION_ACTION_NOT_FOUND` when it is not in the
   *   project; `CONNECTION_ACTION_PARAM_VALIDATION` when there is nothing to
   *   cancel.
   */
  async runWithAudit(
    tx: TxHandle,
    params: ActionParams<AgentSessionCancel>,
    connection: AuditedConnection,
  ) {
    const found = await sessionInProject(params.projectId, params.id);
    const before = await lockSession(tx, found.id);
    const [live] = await tx
      .select({ id: workItems.id })
      .from(workItems)
      .where(
        and(
          eq(workItems.agentSessionId, before.id),
          notInArray(workItems.status, [...TERMINAL_WORK_STATUSES]),
        ),
      )
      .limit(1);
    if (!live && before.status !== "awaitingInput") {
      throw new TypedError({
        message:
          "Nothing to cancel: no turn is queued or running, and the session is not waiting on anyone",
        type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
      });
    }
    const userId = connection.session!.data.userId!;
    const [person] = await tx
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, userId));
    const effects = await cancelSessionWork(tx, before.id, {
      reason: "dashboard",
      announce: true,
      by: { userId, name: person?.name ?? "a project member" },
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
