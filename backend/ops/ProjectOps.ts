import { and, eq, inArray, like, ne, or } from "drizzle-orm";
import { organizationMemberships } from "../schema/organization_memberships";
import { projectMemberships } from "../schema/project_memberships";
import { projectSettings } from "../schema/project_settings";
import { type Project, projects } from "../schema/projects";
import { tags } from "../schema/tags";
import { userTags } from "../schema/user_tags";
import type { DbHandle, TxHandle } from "./DbOps";
import { firstFreeSlug, generateSlug } from "./SlugOps";
import { ADMIN_TAG } from "./TagOps";

/** The name the sign-up bootstrap gives a person's first project. */
export const DEFAULT_PROJECT_NAME = "Default";

/**
 * A slug for a project named `name`, unique within its organization.
 * @param db - The transaction that will insert or rename the project.
 * @param organizationId - The organization the slug must be unique in.
 * @param name - The project's display name.
 * @param exceptProjectId - A project to ignore (the one being renamed).
 * @returns A free slug.
 */
export async function uniqueProjectSlug(
  db: DbHandle,
  organizationId: number,
  name: string,
  exceptProjectId?: number,
): Promise<string> {
  const base = generateSlug(name, "project");
  const rows = await db
    .select({ slug: projects.slug })
    .from(projects)
    .where(
      and(
        eq(projects.organizationId, organizationId),
        or(eq(projects.slug, base), like(projects.slug, `${base}-%`)),
        exceptProjectId ? ne(projects.id, exceptProjectId) : undefined,
      ),
    );
  return firstFreeSlug(
    base,
    rows.map((r) => r.slug),
  );
}

/**
 * Create a project in an organization with a first explicit admin: the project,
 * the creator's membership, the reserved `admin` tag, the user-tag linking them,
 * and the project's settings row. Must run inside a transaction — it is shared
 * by the sign-up bootstrap and `project:create`, and a partial bootstrap would
 * leave a project nobody holds the admin tag in.
 *
 * The caller must already be a member of `organizationId`: project membership
 * requires organization membership, and this helper does not create one.
 * @param tx - An open Drizzle transaction.
 * @param organizationId - The organization the project belongs to.
 * @param userId - The creator, who becomes its first explicit admin.
 * @param projectName - The display name for the project.
 * @returns The created project, the creator's membership, and the admin tag.
 */
export async function createProjectForOwner(
  tx: TxHandle,
  organizationId: number,
  userId: number,
  projectName: string,
) {
  const slug = await uniqueProjectSlug(tx, organizationId, projectName);
  const [project] = await tx
    .insert(projects)
    .values({ organizationId, name: projectName, slug })
    .returning();

  const [membership] = await tx
    .insert(projectMemberships)
    .values({ userId, projectId: project.id })
    .returning();

  const [adminTag] = await tx
    .insert(tags)
    .values({ projectId: project.id, name: ADMIN_TAG })
    .returning();

  await tx.insert(userTags).values({ userId, tagId: adminTag.id });
  await tx.insert(projectSettings).values({ projectId: project.id });

  return { project, membership, adminTag };
}

/**
 * Whether a user may see a project at all: they hold a membership in it, or own
 * its organization. The one definition `project:list` and the channel gate share
 * with the RBAC middleware's member level.
 * @param db - A database handle.
 * @param userId - The user.
 * @returns A SQL condition over `projects` for use in a `where`.
 */
export function visibleProjectsCondition(db: DbHandle, userId: number) {
  return or(
    inArray(
      projects.id,
      db
        .select({ id: projectMemberships.projectId })
        .from(projectMemberships)
        .where(eq(projectMemberships.userId, userId)),
    ),
    inArray(
      projects.organizationId,
      db
        .select({ id: organizationMemberships.organizationId })
        .from(organizationMemberships)
        .where(
          and(
            eq(organizationMemberships.userId, userId),
            eq(organizationMemberships.role, "owner"),
          ),
        ),
    ),
  );
}

/**
 * Shape a project row into the API-safe object returned by actions. Timestamps
 * are emitted as epoch milliseconds.
 * @param project - The project row from the database.
 * @returns The serialized project.
 */
export function serializeProject(project: Project) {
  return {
    id: project.id,
    organizationId: project.organizationId,
    name: project.name,
    slug: project.slug,
    createdAt: project.createdAt.getTime(),
    updatedAt: project.updatedAt.getTime(),
  };
}
