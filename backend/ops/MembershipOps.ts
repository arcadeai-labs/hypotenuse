import { and, eq, sql } from "drizzle-orm";
import { api } from "keryx";
import { organizationMemberships } from "../schema/organization_memberships";
import {
  type ProjectMembership,
  projectMemberships,
} from "../schema/project_memberships";
import { type Project, projects } from "../schema/projects";
import { type Tag, tags } from "../schema/tags";
import { userTags } from "../schema/user_tags";
import type { DbHandle, TxHandle } from "./DbOps";
import { ADMIN_TAG, normalizeTagName } from "./TagOps";

/**
 * Shape a membership row into the API-safe object returned by actions.
 * @param membership - The membership row from the database.
 * @returns The serialized membership.
 */
export function serializeMembership(membership: ProjectMembership) {
  return {
    id: membership.id,
    userId: membership.userId,
    projectId: membership.projectId,
    createdAt: membership.createdAt.getTime(),
    updatedAt: membership.updatedAt.getTime(),
  };
}

/**
 * Load the tags a user holds within one project. Tags are project-scoped, and an
 * `admin` tag in one project must not administer another, so the join filters by
 * project.
 * @param userId - The user whose tags to load.
 * @param projectId - The project to scope the tags to.
 * @param db - A database handle (defaults to the shared pool).
 * @returns The user's tags in that project (empty if none).
 */
export async function getCallerTags(
  userId: number,
  projectId: number,
  db: DbHandle = api.db.db,
): Promise<Tag[]> {
  const rows = await db
    .select({ tag: tags })
    .from(userTags)
    .innerJoin(tags, eq(userTags.tagId, tags.id))
    .where(and(eq(userTags.userId, userId), eq(tags.projectId, projectId)));
  return rows.map((r) => r.tag);
}

/**
 * Whether a set of tags contains one with the given name, compared normalized.
 * @param tagList - The tags to search.
 * @param name - The tag name to look for.
 * @returns `true` if a matching tag is present.
 */
export function hasTag(tagList: Tag[], name: string): boolean {
  const target = normalizeTagName(name);
  return tagList.some((t) => normalizeTagName(t.name) === target);
}

/**
 * Whether a set of tags includes the reserved `admin` tag. Every admin check in
 * the app goes through this, and an organization owner's tags carry the
 * project's `admin` row (see {@link resolveProjectAccess}), so owners pass it
 * without any action knowing organizations exist.
 * @param tagList - The tags to check.
 * @returns `true` if they confer admin standing.
 */
export function isAdmin(tagList: Tag[]): boolean {
  return hasTag(tagList, ADMIN_TAG);
}

/** What a caller may do in one project, as {@link resolveProjectAccess} found it. */
export interface ProjectAccess {
  project: Project;
  /** Their explicit membership; absent for an owner who never joined. */
  membership: ProjectMembership | undefined;
  /** Their tags, plus the project's `admin` tag when they own the organization. */
  callerTags: Tag[];
  /** Whether they own the project's organization. */
  isOrganizationOwner: boolean;
  /**
   * Whether their admin standing comes from owning the organization rather than
   * from holding the `admin` tag themselves. Audit rows written under it say so.
   */
  viaOrganizationOwner: boolean;
}

/**
 * Resolve a user's access to a project: **the one place** organization owners
 * gain admin standing in every project of their organization.
 *
 * - A project member gets their own tags.
 * - An owner of the project's organization (member or not) additionally gets the
 *   project's reserved `admin` tag row in `callerTags`, so every downstream
 *   `isAdmin` and access-list check behaves exactly as for a project admin. No
 *   action branches on organizations.
 * - Anyone else, and any project that does not exist, gets `null` — one answer
 *   for both, so a refusal never says whether a tenant exists.
 * @param userId - The caller.
 * @param projectId - The project.
 * @param db - A database handle (defaults to the shared pool).
 * @returns Their access, or `null` when they have none.
 */
export async function resolveProjectAccess(
  userId: number,
  projectId: number,
  db: DbHandle = api.db.db,
): Promise<ProjectAccess | null> {
  const [row] = await db
    .select({
      project: projects,
      membership: projectMemberships,
      role: organizationMemberships.role,
    })
    .from(projects)
    .leftJoin(
      projectMemberships,
      and(
        eq(projectMemberships.projectId, projects.id),
        eq(projectMemberships.userId, userId),
      ),
    )
    .leftJoin(
      organizationMemberships,
      and(
        eq(organizationMemberships.organizationId, projects.organizationId),
        eq(organizationMemberships.userId, userId),
      ),
    )
    .where(eq(projects.id, projectId))
    .limit(1);

  if (!row) return null;
  const isOrganizationOwner = row.role === "owner";
  if (!row.membership && !isOrganizationOwner) return null;

  const callerTags = row.membership
    ? await getCallerTags(userId, projectId, db)
    : [];
  const explicitAdmin = isAdmin(callerTags);
  let viaOrganizationOwner = false;
  if (isOrganizationOwner && !explicitAdmin) {
    const [adminTag] = await db
      .select()
      .from(tags)
      .where(
        and(
          eq(tags.projectId, projectId),
          sql`lower(btrim(${tags.name})) = ${ADMIN_TAG}`,
        ),
      )
      .limit(1);
    if (adminTag) {
      callerTags.push(adminTag);
      viaOrganizationOwner = true;
    }
  }

  return {
    project: row.project,
    membership: row.membership ?? undefined,
    callerTags,
    isOrganizationOwner,
    viaOrganizationOwner,
  };
}

/**
 * The server's answer to "what may I do in this project", returned by
 * `project:view` so a client never infers it.
 * @param access - What {@link resolveProjectAccess} found.
 * @returns The caller's standing.
 */
export function projectStanding(access: {
  callerTags: Tag[];
  viaOrganizationOwner: boolean;
}) {
  return {
    // Reaching a project at all is the member level: a membership, or owning
    // the organization.
    isMember: true,
    isAdmin: isAdmin(access.callerTags),
    viaOrganizationOwner: access.viaOrganizationOwner,
  };
}

/**
 * Serialize every change that could remove a project's last admin.
 *
 * Under `READ COMMITTED`, two admins removing each other at once each read two
 * admins, each pass the guard, and both commit. `FOR UPDATE` on the project row
 * makes the second wait for the first to commit, so it reads the admin set the
 * first one left. Call it before {@link getAdminUserIds} in any guard. When an
 * organization lock is also needed, take that one first.
 * @param tx - The open transaction the guard and its write share.
 * @param projectId - The project whose admin set is about to change.
 */
export async function lockProjectAdmins(
  tx: TxHandle,
  projectId: number,
): Promise<void> {
  await tx
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.id, projectId))
    .for("update");
}

/**
 * The ids of every user holding the reserved `admin` tag in a project — the
 * **explicit** admins. The last-admin guard counts these, not organization
 * owners: a project keeps at least one person who administers it by being in
 * it, whoever owns the organization today.
 * @param db - A database handle.
 * @param projectId - The project whose admins to list.
 * @returns The user ids holding the `admin` tag.
 */
export async function getAdminUserIds(
  db: DbHandle,
  projectId: number,
): Promise<number[]> {
  const rows = await db
    .select({ userId: userTags.userId })
    .from(userTags)
    .innerJoin(tags, eq(userTags.tagId, tags.id))
    .where(
      and(
        eq(tags.projectId, projectId),
        sql`lower(btrim(${tags.name})) = ${ADMIN_TAG}`,
      ),
    );
  return rows.map((r) => r.userId);
}
