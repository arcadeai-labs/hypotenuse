import { eq } from "drizzle-orm";
import { type ActionParams, ErrorType, HTTP_METHOD, TypedError } from "keryx";
import { z } from "zod";
import {
  AuditedAction,
  type AuditedConnection,
  type TxHandle,
} from "../../classes/AuditedAction";
import { ProjectMemberMiddleware } from "../../middleware/rbac";
import { idInput } from "../../ops/InputOps";
import {
  assertSectionAccess,
  IDENTITY_KEY,
  loadSection,
  sectionNotFound,
  sectionVersion,
  serializePromptSection,
} from "../../ops/PromptSectionOps";
import { promptSections } from "../../schema/prompt_sections";

/**
 * `prompt-section:delete` — take a section out of the prompt. It is archived,
 * not erased (its key freed for reuse), so its versions — and every transcript that recorded them —
 * stay readable. The *Identity* section cannot be deleted. Audited.
 */
export class PromptSectionDelete extends AuditedAction {
  name = "prompt-section:delete";
  description =
    "Delete a prompt section: it leaves the prompt from the next step, and its versions stay readable for transcripts that used them. A bot's Identity section cannot be deleted. Same access as editing the section.";
  middleware = [ProjectMemberMiddleware()];
  web = {
    route: "/project/:projectId/prompt-section/:sectionId",
    method: HTTP_METHOD.DELETE,
  };
  inputs = z.object({
    projectId: idInput("The project"),
    sectionId: idInput("The section"),
  });

  /**
   * @param tx - The transaction the archive and its audit row share.
   * @param params - The inputs.
   * @param connection - The caller's connection.
   * @returns The archived section.
   */
  async runWithAudit(
    tx: TxHandle,
    params: ActionParams<PromptSectionDelete>,
    connection: AuditedConnection,
  ) {
    const tags = connection.metadata.callerTags ?? [];
    const section = await loadSection(tx, params.projectId, params.sectionId, {
      lock: true,
    });
    const bot = await assertSectionAccess(tx, section, tags, "write");
    if (section.archived) throw sectionNotFound();
    if (section.scope === "bot" && section.key === IDENTITY_KEY) {
      throw new TypedError({
        message: "A bot's Identity section cannot be deleted; edit it instead",
        type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
      });
    }
    const current = await sectionVersion(
      tx,
      section.id,
      section.currentVersion,
    );
    connection.metadata.auditBefore = serializePromptSection(section, current);
    const [archived] = await tx
      .update(promptSections)
      // The key is freed for a new section; ids are what transcripts keep.
      .set({
        archived: true,
        key: `${section.key.slice(0, 40)}--deleted-${section.id}`,
      })
      .where(eq(promptSections.id, section.id))
      .returning();
    const serialized = serializePromptSection(archived, current);
    connection.metadata.auditAfter = serialized;
    connection.metadata.auditTargetType = "prompt-section";
    connection.metadata.auditTargetPath = `${bot?.slug ?? "project"}/${section.key}`;
    return { promptSection: serialized };
  }
}
