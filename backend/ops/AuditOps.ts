import { and, count, desc, eq, gte, lt, type SQL } from "drizzle-orm";
import { api, type Connection, paginate } from "keryx";
import { z } from "zod";
import type { RbacConnectionMeta } from "../middleware/rbac";
import type { SessionImpl } from "../middleware/session";
import {
  AUDIT_ACTOR_TYPES,
  type AuditActorType,
  type AuditLog,
  auditLogs,
} from "../schema/audit_logs";
import { projects } from "../schema/projects";
import { users } from "../schema/users";
import type { DbHandle } from "./DbOps";

/**
 * Param keys whose values may carry a secret and must never reach an audit row's
 * `metadata` column.
 *
 * This is the second of **two** layers, not the only one: `before` / `after` are
 * always `serializeX()` output, and serializers have no field a secret fits in.
 * This denylist covers the other side — the raw action params, which
 * `insertAuditLog` stores by default.
 *
 * It lists every secret Hypotenuse plans to handle, before most of the actions
 * that carry them exist, so no later change can add a secret-bearing param
 * without its key already being scrubbed. It matches **param keys**, never value
 * prefixes. A new secret-bearing param means adding its key here in the same
 * commit.
 */
export const SENSITIVE_KEYS = [
  "password",
  "passwordHash",
  "password_hash",
  "secret",
  "secretValue",
  "token",
  "apiKey",
  "connectionString",
  // platform OAuth and Slack signing
  "accessToken",
  "refreshToken",
  "clientSecret",
  "signingSecret",
  // platform apps, the GitHub App
  "webhookSecret",
  "botToken",
  "appToken",
  "privateKey",
  // OAuth hops, CLI sign-in
  "code",
  "codeVerifier",
  "state",
  "deviceCode",
  // sandboxes, code-mode continuations
  "runToken",
  "tokenHash",
  "continuationSecret",
  // MCP server and telemetry exporter headers, where credentials hide
  "headers",
  "authorization",
] as const;

/**
 * Return a copy of an action's params with every {@link SENSITIVE_KEYS} entry
 * removed at any depth, so secrets never land in an audit row's `metadata`.
 *
 * Recursion is the load-bearing part for nested payloads. A shallow scrub would
 * leave `payload.connection.accessToken` in the row while looking like it had
 * done the job — the same failure mode as a denylist of top-level names.
 * @param params - The raw action params.
 * @returns A copy of `params` safe to persist as audit metadata.
 */
export function scrubParams(
  params: Record<string, unknown>,
): Record<string, unknown> {
  return scrubValue(params) as Record<string, unknown>;
}

/**
 * Strip {@link SENSITIVE_KEYS} from a JSON-like value, walking arrays and
 * objects. Non-plain values (dates, class instances) are returned as-is —
 * action params are JSON, and this is not a general deep clone.
 * @param value - Any JSON-like value.
 * @returns The scrubbed copy.
 */
function scrubValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(scrubValue);
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(
      value as Record<string, unknown>,
    )) {
      if ((SENSITIVE_KEYS as readonly string[]).includes(key)) continue;
      out[key] = scrubValue(child);
    }
    return out;
  }
  return value;
}

/**
 * An explicit audit-log entry, for writers that do not go through an action's
 * `run`. `actorType` is required, so every such writer says whose decision it
 * records.
 */
export interface AuditLogEntry {
  actorType: AuditActorType;
  userId?: number | null;
  participantId?: number | null;
  organizationId?: number | null;
  projectId?: number | null;
  action: string;
  targetType?: string | null;
  targetPath?: string | null;
  metadata?: Record<string, unknown>;
  before?: unknown;
  after?: unknown;
}

/**
 * Write one audit-log row from explicit fields.
 *
 * This exists for changes made inside a **shared ops helper**, which are
 * invisible to the calling action's own auditing — the sign-up bootstrap runs
 * `createOrganizationForOwner` and `createProjectForOwner`, so `user:create`
 * logs synthetic `system` rows for them — and for decisions made outside any
 * action, such as an approval a platform participant clicks, which event
 * processing records as a `participant` row. Pass the caller's transaction
 * handle as `db` so the row commits atomically with the change it describes.
 *
 * A project row with no `organizationId` is filed under the project's
 * organization, read on the same handle, so an organization's log is always a
 * superset of its projects' logs.
 * @param db - A Drizzle transaction handle, or the shared `api.db.db`.
 * @param entry - The audit-log fields to persist.
 */
