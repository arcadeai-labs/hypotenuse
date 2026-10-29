import { eq } from "drizzle-orm";
import {
  type Action,
  type ActionParams,
  HTTP_METHOD,
  paginationInputs,
} from "keryx";
import { AdminMiddleware } from "../../middleware/rbac";
import { auditFilterInputs, listAuditLogs } from "../../ops/AuditOps";
import { idInput } from "../../ops/InputOps";
import { auditLogs } from "../../schema/audit_logs";

/**
 * `audit:list` — one project's audit log, newest first. Admins only: the log
 * names every member, every change, and what each looked like before, which is
 * more than a member's own view of the project. An organization owner reads it
 * through their admin standing.
 */
export class AuditList implements Action {
  name = "audit:list";
  description =
    'List a project\'s audit log, newest first: every decision a person made in the project — who, what action, on what, and the state before and after. Filter by time (`since` / `until`, ISO 8601 or epoch milliseconds), `action` (e.g. "tag:edit"), `actorType` ("user", "participant", "system"), and `targetType`. Requires admin standing in the project. Paginated.';
  middleware = [AdminMiddleware()];
  web = { route: "/project/:projectId/audit", method: HTTP_METHOD.GET };
  inputs = paginationInputs({ defaultLimit: 25 })
    .extend(auditFilterInputs.shape)
    .extend({
      projectId: idInput("The project whose audit log to read"),
    });

  /**
   * @param params - `projectId`, the filters, and pagination inputs.
   * @returns The rows plus pagination metadata.
   */
  async run(params: ActionParams<AuditList>) {
    return listAuditLogs(
      eq(auditLogs.projectId, params.projectId),
      params,
      params,
    );
  }
}
