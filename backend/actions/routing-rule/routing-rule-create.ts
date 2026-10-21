import { eq, sql } from "drizzle-orm";
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
  serializeRoutingRule,
} from "../../ops/RoutingOps";
import { routingRules } from "../../schema/routing_rules";

/**
 * `routing-rule:create` — add a rule at the end of a project's list. Admin
 * only: which role answers a session is the project's decision.
 */
export class RoutingRuleCreate extends AuditedAction {
  name = "routing-rule:create";
  description =
    "Add a routing rule at the end of a project's list: when its match holds for a new Linear session (labels, team keys, Linear project ids, a prompt prefix such as /manage, sub-issue or not, delegation or mention), the session is answered by the given role (manager or worker), optionally in a pinned repository. Requires the admin tag on the project.";
  middleware = [AdminMiddleware()];
  web = { route: "/routing-rule", method: HTTP_METHOD.PUT };
  inputs = z.object({
    projectId: z.coerce
      .number()
      .int()
      .positive()
      .describe("The project to add the rule to"),
    name: routingRuleNameInput.describe(
      "What the rule is called; named in the session when it decides",
    ),
    role: routingRoleInput.describe("The role a matching session gets"),
    match: RoutingMatchInput.default({}).describe(
      "What the rule matches; every present field must hold, absent fields match anything",
    ),
    repository: pinnedRepositoryInput
      .optional()
      .describe("Pin the repository (hostname/owner/name or a git remote)"),
    enabled: booleanInput
      .optional()
      .describe("Whether the rule is evaluated (default true)"),
  });

  /**
   * @param tx - The transaction the insert and its audit row share.
   * @param params - The rule.
   * @param connection - The caller's connection.
   * @returns The created rule.
   */
  async runWithAudit(
    tx: TxHandle,
    params: ActionParams<RoutingRuleCreate>,
    connection: AuditedConnection,
  ) {
    // Serialize appends to one project's list so two never take a position.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('routing_rules'), ${params.projectId})`,
    );
    const [{ next }] = await tx
      .select({
        next: sql<number>`coalesce(max(${routingRules.position}) + 1, 0)`,
      })
      .from(routingRules)
      .where(eq(routingRules.projectId, params.projectId));
    const [rule] = await tx
      .insert(routingRules)
      .values({
        projectId: params.projectId,
        position: Number(next),
        name: params.name,
        role: params.role,
        match: params.match,
        repository: params.repository ?? null,
        enabled: params.enabled ?? true,
      })
      .returning();
    const serialized = serializeRoutingRule(rule);
    connection.metadata.auditAfter = serialized;
    connection.metadata.auditTargetType = "routing_rule";
    connection.metadata.auditTargetPath = rule.name;
    return { routingRule: serialized };
  }
}
