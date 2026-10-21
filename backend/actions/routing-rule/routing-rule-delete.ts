import { and, eq, gt, sql } from "drizzle-orm";
import { type ActionParams, HTTP_METHOD } from "keryx";
import { z } from "zod";
import {
  AuditedAction,
  type AuditedConnection,
  type TxHandle,
} from "../../classes/AuditedAction";
import { AdminMiddleware } from "../../middleware/rbac";
import { ruleInProject, serializeRoutingRule } from "../../ops/RoutingOps";
import { routingRules } from "../../schema/routing_rules";

/**
 * `routing-rule:delete` — remove a rule; the rules after it move up. Admin
 * only. The seeded `/manage` and `/work` rules may be deleted too: they are
 * seeded, not built in.
 */
export class RoutingRuleDelete extends AuditedAction {
  name = "routing-rule:delete";
  description =
    "Delete a routing rule; the rules after it move up one place. Requires the admin tag on the project.";
  middleware = [AdminMiddleware()];
  web = { route: "/routing-rule/:id", method: HTTP_METHOD.DELETE };
  inputs = z.object({
    projectId: z.coerce
      .number()
      .int()
      .positive()
      .describe("The project the rule belongs to"),
    id: z.coerce.number().int().positive().describe("The rule's id"),
  });

  /**
   * @param tx - The transaction the delete and its audit row share.
   * @param params - The rule.
   * @param connection - The caller's connection.
   * @returns `{ success: true }`.
   * @throws {TypedError} `CONNECTION_ACTION_NOT_FOUND`.
   */
  async runWithAudit(
    tx: TxHandle,
    params: ActionParams<RoutingRuleDelete>,
    connection: AuditedConnection,
  ) {
    const rule = await ruleInProject(tx, params.projectId, params.id);
    await tx.delete(routingRules).where(eq(routingRules.id, rule.id));
    await tx
      .update(routingRules)
      .set({ position: sql`${routingRules.position} - 1` })
      .where(
        and(
          eq(routingRules.projectId, params.projectId),
          gt(routingRules.position, rule.position),
        ),
      );
    connection.metadata.auditBefore = serializeRoutingRule(rule);
    connection.metadata.auditTargetType = "routing_rule";
    connection.metadata.auditTargetPath = rule.name;
    return { success: true };
  }
}
