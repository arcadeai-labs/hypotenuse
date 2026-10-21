import { eq } from "drizzle-orm";
import { type ActionParams, ErrorType, HTTP_METHOD, TypedError } from "keryx";
import { z } from "zod";
import {
  AuditedAction,
  type AuditedConnection,
  type TxHandle,
} from "../../classes/AuditedAction";
import { AdminMiddleware } from "../../middleware/rbac";
import { listRoutingRules, serializeRoutingRule } from "../../ops/RoutingOps";
import { routingRules } from "../../schema/routing_rules";

/**
 * `routing-rule:reorder` — set the evaluation order of a project's rules.
 * `ids` must name every rule of the project exactly once, so a reorder can
 * never silently drop or duplicate one. Admin only.
 */
export class RoutingRuleReorder extends AuditedAction {
  name = "routing-rule:reorder";
  description =
    "Set the order a project's routing rules are evaluated in. ids must list every rule of the project exactly once, first evaluated first. Requires the admin tag on the project.";
  middleware = [AdminMiddleware()];
  web = { route: "/routing-rules/order", method: HTTP_METHOD.POST };
  inputs = z.object({
    projectId: z.coerce
      .number()
      .int()
      .positive()
      .describe("The project whose rules to reorder"),
    ids: z
      .array(z.coerce.number().int().positive())
      .max(500)
      .describe("Every rule id of the project, in the new order"),
  });

  /**
   * @param tx - The transaction the updates and their audit row share.
   * @param params - The new order.
   * @param connection - The caller's connection.
   * @returns The rules in their new order.
   * @throws {TypedError} `CONNECTION_ACTION_PARAM_VALIDATION` when `ids` is not
   *   a permutation of the project's rules.
   */
  async runWithAudit(
    tx: TxHandle,
    params: ActionParams<RoutingRuleReorder>,
    connection: AuditedConnection,
  ) {
    const before = await tx
      .select()
      .from(routingRules)
      .where(eq(routingRules.projectId, params.projectId))
      .for("update");
    const have = new Set(before.map((r) => r.id));
    const given = new Set(params.ids);
    if (
      given.size !== params.ids.length ||
      given.size !== have.size ||
      params.ids.some((id) => !have.has(id))
    ) {
      throw new TypedError({
        message: "ids must list every routing rule of the project exactly once",
        type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
        key: "ids",
      });
    }
    for (const [position, id] of params.ids.entries()) {
      await tx
        .update(routingRules)
        .set({ position })
        .where(eq(routingRules.id, id));
    }
    const after = await listRoutingRules(tx, params.projectId);
    const ordered = (rules: typeof before) =>
      [...rules]
        .sort((a, b) => a.position - b.position || a.id - b.id)
        .map((r) => ({ id: r.id, name: r.name, position: r.position }));
    connection.metadata.auditBefore = { routingRules: ordered(before) };
    connection.metadata.auditAfter = { routingRules: ordered(after) };
    connection.metadata.auditTargetType = "routing_rule";
    connection.metadata.auditTargetPath = "order";
    return { routingRules: after.map(serializeRoutingRule) };
  }
}
