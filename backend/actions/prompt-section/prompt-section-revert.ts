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
  asSectionInput,
  assertPromptFits,
  assertSectionAccess,
  loadSection,
  sectionVersion,
  serializePromptSection,
  writeSectionVersion,
} from "../../ops/PromptSectionOps";

/**
 * `prompt-section:revert` — put an earlier version's text back, as a new
 * version: nothing is ever rewritten. How a person undoes a bot's own edit.
 * Audited.
 */
export class PromptSectionRevert extends AuditedAction {
  name = "prompt-section:revert";
  description =
    "Revert a prompt section to an earlier version's title and text, saved as a new version (history is never rewritten). This is how you undo an edit the bot made to itself. Same access as editing the section.";
  middleware = [ProjectMemberMiddleware()];
  web = {
    route: "/project/:projectId/prompt-section/:sectionId/revert",
    method: HTTP_METHOD.POST,
  };
  inputs = z.object({
    projectId: idInput("The project"),
    sectionId: idInput("The section"),
    version: z
      .number()
      .int()
      .positive()
      .describe("The version whose text to put back"),
  });

  /**
   * @param tx - The transaction the new version and its audit row share.
   * @param params - The inputs.
   * @param connection - The caller's connection.
   * @returns The section.
   */
  async runWithAudit(
    tx: TxHandle,
    params: ActionParams<PromptSectionRevert>,
    connection: AuditedConnection,
  ) {
    const tags = connection.metadata.callerTags ?? [];
    const section = await loadSection(tx, params.projectId, params.sectionId, {
      lock: true,
    });
    const bot = await assertSectionAccess(tx, section, tags, "write");
    if (section.archived) {
      throw new TypedError({
        message: "This section was deleted",
        type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
      });
    }
    const target = await sectionVersion(tx, section.id, params.version);
    if (!target) {
      throw new TypedError({
        message: `This section has no version ${params.version}`,
        type: ErrorType.CONNECTION_ACTION_NOT_FOUND,
      });
    }
    const current = await sectionVersion(
      tx,
      section.id,
      section.currentVersion,
    );
    connection.metadata.auditBefore = serializePromptSection(section, current);
    if (section.loading === "always") {
      await assertPromptFits(
        tx,
        params.projectId,
        bot?.id ?? null,
        asSectionInput(section, target.title, target.body),
      );
    }
    const written = await writeSectionVersion(tx, section, {
      title: target.title,
      body: target.body,
      source: "revert",
      userId: connection.session?.data.userId ?? null,
      changeNote: `Reverted to version ${target.version}`,
    });
    const serialized = serializePromptSection(written.section, written.version);
    connection.metadata.auditAfter = serialized;
    connection.metadata.auditTargetType = "prompt-section";
    connection.metadata.auditTargetPath = `${bot?.slug ?? "project"}/${section.key}`;
    return { promptSection: serialized };
  }
}
