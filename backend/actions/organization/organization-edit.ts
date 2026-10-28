import { and, eq, ne } from "drizzle-orm";
import { type ActionParams, ErrorType, HTTP_METHOD, TypedError } from "keryx";
import { z } from "zod";
import {
  AuditedAction,
  type AuditedConnection,
  type TxHandle,
} from "../../classes/AuditedAction";
import { OrganizationOwnerMiddleware } from "../../middleware/rbac";
import { idInput, nameInput } from "../../ops/InputOps";
import { serializeOrganization } from "../../ops/OrganizationOps";
import { SLUG_PATTERN } from "../../ops/SlugOps";
import { organizations } from "../../schema/organizations";

/**
 * `organization:edit` — rename an organization or change its slug. Owners only.
 * Unlike a project, an organization's slug never follows its name on its own: it
 * is how the organization is named in URLs people have already shared.
 */
export class OrganizationEdit extends AuditedAction {
  name = "organization:edit";
  description =
    "Rename an organization and/or change its slug (lowercase letters, digits, and single hyphens; unique across Hypotenuse). Requires being an owner of the organization.";
  middleware = [OrganizationOwnerMiddleware()];
  web = {
    route: "/organization/:organizationId",
    method: HTTP_METHOD.POST,
  };
  inputs = z.object({
    organizationId: idInput("The organization to edit"),
    name: nameInput("The new display name").optional(),
    slug: z
      .string()
      .trim()
      .toLowerCase()
      .min(3, "Slug must be at least 3 characters")
      .max(64, "Slug must be at most 64 characters")
      .regex(
        SLUG_PATTERN,
        "Slug may contain lowercase letters, digits, and single hyphens",
      )
      .optional()
      .describe("The new URL slug"),
  });

  /**
   * @param tx - The transaction the update and its audit row share.
   * @param params - The validated inputs.
   * @param connection - The caller's connection.
   * @returns The updated organization.
   * @throws {TypedError} `CONNECTION_ACTION_PARAM_VALIDATION` when the slug is taken.
   */
  async runWithAudit(
    tx: TxHandle,
    params: ActionParams<OrganizationEdit>,
    connection: AuditedConnection,
  ) {
    const [existing] = await tx
      .select()
      .from(organizations)
      .where(eq(organizations.id, params.organizationId))
      .limit(1);
    if (!existing) {
      throw new TypedError({
        message: "Organization not found",
        type: ErrorType.CONNECTION_ACTION_NOT_FOUND,
      });
    }
    connection.metadata.auditBefore = serializeOrganization(existing);
    connection.metadata.auditTargetType = "organization";

    if (params.slug && params.slug !== existing.slug) {
      const [taken] = await tx
        .select({ id: organizations.id })
        .from(organizations)
        .where(
          and(
            eq(organizations.slug, params.slug),
            ne(organizations.id, existing.id),
          ),
        )
        .limit(1);
      if (taken) {
        throw new TypedError({
          message: "That slug is taken. Choose another.",
          type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
          key: "slug",
        });
      }
    }

    const updates: { name?: string; slug?: string } = {};
    if (params.name !== undefined) updates.name = params.name;
    if (params.slug !== undefined) updates.slug = params.slug;
    const [organization] =
      Object.keys(updates).length > 0
        ? await tx
            .update(organizations)
            .set(updates)
            .where(eq(organizations.id, existing.id))
            .returning()
        : [existing];

    const serialized = serializeOrganization(organization);
    connection.metadata.auditAfter = serialized;
    connection.metadata.auditTargetPath = organization.slug;
    return { organization: serialized };
  }
}
