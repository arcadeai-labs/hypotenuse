import { and, eq, ne, sql } from "drizzle-orm";
import { type ActionParams, ErrorType, HTTP_METHOD, TypedError } from "keryx";
import { z } from "zod";
import {
  AuditedAction,
  type AuditedConnection,
  type TxHandle,
} from "../../classes/AuditedAction";
import { AdminMiddleware } from "../../middleware/rbac";
import { renameTagInAccessLists } from "../../ops/AccessOps";
import { idInput } from "../../ops/InputOps";
import {
  assertNotReservedTag,
  normalizeTagName,
  serializeTag,
} from "../../ops/TagOps";
import { tags } from "../../schema/tags";

/**
 * `tag:edit` — rename a permission tag. Requires admin standing. Neither the old
 * nor the new name may be reserved, so a reserved tag can be neither renamed away
 * nor impersonated. Every access list naming the old name is rewritten to the new
 * one in the same transaction, so a rename changes no one's access.
 */
export class TagEdit extends AuditedAction {
  name = "tag:edit";
  description =
    "Rename a permission tag in a project; every access list naming it follows the rename. Requires admin standing in the project. The reserved 'admin' tag cannot be renamed, and no tag can be renamed to 'admin'.";
  middleware = [AdminMiddleware()];
  web = { route: "/project/:projectId/tag/:tagId", method: HTTP_METHOD.POST };
  inputs = z.object({
    projectId: idInput("The project the tag belongs to"),
    tagId: idInput("The id of the tag to rename"),
    name: z
      .string()
      .trim()
      .min(1, "Tag name is required")
      .max(256, "Tag name must be less than 256 characters")
      .describe("The new tag name (unique within the project)"),
  });

  /**
   * @param tx - The transaction the rename and its audit row share.
   * @param params - The validated inputs (`projectId`, `tagId`, `name`).
   * @param connection - The caller's connection (audit snapshots written here).
   * @returns The updated tag.
   * @throws {TypedError} `CONNECTION_ACTION_NOT_FOUND` if the tag is not in this
   *   project; `CONNECTION_ACTION_PARAM_VALIDATION` for a reserved name or a collision.
   */
  async runWithAudit(
    tx: TxHandle,
    params: ActionParams<TagEdit>,
    connection: AuditedConnection,
  ) {
    assertNotReservedTag(params.name);

    const [tag] = await tx
      .select()
      .from(tags)
      .where(
        and(eq(tags.id, params.tagId), eq(tags.projectId, params.projectId)),
      )
      .limit(1);

    if (!tag) {
      throw new TypedError({
        message: "Tag not found in this project",
        type: ErrorType.CONNECTION_ACTION_NOT_FOUND,
      });
    }
    assertNotReservedTag(tag.name);
    connection.metadata.auditBefore = serializeTag(tag);

    const [conflict] = await tx
      .select()
      .from(tags)
      .where(
        and(
          eq(tags.projectId, params.projectId),
          sql`lower(btrim(${tags.name})) = ${normalizeTagName(params.name)}`,
          ne(tags.id, params.tagId),
        ),
      )
      .limit(1);

    if (conflict) {
      throw new TypedError({
        message: "A tag with that name already exists in this project",
        type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
        key: "name",
      });
    }

    const [updated] = await tx
      .update(tags)
      .set({ name: params.name })
      .where(eq(tags.id, params.tagId))
      .returning();

    // Access lists name tags, so a rename carries them along: the people who
    // could read an object before the rename are exactly those who can after.
    const relabeled = await renameTagInAccessLists(
      tx,
      params.projectId,
      tag.name,
      updated.name,
    );
    connection.metadata.auditMetadata = {
      projectId: params.projectId,
      tagId: params.tagId,
      name: params.name,
      accessListsRenamed: relabeled,
    };

    const serialized = serializeTag(updated);
    connection.metadata.auditAfter = serialized;
    connection.metadata.auditTargetType = "tag";
    connection.metadata.auditTargetPath = updated.name;

    return { tag: serialized };
  }
}
