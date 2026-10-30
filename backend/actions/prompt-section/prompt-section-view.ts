import { type Action, type ActionParams, api, HTTP_METHOD } from "keryx";
import { z } from "zod";
import type { AuditedConnection } from "../../classes/AuditedAction";
import { ProjectMemberMiddleware } from "../../middleware/rbac";
import { idInput } from "../../ops/InputOps";
import {
  assertSectionAccess,
  loadSection,
  sectionVersion,
  serializePromptSection,
} from "../../ops/PromptSectionOps";

/**
 * `prompt-section:view` — one section with its current text. A bot section
 * needs the bot's read access; a project section, membership.
 */
export class PromptSectionView implements Action {
  name = "prompt-section:view";
  description =
    "Get one prompt section with its current text, version, and settings. A bot section needs the bot's read access.";
  middleware = [ProjectMemberMiddleware()];
  web = {
    route: "/project/:projectId/prompt-section/:sectionId",
    method: HTTP_METHOD.GET,
  };
  inputs = z.object({
    projectId: idInput("The project"),
    sectionId: idInput("The section"),
  });

  /**
   * @param params - The inputs.
   * @param connection - The caller's connection.
   * @returns The section.
   */
  async run(
    params: ActionParams<PromptSectionView>,
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
    const current = await sectionVersion(
      api.db.db,
      section.id,
      section.currentVersion,
    );
    return { promptSection: serializePromptSection(section, current) };
  }
}
