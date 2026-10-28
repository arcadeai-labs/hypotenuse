import { eq } from "drizzle-orm";
import {
  type ActionMiddleware,
  api,
  type Connection,
  ErrorType,
  TypedError,
} from "keryx";
import { isAdmin, resolveProjectAccess } from "../ops/MembershipOps";
import { getOrganizationMembership } from "../ops/OrganizationOps";
import { ADMIN_TAG } from "../ops/TagOps";
import type { OrganizationMembership } from "../schema/organization_memberships";
import { type Organization, organizations } from "../schema/organizations";
import type { ProjectMembership } from "../schema/project_memberships";
import type { Project } from "../schema/projects";
import type { Tag } from "../schema/tags";
import type { SessionImpl } from "./session";

/**
 * Well-known symbol tagging RBAC middleware with a machine-readable requirement
 * descriptor. Because the descriptor is attached to the exact middleware object
 * that performs the runtime check, `actions:permissions` — and therefore the UI
 * that gates on it — cannot drift from what is enforced.
 */
export const RBAC_DESCRIPTOR = Symbol.for("hypotenuse.rbac");

/**
 * **The** list of RBAC levels, and the single place one is added: the
 * requirement type, the middleware descriptors, `actions:permissions`, and the
 * frontend's `can()` all derive from here.
 *
 * - `none` — no tenant-scoped RBAC middleware on the action.
 * - `member` — the caller holds a membership in `params.projectId`, **or** owns
 *   its organization.
 * - `admin` — additionally holds the reserved {@link ADMIN_TAG}, **or** owns the
 *   project's organization.
 * - `org-member` — the caller holds a membership in `params.organizationId`.
 * - `org-owner` — holds it with `role = owner`.
 *
 * There is deliberately no role ladder inside a project: membership reads,
 * `admin` administers, and everything finer-grained is a tag.
 */
export const RBAC_LEVELS = [
  "none",
  "member",
  "admin",
  "org-member",
  "org-owner",
] as const;

/** One of {@link RBAC_LEVELS}. */
export type RbacLevel = (typeof RBAC_LEVELS)[number];

/** The permission an action requires, as reported by `actions:permissions`. */
export type RbacRequirement = { type: RbacLevel };

/**
 * The one shared connection-metadata type for the whole app. The RBAC middleware
 * writes the tenant fields; the `audit*` fields are the channel an
 * `AuditedAction` uses to hand its audit row everything the row cannot infer
 * from the action's params.
 */
export interface RbacConnectionMeta {
  project?: Project;
  /** The caller's explicit project membership; absent for an owner who never joined. */
  membership?: ProjectMembership;
  callerTags?: Tag[];
  /** Admin standing that comes from owning the organization, not the `admin` tag. */
  viaOrganizationOwner?: boolean;
  organization?: Organization;
  organizationMembership?: OrganizationMembership;
  /** Pre-mutation snapshot captured by an `AuditedAction`, always serializer output. */
  auditBefore?: unknown;
  /** Post-mutation snapshot captured by an `AuditedAction`, always serializer output. */
  auditAfter?: unknown;
  /** Explicit, already-scrubbed audit metadata overriding the scrubbed action params. */
  auditMetadata?: Record<string, unknown>;
  /**
   * The project to scope the audit row to, when it is not `params.projectId`:
   * `project:create` (the id does not exist until the write) and the invite
   * answers (the project is on the invite row).
   */
  auditProjectId?: number;
  /** The kind of entity the action acted on, e.g. `"tag"`. */
  auditTargetType?: string;
  /** How to identify that entity to a person, e.g. a tag's name or an email. */
  auditTargetPath?: string;
  /**
   * A typed refusal thrown only after the audited transaction commits, for a
   * refusal that must be recorded as well as reported.
   */
  refuseAfterCommit?: TypedError;
}

/** The connection every RBAC-gated action receives. */
type RbacConnection = Connection<SessionImpl, RbacConnectionMeta>;

/**
 * The signed-in user, or the 401 every gate answers without one.
 * @param connection - The caller's connection.
 * @returns Their user id.
 * @throws {TypedError} `CONNECTION_SESSION_NOT_FOUND` when signed out.
 */
function requireUserId(connection: RbacConnection): number {
  const userId = connection.session?.data.userId;
  if (!userId) {
    throw new TypedError({
      message: "Session not found",
      type: ErrorType.CONNECTION_SESSION_NOT_FOUND,
    });
  }
  return userId;
}

/**
 * A numeric id param, or the refusal for a missing one. Keryx validates params
 * before middleware runs, so this only trips on an action whose schema forgot it.
 * @param value - The param.
 * @param key - Its name.
 * @returns The id.
 */
function requireId(value: unknown, key: string): number {
  if (typeof value !== "number") {
    throw new TypedError({
      message: `A numeric ${key} is required`,
      type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
      key,
    });
  }
  return value;
}

