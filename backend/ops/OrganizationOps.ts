import { and, eq, inArray, like, or } from "drizzle-orm";
import { ErrorType, TypedError } from "keryx";
import {
  type OrganizationMembership,
  type OrganizationRole,
  organizationMemberships,
} from "../schema/organization_memberships";
import { type Organization, organizations } from "../schema/organizations";
import { projectMemberships } from "../schema/project_memberships";
import { projects } from "../schema/projects";
import { tags } from "../schema/tags";
import { userTags } from "../schema/user_tags";
import type { DbHandle, TxHandle } from "./DbOps";
import { getAdminUserIds, lockProjectAdmins } from "./MembershipOps";
import { firstFreeSlug, generateSlug } from "./SlugOps";

/**
 * A slug for an organization named `name`, unique across the deployment.
 * @param db - The transaction that will insert the organization.
 * @param name - The organization's display name.
 * @returns A free slug.
 */
export async function uniqueOrganizationSlug(
  db: DbHandle,
  name: string,
): Promise<string> {
  const base = generateSlug(name, "organization");
  const rows = await db
    .select({ slug: organizations.slug })
    .from(organizations)
    .where(
      or(eq(organizations.slug, base), like(organizations.slug, `${base}-%`)),
    );
  return firstFreeSlug(
    base,
    rows.map((r) => r.slug),
  );
}

/**
 * Create an organization with its first owner. Must run inside a transaction:
 * an organization with no owner is one nobody can administer, invite into, or
 * delete.
 * @param tx - An open Drizzle transaction.
 * @param userId - The owner.
 * @param name - The organization's display name.
 * @returns The organization and the owner's membership.
 */
export async function createOrganizationForOwner(
  tx: TxHandle,
  userId: number,
  name: string,
) {
  const slug = await uniqueOrganizationSlug(tx, name);
  const [organization] = await tx
    .insert(organizations)
    .values({ name, slug })
    .returning();
  const [membership] = await tx
    .insert(organizationMemberships)
    .values({ organizationId: organization.id, userId, role: "owner" })
    .returning();
  return { organization, membership };
}

/**
 * A user's membership in an organization.
 * @param db - A database handle.
 * @param organizationId - The organization.
 * @param userId - The user.
 * @returns The membership, or `undefined` when they hold none.
 */
export async function getOrganizationMembership(
  db: DbHandle,
  organizationId: number,
  userId: number,
): Promise<OrganizationMembership | undefined> {
  const [membership] = await db
    .select()
    .from(organizationMemberships)
    .where(
      and(
        eq(organizationMemberships.organizationId, organizationId),
        eq(organizationMemberships.userId, userId),
      ),
    )
    .limit(1);
  return membership;
}

/**
 * Serialize every change that could remove an organization's last owner.
 *
 * Under `READ COMMITTED`, two owners demoting each other at once each read two
 * owners, each pass the guard, and both commit — leaving an organization nobody
 * owns. `FOR UPDATE` on the organization row makes the second transaction wait
 * for the first to commit, so it reads the owner set the first one left. Call it
 * before {@link getOwnerUserIds} in any guard, and before locking any project of
 * the organization: the lock order is organization, then its projects.
 * @param tx - The open transaction the guard and its write share.
 * @param organizationId - The organization whose owner set may change.
 */
export async function lockOrganizationOwners(
  tx: TxHandle,
  organizationId: number,
): Promise<void> {
  await tx
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .for("update");
}

/**
 * The ids of every owner of an organization. Read it after
 * {@link lockOrganizationOwners}, on the same transaction, in a guard.
 * @param db - A database handle.
 * @param organizationId - The organization.
 * @returns The owners' user ids.
 */
export async function getOwnerUserIds(
  db: DbHandle,
  organizationId: number,
): Promise<number[]> {
  const rows = await db
    .select({ userId: organizationMemberships.userId })
    .from(organizationMemberships)
    .where(
      and(
        eq(organizationMemberships.organizationId, organizationId),
        eq(organizationMemberships.role, "owner"),
      ),
    );
  return rows.map((r) => r.userId);
}

/**
 * Refuse a change that would leave an organization with no owner.
 * @param tx - The open transaction, already holding {@link lockOrganizationOwners}.
 * @param organizationId - The organization.
 * @param userId - The owner about to stop being one.
 * @throws {TypedError} `CONNECTION_ACTION_PARAM_VALIDATION` when they are the last owner.
 */
export async function assertNotLastOwner(
  tx: TxHandle,
  organizationId: number,
  userId: number,
): Promise<void> {
  const owners = await getOwnerUserIds(tx, organizationId);
  if (owners.length === 1 && owners[0] === userId) {
    throw new TypedError({
      message:
        "Cannot remove the last owner of an organization. Make another member an owner first, or delete the organization.",
      type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
      key: "userId",
    });
  }
}