export async function writeAuditLog(
  db: DbHandle,
  entry: AuditLogEntry,
): Promise<void> {
  let organizationId = entry.organizationId ?? null;
  if (organizationId === null && entry.projectId != null) {
    const [project] = await db
      .select({ organizationId: projects.organizationId })
      .from(projects)
      .where(eq(projects.id, entry.projectId))
      .limit(1);
    organizationId = project?.organizationId ?? null;
  }

  await db.insert(auditLogs).values({
    actorType: entry.actorType,
    userId: entry.userId ?? null,
    participantId: entry.participantId ?? null,
    organizationId,
    projectId: entry.projectId ?? null,
    action: entry.action,
    targetType: entry.targetType ?? null,
    targetPath: entry.targetPath ?? null,
    metadata: entry.metadata ?? {},
    before: entry.before ?? null,
    after: entry.after ?? null,
  });
}

/**
 * A numeric id param, or `undefined` — params are untyped at this layer.
 * @param value - The param value.
 * @returns The id, if it is one.
 */
function idParam(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

/**
 * Insert the audit row describing a mutating action. Called by
 * `AuditedAction.run` on the same transaction as the mutation.
 *
 * Everything the row cannot infer from the action itself comes off
 * `connection.metadata`, which the acting subclass sets: the `before` / `after`
 * snapshots, the target, and — for the few actions whose params do not name
 * their tenant — the `projectId` and `organizationId` to scope the row to.
 *
 * The organization is, in order: the explicit `auditOrganizationId`, the
 * `organizationId` param, the organization of the project the RBAC middleware
 * loaded, and the organization it loaded — so every project row is also an
 * organization row. The actor is the session's user, or `auditUserId` for
 * sign-up, whose caller has no session until the account exists; a write with
 * neither is the `system`'s.
 *
 * `metadata` defaults to the secret-scrubbed params. A write made under an
 * organization owner's admin standing (not the project's own `admin` tag)
 * records `standing: "organization-owner"`, so the log never leaves it
 * ambiguous who could act and why.
 * @param db - A Drizzle transaction handle, or the shared `api.db.db`.
 * @param actionName - The action's `name`, e.g. `"tag:edit"`.
 * @param connection - The caller's connection (session + audit metadata).
 * @param params - The action params (scrubbed of secrets before storage).
 */
export async function insertAuditLog(
  db: DbHandle,
  actionName: string,
  connection: Connection<SessionImpl, RbacConnectionMeta>,
  params: Record<string, unknown>,
): Promise<void> {
  const meta = connection.metadata;
  const userId = connection.session?.data.userId ?? meta.auditUserId ?? null;

  await writeAuditLog(db, {
    actorType: userId ? "user" : "system",
    userId,
    organizationId:
      meta.auditOrganizationId ??
      idParam(params.organizationId) ??
      meta.project?.organizationId ??
      meta.organization?.id ??
      null,
    projectId: meta.auditProjectId ?? idParam(params.projectId) ?? null,
    action: actionName,
    targetType: meta.auditTargetType ?? null,
    targetPath: meta.auditTargetPath ?? null,
    metadata: {
      ...(meta.auditMetadata ?? scrubParams(params)),
      ...(meta.viaOrganizationOwner ? { standing: "organization-owner" } : {}),
    },
    before: meta.auditBefore ?? null,
    after: meta.auditAfter ?? null,
  });
}

/** Who an audit row's actor is, as far as the server can name them. */
export interface AuditActor {
  type: AuditActorType;
  userId: number | null;
  participantId: number | null;
  /** The user's current name; `null` for a deleted user, a participant, or the system. */
  name: string | null;
  email: string | null;
}

/**
 * Shape an audit-log row into the API-safe object `audit:list` and
 * `organization:audit-list` return. `createdAt` is emitted as epoch
 * milliseconds, per the serializer convention; `metadata` / `before` / `after`
 * pass through as stored, which is safe because both layers of redaction
 * already ran at write time.
 * @param row - The audit-log row from the database.
 * @param user - The acting user's current name and email, when there is one.
 * @param projectName - The row's project's current name; `null` once deleted.
 * @returns The serialized audit-log entry.
 */
export function serializeAuditLog(
  row: AuditLog,
  user: { name: string; email: string } | null = null,
  projectName: string | null = null,
) {
  const actor: AuditActor = {
    type: row.actorType,
    userId: row.userId,
    participantId: row.participantId,
    name: user?.name ?? null,
    email: user?.email ?? null,
  };
  return {
    id: row.id,
    actor,
    organizationId: row.organizationId,
    projectId: row.projectId,
    projectName,
    action: row.action,
    targetType: row.targetType,
    targetPath: row.targetPath,
    metadata: row.metadata,
    before: row.before,
    after: row.after,
    createdAt: row.createdAt.getTime(),
  };
}

/**
 * A point in time, given as an ISO 8601 string or as epoch milliseconds (a
 * number, or digits in a query string). Both, because a person types the first
 * and every serializer in the app emits the second, so a client can page
 * backwards from a row's own `createdAt`.
 * @param description - What the bound limits, for the MCP tool description.
 * @returns The optional Zod schema, parsed to a `Date`.
 */
export function auditTimeInput(description: string) {
  return z
    .preprocess((value) => {
      if (value === undefined || value === null || value === "") {
        return undefined;
      }
      if (typeof value === "number") return new Date(value);
      if (typeof value === "string") {
        return /^\d+$/.test(value.trim())
          ? new Date(Number(value))
          : new Date(value);
      }
      return value;
    }, z
      .date({ error: "Must be an ISO 8601 date or epoch milliseconds" })
      .optional())
    .describe(description);
}

/** The filters both audit lists accept, on top of pagination and their tenant. */
export const auditFilterInputs = z.object({
  since: auditTimeInput(
    "Only rows at or after this time: an ISO 8601 date or epoch milliseconds",
  ),
  until: auditTimeInput(
    "Only rows at or before this time: an ISO 8601 date or epoch milliseconds",
  ),
  action: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe('Only rows for this action name, e.g. "tag:edit"'),
  actorType: z
    .enum(AUDIT_ACTOR_TYPES)
    .optional()
    .describe(
      'Only rows made by this kind of actor: "user" (a Hypotenuse user), "participant" (a person on a platform), or "system"',
    ),
  targetType: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe('Only rows about this kind of thing, e.g. "tag" or "project"'),
});

/** The parsed filters, plus the tenant condition each list adds itself. */
export type AuditFilters = z.infer<typeof auditFilterInputs>;

/**
 * One page of audit rows matching a tenant condition and the caller's filters,
 * newest first, each with its actor's current name and its project's current
 * name. Shared by `audit:list` (one project) and `organization:audit-list`
 * (every project in an organization, and the organization's own rows).
 * @param tenant - The condition naming whose rows these are.
 * @param filters - The caller's filters.
 * @param page - Pagination inputs.
 * @returns The serialized rows and the pagination envelope.
 */
export async function listAuditLogs(
  tenant: SQL,
  filters: AuditFilters,
  page: { page: number; limit: number },
) {
  // Postgres keeps microseconds and every serializer emits milliseconds, so a
  // row's own `createdAt` is at or before the stored instant. `since` is
  // inclusive as written; `until` covers its whole millisecond, or a client
  // paging back from a row's `createdAt` would skip that row.
  const where = and(
    tenant,
    filters.since ? gte(auditLogs.createdAt, filters.since) : undefined,
    filters.until
      ? lt(auditLogs.createdAt, new Date(filters.until.getTime() + 1))
      : undefined,
    filters.action ? eq(auditLogs.action, filters.action) : undefined,
    filters.actorType ? eq(auditLogs.actorType, filters.actorType) : undefined,
    filters.targetType
      ? eq(auditLogs.targetType, filters.targetType)
      : undefined,
  );
  const result = await paginate(
    api.db.db
      .select({
        row: auditLogs,
        userName: users.name,
        userEmail: users.email,
        projectName: projects.name,
      })
      .from(auditLogs)
      .leftJoin(users, eq(users.id, auditLogs.userId))
      .leftJoin(projects, eq(projects.id, auditLogs.projectId))
      .where(where)
      .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
      .$dynamic(),
    api.db.db.select({ count: count() }).from(auditLogs).where(where),
    page,
  );
  return {
    auditLogs: result.data.map(({ row, userName, userEmail, projectName }) =>
      serializeAuditLog(
        row,
        userName !== null && userEmail !== null
          ? { name: userName, email: userEmail }
          : null,
        projectName,
      ),
    ),
    pagination: result.pagination,
  };
}
