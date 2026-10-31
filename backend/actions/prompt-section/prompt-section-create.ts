import { and, eq, isNull } from "drizzle-orm";
import { type ActionParams, ErrorType, HTTP_METHOD, TypedError } from "keryx";
import { z } from "zod";
import {
  AuditedAction,
  type AuditedConnection,
  type TxHandle,
} from "../../classes/AuditedAction";
import { ProjectMemberMiddleware } from "../../middleware/rbac";
import { assertCanWriteBot, loadReadableBot } from "../../ops/BotOps";
import { idInput } from "../../ops/InputOps";
import {
  assertProjectSectionAdmin,
  assertPromptFits,
  changeNoteInput,
  IDENTITY_KEY,
  keyFromTitle,
  nextPosition,
  sectionBodyInput,
  sectionKeyInput,
  sectionKeywordsInput,
  sectionLoadingInput,
  sectionTitleInput,
  serializePromptSection,
} from "../../ops/PromptSectionOps";
import {
  promptSections,
  promptSectionVersions,
} from "../../schema/prompt_sections";

/**
 * `prompt-section:create` — add a section to one bot's prompt (the bot's
 * write access), or to every bot's in the project (admin). Audited.
 */
export class PromptSectionCreate extends AuditedAction {
  name = "prompt-section:create";
  description =
    "Add a section to a bot's system prompt (pass botId; needs the bot's write access) or to every bot's in the project (omit botId; project admins only). A section is a titled markdown body that loads always or only when its keywords come up (contextual), and may be marked editable by the bot itself. Refused if the always-included prompt would exceed the bot's token budget.";
  middleware = [ProjectMemberMiddleware()];
  web = {
    route: "/project/:projectId/prompt-section",
    method: HTTP_METHOD.PUT,
  };
  inputs = z.object({
    projectId: idInput("The project"),
    botId: idInput(
      "The bot whose prompt gets it; omit for a project section",
    ).optional(),
    key: sectionKeyInput
      .optional()
      .describe("A short unique key; made from the title when omitted"),
    title: sectionTitleInput,
    body: sectionBodyInput.default(""),
    loading: sectionLoadingInput.default("always"),
    keywords: sectionKeywordsInput.default([]),
    agentEditable: z
      .boolean()
      .default(false)
      .describe(
        "Whether the bot may change it itself with prompt_edit (bot sections only)",
      ),
    position: z
      .number()
      .int()
      .min(0)
      .max(10_000)
      .optional()
      .describe("Order within its group; after the others when omitted"),
    changeNote: changeNoteInput.optional(),
  });

  /**
   * @param tx - The transaction the insert and its audit row share.
   * @param params - The inputs.
   * @param connection - The caller's connection.
   * @returns The section.
   */
  async runWithAudit(
    tx: TxHandle,
    params: ActionParams<PromptSectionCreate>,
    connection: AuditedConnection,
  ) {
    const tags = connection.metadata.callerTags ?? [];
    const botId = params.botId ?? null;
    let path = "project";
    if (botId !== null) {
      const bot = await loadReadableBot(tx, params.projectId, botId, tags, {
        lock: true,
      });
      assertCanWriteBot(bot, tags);
      path = bot.slug;
    } else {
      assertProjectSectionAdmin(tags);
      if (params.agentEditable) {
        throw new TypedError({
          message:
            "A project section is in every bot's prompt; no bot may edit it",
          type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
        });
      }
    }
    const key = params.key ?? keyFromTitle(params.title);
    if (key === IDENTITY_KEY) {
      throw new TypedError({
        message: `"${IDENTITY_KEY}" is the key of a bot's Identity section; choose another`,
        type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
      });
    }
    const [taken] = await tx
      .select({ id: promptSections.id })
      .from(promptSections)
      .where(
        and(
          eq(promptSections.projectId, params.projectId),
          botId === null
            ? isNull(promptSections.botId)
            : eq(promptSections.botId, botId),
          eq(promptSections.key, key),
        ),
      );
    if (taken) {
      throw new TypedError({
        message: `A section with the key "${key}" already exists here; choose another key`,
        type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
      });
    }
    const position =
      params.position ?? (await nextPosition(tx, params.projectId, botId));
    if (params.loading === "always") {
      await assertPromptFits(tx, params.projectId, botId, {
        id: -1,
        key,
        scope: botId === null ? "project" : "bot",
        loading: params.loading,
        keywords: params.keywords,
        agentEditable: params.agentEditable,
        position,
        version: 1,
        title: params.title,
        body: params.body,
      });
    }
    const [section] = await tx
      .insert(promptSections)
      .values({
        projectId: params.projectId,
        scope: botId === null ? "project" : "bot",
        botId,
        key,
        title: params.title,
        loading: params.loading,
        keywords: params.keywords,
        agentEditable: botId !== null && params.agentEditable,
        position,
        origin: "person",
        currentVersion: 1,
      })
      .returning();
    const [version] = await tx
      .insert(promptSectionVersions)
      .values({
        sectionId: section.id,
        version: 1,
        title: params.title,
        body: params.body,
        source: "person",
        userId: connection.session?.data.userId ?? null,
        changeNote: params.changeNote ?? null,
      })
      .returning();
    const serialized = serializePromptSection(section, version);
    connection.metadata.auditAfter = serialized;
    connection.metadata.auditTargetType = "prompt-section";
    connection.metadata.auditTargetPath = `${path}/${key}`;
    return { promptSection: serialized };
  }
}