/** What {@link removeOrganizationMember} took away, for the audit row. */
export interface RemovedOrganizationMember {
  membership: OrganizationMembership;
  /** The projects whose membership went with it. */
  projectIds: number[];
  /** The tag ids revoked across those projects. */
  tagIds: number[];
}

/**
 * Remove a user from an organization, and with it every project membership and
 * tag they held there — one transaction, because a project membership without an
 * organization membership is the state the containment rule exists to forbid.
 *
 * The caller holds {@link lockOrganizationOwners} and has run the last-owner
 * guard. This takes the rest of the locks, in the one order: the membership row
 * (so a concurrent `membership:create` or invite accept either lands before this
 * reads the project memberships, or finds the organization membership gone), then
 * each affected project in id order, for its last-admin guard.
 * @param tx - The open transaction.
 * @param organizationId - The organization.
 * @param userId - The member to remove.
 * @returns What was removed.
 * @throws {TypedError} `CONNECTION_ACTION_PARAM_VALIDATION` when the user is not a
 *   member, or is the last holder of the `admin` tag in one of the projects.
 */
export async function removeOrganizationMember(
  tx: TxHandle,
  organizationId: number,
  userId: number,
): Promise<RemovedOrganizationMember> {
  const [membership] = await tx
    .select()
    .from(organizationMemberships)
    .where(
      and(
        eq(organizationMemberships.organizationId, organizationId),
        eq(organizationMemberships.userId, userId),
      ),
    )
    .for("update");
  if (!membership) {
    throw new TypedError({
      message: "That user is not a member of this organization",
      type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
      key: "userId",
    });
  }

  const held = await tx
    .select({ projectId: projectMemberships.projectId, name: projects.name })
    .from(projectMemberships)
    .innerJoin(projects, eq(projectMemberships.projectId, projects.id))
    .where(
      and(
        eq(projects.organizationId, organizationId),
        eq(projectMemberships.userId, userId),
      ),
    )
    .orderBy(projectMemberships.projectId);
  const projectIds = held.map((h) => h.projectId);

  for (const { projectId, name } of held) {
    await lockProjectAdmins(tx, projectId);
    const admins = await getAdminUserIds(tx, projectId);
    if (admins.length === 1 && admins[0] === userId) {
      throw new TypedError({
        message: `They are the last admin of the project "${name}". Give another member of that project the admin tag first.`,
        type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
        key: "userId",
      });
    }
  }

  let tagIds: number[] = [];
  if (projectIds.length > 0) {
    const revoked = await tx
      .select({ tagId: userTags.tagId })
      .from(userTags)
      .innerJoin(tags, eq(userTags.tagId, tags.id))
      .where(
        and(eq(userTags.userId, userId), inArray(tags.projectId, projectIds)),
      );
    tagIds = revoked.map((r) => r.tagId);
    if (tagIds.length > 0) {
      await tx
        .delete(userTags)
        .where(
          and(eq(userTags.userId, userId), inArray(userTags.tagId, tagIds)),
        );
    }
    await tx
      .delete(projectMemberships)
      .where(
        and(
          eq(projectMemberships.userId, userId),
          inArray(projectMemberships.projectId, projectIds),
        ),
      );
  }

  await tx
    .delete(organizationMemberships)
    .where(eq(organizationMemberships.id, membership.id));

  return { membership, projectIds, tagIds };
}

/**
 * Shape an organization row into the API-safe object returned by actions.
 * @param organization - The organization row.
 * @returns The serialized organization.
 */
export function serializeOrganization(organization: Organization) {
  return {
    id: organization.id,
    name: organization.name,
    slug: organization.slug,
    createdAt: organization.createdAt.getTime(),
    updatedAt: organization.updatedAt.getTime(),
  };
}

/**
 * Shape an organization membership row into the API-safe object returned by
 * actions.
 * @param membership - The membership row.
 * @returns The serialized membership.
 */
export function serializeOrganizationMembership(
  membership: OrganizationMembership,
) {
  return {
    id: membership.id,
    organizationId: membership.organizationId,
    userId: membership.userId,
    role: membership.role as OrganizationRole,
    createdAt: membership.createdAt.getTime(),
    updatedAt: membership.updatedAt.getTime(),
  };
}

/**
 * The server's answer to "what may I do in this organization", returned by
 * `organization:view` and `organization:list` so a client never infers it.
 * @param membership - The caller's membership.
 * @returns The caller's standing.
 */
export function organizationStanding(membership: OrganizationMembership) {
  return {
    isMember: true,
    isOwner: membership.role === "owner",
    role: membership.role as OrganizationRole,
  };
}
