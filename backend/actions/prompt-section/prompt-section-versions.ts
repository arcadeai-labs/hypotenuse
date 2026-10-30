import { count, desc, eq } from "drizzle-orm";
import {
  type Action,
  type ActionParams,
  api,
  HTTP_METHOD,
  paginate,
  paginationInputs,
} from "keryx";
import type { AuditedConnection } from "../../classes/AuditedAction";
import { ProjectMemberMiddleware } from "../../middleware/rbac";
import { idInput } from "../../ops/InputOps";
import {
  assertSectionAccess,
  loadSection,
  serializePromptSectionVersion,
} from "../../ops/PromptSectionOps";
import { promptSectionVersions } from "../../schema/prompt_sections";

/**
 * `prompt-section:versions` — a section's history, newest first: who wrote
 * each version (a person, the bot — with the conversation and entry — a
 * revert, or the seed) and why.
 */
export class PromptSectionVersions implements Action {
  name = "prompt-section:versions";
  description =
    "List a prompt section's versions, newest first, each with its text, who wrote it (person, agent with the conversation and entry that caused it, revert, or seed), and its change note. Paginated.";
  middleware = [ProjectMemberMiddleware()];
  web = {
    route: "/project/:projectId/prompt-section/:sectionId/versions",
    method: HTTP_METHOD.GET,
  };
  inputs = paginationInputs({ defaultLimit: 25 }).extend({
    projectId: idInput("The project"),
    sectionId: idInput("The section"),
  });

  /**
   * @param params - The inputs.
   * @param connection - The caller's connection.
   * @returns The versions and pagination metadata.
   */
  async run(
    params: ActionParams<PromptSectionVersions>,
    connection: AuditedConnection,
  ) {
    const section = await loadSection(
      api.db.db,
      params.projectId,
      params.sectionId,
    );
    await assertSectionAccess(
      api.db.db,
      section,
      connection.metadata.callerTags ?? [],
      "read",
    );
    const where = eq(promptSectionVersions.sectionId, section.id);
    const result = await paginate(
      api.db.db
        .select()
        .from(promptSectionVersions)
        .where(where)
        .orderBy(desc(promptSectionVersions.version))
        .$dynamic(),
      api.db.db
        .select({ count: count() })
        .from(promptSectionVersions)
        .where(where),
      params,
    );
    return {
      versions: result.data.map(serializePromptSectionVersion),
      pagination: result.pagination,
    };
  }
}
