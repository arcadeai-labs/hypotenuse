import { and, eq } from "drizzle-orm";
import {
  type Action,
  type ActionParams,
  api,
  type Connection,
  ErrorType,
  HTTP_METHOD,
  TypedError,
} from "keryx";
import { z } from "zod";
import {
  ProjectMemberMiddleware,
  type RbacConnectionMeta,
} from "../../middleware/rbac";
import type { SessionImpl } from "../../middleware/session";
import { canReadBot } from "../../ops/BotOps";
import { approvalsOfRuns, serializeCodeRun } from "../../ops/CodeRunOps";
import { idInput } from "../../ops/InputOps";
import { bots } from "../../schema/bots";
import { codeRuns } from "../../schema/code_runs";

/**
 * `code-run:view` — one code-mode program. Never its continuation. Requires
 * membership and the read access of the bot that ran it; a run the caller
 * cannot read is the same 404 as a missing one.
 */
export class CodeRunView implements Action {
  name = "code-run:view";
  description =
    "Read one program a bot ran with run_code: its source, status, the host calls it made and how each was let through, the approvals it waited on, and its result or error. Requires membership and read access to the bot.";
  middleware = [ProjectMemberMiddleware()];
  web = {
    route: "/project/:projectId/code-run/:codeRunId",
    method: HTTP_METHOD.GET,
  };
  inputs = z.object({
    projectId: idInput("The project"),
    codeRunId: idInput("The code run"),
  });

  /**
   * @param params - The run.
   * @param connection - The caller's connection (tags set by the middleware).
   * @returns The run.
   * @throws {TypedError} `CONNECTION_ACTION_NOT_FOUND`.
   */
  async run(
    params: ActionParams<CodeRunView>,
    connection: Connection<SessionImpl, RbacConnectionMeta>,
  ) {
    const [found] = await api.db.db
      .select({ run: codeRuns, bot: bots })
      .from(codeRuns)
      .innerJoin(bots, eq(bots.id, codeRuns.botId))
      .where(
        and(
          eq(codeRuns.id, params.codeRunId),
          eq(codeRuns.projectId, params.projectId),
        ),
      );
    if (
      !found ||
      !canReadBot(found.bot, connection.metadata.callerTags ?? [])
    ) {
      throw new TypedError({
        message: "Code run not found in this project",
        type: ErrorType.CONNECTION_ACTION_NOT_FOUND,
      });
    }
    const byRun = await approvalsOfRuns(api.db.db, [found.run.id]);
    return {
      codeRun: serializeCodeRun(found.run, byRun.get(found.run.id) ?? []),
    };
  }
}
