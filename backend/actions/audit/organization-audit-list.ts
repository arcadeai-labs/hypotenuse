import { and, eq, isNull, type SQL } from "drizzle-orm";
import {
  type Action,
  type ActionParams,
  ErrorType,
  HTTP_METHOD,
  paginationInputs,
  TypedError,
} from "keryx";
import { z } from "zod";
import { OrganizationOwnerMiddleware } from "../../middleware/rbac";
import { auditFilterInputs, listAuditLogs } from "../../ops/AuditOps";
import { idInput } from "../../ops/InputOps";
import { auditLogs } from "../../schema/audit_logs";

/**
 * `organization:audit-list` — an organization's audit log: its own rows (the
 * organization, its owners, its invites) and every row of every project in it,
 * including projects since deleted. Owners only. `projectId` narrows it to one
 * project; it is a filter over rows already scoped to the organization, so a
 * project of another organization matches nothing rather than leaking.
 * `organizationOnly` narrows it to the rows that belong to no project.
 */
export class OrganizationAuditList implements Action {
  name = "organization:audit-list";
  description =
    'List an organization\'s audit log, newest first: the organization\'s own changes and every project\'s in it. Filter by `projectId`, or `organizationOnly` for the changes that belong to no project, time (`since` / `until`, ISO 8601 or epoch milliseconds), `action`, `actorType` ("user", "participant", "system"), and `targetType`. Requires being an owner of the organization. Paginated.';
  middleware = [OrganizationOwnerMiddleware()];
  web = {
    route: "/organization/:organizationId/audit",
    method: HTTP_METHOD.GET,
  };
  inputs = paginationInputs({ defaultLimit: 25 })
    .extend(auditFilterInputs.shape)
    .extend({
      organizationId: idInput("The organization whose audit log to read"),
      projectId: z.coerce
        .number()
        .int()
        .positive()
        .optional()
        .describe("Only rows of this project in the organization"),
      organizationOnly: z
        .stringbool()
        .optional()
        .describe(
          "Only the organization's own rows, which belong to no project. Not with `projectId`",
        ),
    });

  /**
   * @param params - `organizationId`, the filters, and pagination inputs.
   * @returns The rows plus pagination metadata.
   */
  async run(params: ActionParams<OrganizationAuditList>) {
    if (params.projectId && params.organizationOnly) {
      throw new TypedError({
        message:
          "Give `projectId` or `organizationOnly`, not both: a row belongs to a project or to none.",
        type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
        key: "organizationOnly",
      });
    }
    const tenant = eq(auditLogs.organizationId, params.organizationId);
    const scope = params.projectId
      ? eq(auditLogs.projectId, params.projectId)
      : params.organizationOnly
        ? isNull(auditLogs.projectId)
        : undefined;
    return listAuditLogs(
      scope ? (and(tenant, scope) as SQL) : tenant,
      params,
      params,
    );
  }
}