/**
 * Load and enforce the caller's access to `params.projectId`, writing the
 * project, membership, tags, and standing onto `connection.metadata`. Every field
 * is written on every call, because MCP connections are reused across actions
 * and a previous action's membership must not survive into this one.
 * @param params - The validated action params (must carry a numeric `projectId`).
 * @param connection - The caller's connection.
 * @param options.requireAdmin - Also require admin standing.
 * @throws {TypedError} `CONNECTION_SESSION_NOT_FOUND` if signed out;
 *   `CONNECTION_CHANNEL_AUTHORIZATION` (403) if not a member, or not an admin.
 */
async function loadProjectAccess(
  params: { projectId?: unknown },
  connection: RbacConnection,
  options: { requireAdmin: boolean },
): Promise<void> {
  const userId = requireUserId(connection);
  const projectId = requireId(params.projectId, "projectId");
  const access = await resolveProjectAccess(userId, projectId);

  // Deliberately the same refusal whether the project does not exist or the
  // caller is not in it — otherwise this endpoint enumerates project ids.
  if (!access) {
    throw new TypedError({
      message: "You are not a member of this project",
      type: ErrorType.CONNECTION_CHANNEL_AUTHORIZATION,
    });
  }
  if (options.requireAdmin && !isAdmin(access.callerTags)) {
    throw new TypedError({
      message: `This action requires the "${ADMIN_TAG}" tag on this project`,
      type: ErrorType.CONNECTION_CHANNEL_AUTHORIZATION,
    });
  }

  connection.metadata.project = access.project;
  connection.metadata.membership = access.membership;
  connection.metadata.callerTags = access.callerTags;
  connection.metadata.viaOrganizationOwner = access.viaOrganizationOwner;
}

/**
 * Load and enforce the caller's membership in `params.organizationId`, writing
 * the organization and membership onto `connection.metadata`.
 * @param params - The validated action params (must carry a numeric `organizationId`).
 * @param connection - The caller's connection.
 * @param options.requireOwner - Also require `role = owner`.
 * @throws {TypedError} `CONNECTION_SESSION_NOT_FOUND` if signed out;
 *   `CONNECTION_CHANNEL_AUTHORIZATION` (403) if not a member, or not an owner.
 */
async function loadOrganizationAccess(
  params: { organizationId?: unknown },
  connection: RbacConnection,
  options: { requireOwner: boolean },
): Promise<void> {
  const userId = requireUserId(connection);
  const organizationId = requireId(params.organizationId, "organizationId");
  const membership = await getOrganizationMembership(
    api.db.db,
    organizationId,
    userId,
  );

  // The same refusal for "no such organization" and "not a member".
  if (!membership) {
    throw new TypedError({
      message: "You are not a member of this organization",
      type: ErrorType.CONNECTION_CHANNEL_AUTHORIZATION,
    });
  }
  if (options.requireOwner && membership.role !== "owner") {
    throw new TypedError({
      message: "This action requires being an owner of this organization",
      type: ErrorType.CONNECTION_CHANNEL_AUTHORIZATION,
    });
  }

  const [organization] = await api.db.db
    .select()
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);
  connection.metadata.organization = organization;
  connection.metadata.organizationMembership = membership;
  // Organization-level actions never act under a project's admin standing.
  connection.metadata.viaOrganizationOwner = undefined;
}

/** An action middleware carrying its RBAC descriptor. */
type DescribedMiddleware = ActionMiddleware & {
  [RBAC_DESCRIPTOR]?: RbacRequirement;
};

/**
 * Tag a middleware with the level it enforces. A factory per level rather than a
 * singleton so each returned object carries its own {@link RBAC_DESCRIPTOR}.
 * @param type - The level.
 * @param runBefore - The check.
 * @returns The described middleware.
 */
function described(
  type: RbacLevel,
  runBefore: (
    params: Record<string, unknown>,
    connection: RbacConnection,
  ) => Promise<void>,
): DescribedMiddleware {
  const mw: DescribedMiddleware = {
    runBefore: async (params, connection) =>
      runBefore(
        params as Record<string, unknown>,
        connection as RbacConnection,
      ),
  };
  mw[RBAC_DESCRIPTOR] = { type };
  return mw;
}

/**
 * Requires the `member` level on `params.projectId`: a project membership, or
 * owning its organization.
 * @returns The middleware.
 */
export function ProjectMemberMiddleware(): DescribedMiddleware {
  return described("member", (params, connection) =>
    loadProjectAccess(params, connection, { requireAdmin: false }),
  );
}

/**
 * Requires the `admin` level on `params.projectId`: the `admin` tag, or owning
 * its organization.
 * @returns The middleware.
 */
export function AdminMiddleware(): DescribedMiddleware {
  return described("admin", (params, connection) =>
    loadProjectAccess(params, connection, { requireAdmin: true }),
  );
}

/**
 * Requires the `org-member` level on `params.organizationId`.
 * @returns The middleware.
 */
export function OrganizationMemberMiddleware(): DescribedMiddleware {
  return described("org-member", (params, connection) =>
    loadOrganizationAccess(params, connection, { requireOwner: false }),
  );
}

/**
 * Requires the `org-owner` level on `params.organizationId`.
 * @returns The middleware.
 */
export function OrganizationOwnerMiddleware(): DescribedMiddleware {
  return described("org-owner", (params, connection) =>
    loadOrganizationAccess(params, connection, { requireOwner: true }),
  );
}
