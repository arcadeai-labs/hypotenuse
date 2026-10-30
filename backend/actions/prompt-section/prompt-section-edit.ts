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
  asSectionInput,
  assertPromptFits,
  assertSectionAccess,
  changeNoteInput,
  IDENTITY_KEY,
  loadSection,
  sectionBodyInput,
  sectionKeywordsInput,
  sectionLoadingInput,
  sectionTitleInput,
  sectionVersion,
  serializePromptSection,
  writeSectionVersion,
} from "../../ops/PromptSectionOps";
import {
  type NewPromptSection,
  promptSections,
} from "../../schema/prompt_sections";

/**
 * `prompt-section:edit` — change a section's text (a new version) or its
 * settings. Who may: the bot's writers for a bot section, admins for a
 * project section. The *Identity* section always loads and is never editable
 * by its bot. Audited.
 */
export class PromptSectionEdit extends AuditedAction {
  name = "prompt-section:edit";
  description =
    "Change a prompt section: its title or body (saved as a new version; send baseVersion to refuse the save if someone changed it since you read it), when it loads, its keywords, its position, or whether the bot may edit it itself. Bot sections need the bot's write access; project sections need a project admin. Refused if the always-included prompt would exceed the bot's token budget.";
  middleware = [ProjectMemberMiddleware()];
  web = {
    route: "/project/:projectId/prompt-section/:sectionId",
    method: HTTP_METHOD.POST,
  };
  inputs = z.object({
    projectId: idInput("The project"),
    sectionId: idInput("The section"),
    title: sectionTitleInput.optional(),
    body: sectionBodyInput.optional(),
    loading: sectionLoadingInput.optional(),
    keywords: sectionKeywordsInput.optional(),
    agentEditable: z
      .boolean()
      .optional()
      .describe("Whether the bot may change it itself with prompt_edit"),
    position: z.number().int().min(0).max(10_000).optional(),
    baseVersion: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("The version you edited; refused if it is no longer current"),
    changeNote: changeNoteInput.optional(),
  });

  /**
   * @param tx - The transaction the change and its audit row share.
   * @param params - The inputs.
   * @param connection - The caller's connection.
   * @returns The section.
   */
  async runWithAudit(
    tx: TxHandle,
    params: ActionParams<PromptSectionEdit>,
    connection: AuditedConnection,
  ) {
    const tags = connection.metadata.callerTags ?? [];
    const section = await loadSection(tx, params.projectId, params.sectionId, {
      lock: true,
    });
    const bot = await assertSectionAccess(tx, section, tags, "write");
    const refuse = (message: string) =>
      new TypedError({
        message,
        type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
      });
    if (section.archived) throw refuse("This section was deleted");
    if (
      params.baseVersion !== undefined &&
      params.baseVersion !== section.currentVersion
    ) {
      throw refuse(
        `This section changed since version ${params.baseVersion}; it is at version ${section.currentVersion}. Reload it and make your change again.`,
      );
    }
    const isIdentity = section.scope === "bot" && section.key === IDENTITY_KEY;
    if (isIdentity && params.agentEditable) {
      throw refuse("A bot may never edit its own Identity section");
    }
    if (isIdentity && params.loading === "contextual") {
      throw refuse("The Identity section is always included");
    }
    if (section.scope === "project" && params.agentEditable) {
      throw refuse(
        "A project section is in every bot's prompt; no bot may edit it",
      );
    }
    const current = await sectionVersion(
      tx,
      section.id,
      section.currentVersion,
    );
    connection.metadata.auditBefore = serializePromptSection(section, current);

    const settings: Partial<NewPromptSection> = {};
    for (const key of [
      "loading",
      "keywords",
      "agentEditable",
      "position",
    ] as const) {
      if (params[key] !== undefined) {
        (settings as Record<string, unknown>)[key] = params[key];
      }
    }
    const title = params.title ?? section.title;
    const body = params.body ?? current?.body ?? "";
    const textChanged =
      title !== (current?.title ?? section.title) || body !== current?.body;
    const after = { ...section, ...settings };
    if (after.loading === "always") {
      await assertPromptFits(
        tx,
        params.projectId,
        bot?.id ?? null,
        asSectionInput(after, title, body),
      );
    }
    let updated = section;
    if (Object.keys(settings).length > 0) {
      [updated] = await tx
        .update(promptSections)
        .set(settings)
        .where(eq(promptSections.id, section.id))
        .returning();
    }
    let version = current;
    if (textChanged) {
      const written = await writeSectionVersion(tx, updated, {
        title,
        body,
        source: "person",
        userId: connection.session?.data.userId ?? null,
        changeNote: params.changeNote ?? null,
      });
      updated = written.section;
      version = written.version;
    }
    const serialized = serializePromptSection(updated, version);
    connection.metadata.auditAfter = serialized;
    connection.metadata.auditTargetType = "prompt-section";
    connection.metadata.auditTargetPath = `${bot?.slug ?? "project"}/${section.key}`;
    return { promptSection: serialized };
  }
}
