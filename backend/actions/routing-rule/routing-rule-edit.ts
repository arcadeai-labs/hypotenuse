import { eq } from "drizzle-orm";
import { type ActionParams, HTTP_METHOD } from "keryx";
import { z } from "zod";
import {
  AuditedAction,
  type AuditedConnection,
  type TxHandle,
} from "../../classes/AuditedAction";
import { AdminMiddleware } from "../../middleware/rbac";
import {
  booleanInput,
  pinnedRepositoryInput,
  RoutingMatchInput,
  routingRoleInput,
  routingRuleNameInput,
  ruleInProject,
  serializeRoutingRule,
} from "../../ops/RoutingOps";
import { routingRules } from "../../schema/routing_rules";

/**
 * `routing-rule:edit` — change a rule: its name, role, match (replaced
 * whole), pinned repository (`null` clears it), or whether it is enabled.
 * Admin only. Sessions already routed keep their role: a role is fixed for a
 * session's life.
 */
export class RoutingRuleEdit extends AuditedAction {
  name = "routing-rule:edit";
  description =
    "Change a routing rule: its name, role, match (replaced whole), pinned repository (null clears it), or enabled flag. Sessions already routed keep their role. Requires the admin tag on the project.";
  middleware = [AdminMiddleware()];
  web = { route: "/routing-rule/:id", method: HTTP_METHOD.POST };
  inputs = z.object({
    projectId: z.coerce
      .number()
      .int()
      .positive()
      .describe("The project the rule belongs to"),
    id: z.coerce.number().int().positive().describe("The rule's id"),
    name: routingRuleNameInput.optional().describe("A new name"),
    role: routingRoleInput.optional().describe("A new role"),
    match: RoutingMatchInput.optional().describe(
      "A new match, replacing the old",
    ),
    repository: pinnedRepositoryInput
      .nullable()
      .optional()
      .describe("A new pinned repository, or null to clear it"),
    enabled: booleanInput
      .optional()
      .describe("false disables the rule; true enables it"),
  });

  /**
   * @param tx - The transaction the update and its audit row share.
   * @param params - The rule and what to change.
   * @param connection - The caller's connection.
   * @returns The updated rule.
   * @throws {TypedError} `CONNECTION_ACTION_NOT_FOUND`.
   */
  async runWithAudit(
    tx: TxHandle,
    params: ActionParams<RoutingRuleEdit>,
    connection: AuditedConnection,
  ) {
    const before = await ruleInProject(tx, params.projectId, params.id);
    const [after] = await tx
      .update(routingRules)
      .set({
        ...(params.name !== undefined ? { name: params.name } : {}),
        ...(params.role !== undefined ? { role: params.role } : {}),
        ...(params.match !== undefined ? { match: params.match } : {}),
        ...(params.repository !== undefined
          ? { repository: params.repository }
          : {}),
        ...(params.enabled !== undefined ? { enabled: params.enabled } : {}),
      })
      .where(eq(routingRules.id, before.id))
      .returning();
    connection.metadata.auditBefore = serializeRoutingRule(before);
    connection.metadata.auditAfter = serializeRoutingRule(after);
    connection.metadata.auditTargetType = "routing_rule";
    connection.metadata.auditTargetPath = after.name;
    return { routingRule: serializeRoutingRule(after) };
  }
}
