import { and, asc, count, eq, isNull } from "drizzle-orm";
import {
  type Action,
  type ActionParams,
  api,
  HTTP_METHOD,
  paginate,
  paginationInputs,
} from "keryx";
import { z } from "zod";
import type { AuditedConnection } from "../../classes/AuditedAction";
import { ProjectMemberMiddleware } from "../../middleware/rbac";
import { loadReadableBot } from "../../ops/BotOps";
import { idInput } from "../../ops/InputOps";
import {
  currentVersions,
  serializePromptSection,
} from "../../ops/PromptSectionOps";
import { promptSections } from "../../schema/prompt_sections";

/**
 * `prompt-section:list` — one bot's sections (its read access), or the
 * project's (any member), in position order, each with its current text.
 */
export class PromptSectionList implements Action {
  name = "prompt-section:list";
  description =
    "List prompt sections with their current text: a bot's own (pass botId; needs its read access), or the project's sections every bot includes (omit botId). In position order; deleted sections only with includeArchived. Paginated.";
  middleware = [ProjectMemberMiddleware()];
  web = {
    route: "/project/:projectId/prompt-sections",
    method: HTTP_METHOD.GET,
  };
  inputs = paginationInputs({ defaultLimit: 25 }).extend({
    projectId: idInput("The project"),
    botId: idInput("The bot; omit for the project's sections").optional(),
    includeArchived: z
      .stringbool()
      .default(false)
      .describe("Include deleted sections"),
  });

  /**
   * @param params - The inputs.
   * @param connection - The caller's connection.
   * @returns The sections and pagination metadata.
   */
  async run(
    params: ActionParams<PromptSectionList>,
    connection: AuditedConnection,
  ) {
    const tags = connection.metadata.callerTags ?? [];
    if (params.botId !== undefined) {
      await loadReadableBot(api.db.db, params.projectId, params.botId, tags);
    }
    const where = and(
      eq(promptSections.projectId, params.projectId),
      params.botId !== undefined
        ? eq(promptSections.botId, params.botId)
        : isNull(promptSections.botId),
      params.includeArchived ? undefined : eq(promptSections.archived, false),
    );
    const result = await paginate(
      api.db.db
        .select()
        .from(promptSections)
        .where(where)
        .orderBy(asc(promptSections.position), asc(promptSections.id))
        .$dynamic(),
      api.db.db.select({ count: count() }).from(promptSections).where(where),
      params,
    );
    const versions = await currentVersions(api.db.db, result.data);
    return {
      promptSections: result.data.map((s) =>
        serializePromptSection(s, versions.get(s.id)),
      ),
      pagination: result.pagination,
    };
  }
}
