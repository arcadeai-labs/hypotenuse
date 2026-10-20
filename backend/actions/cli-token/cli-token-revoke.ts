import { and, eq, isNull } from "drizzle-orm";
import {
  type ActionParams,
  ErrorType,
  HTTP_METHOD,
  RateLimitMiddleware,
  TypedError,
} from "keryx";
import { z } from "zod";
import {
  AuditedAction,
  type AuditedConnection,
  type TxHandle,
} from "../../classes/AuditedAction";
import { SessionMiddleware } from "../../middleware/session";
import { serializeCliToken } from "../../ops/CliTokenOps";
import { cliTokens } from "../../schema/cli_tokens";

/**
 * `cli-token:revoke` — sign a CLI out. With `cliTokenId`, revokes that sign-in
 * (the caller's own only); without it, revokes the token the request is
 * authenticated with, which is what `hypotenuse logout` sends. Revocation takes
 * effect on the token's next request.
 */
export class CliTokenRevoke extends AuditedAction {
  name = "cli-token:revoke";
  description =
    "Revoke one of your own hypotenuse CLI sign-ins by id. Called with no id from a CLI, revokes that CLI's own sign-in.";
  middleware = [RateLimitMiddleware, SessionMiddleware];
  web = { route: "/cli-token", method: HTTP_METHOD.DELETE };
  inputs = z.object({
    cliTokenId: z.coerce
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "The CLI sign-in to revoke; omit to revoke the calling CLI's own",
      ),
  });

  /**
   * @param tx - The transaction the update and its audit row share.
   * @param params - The optional token id.
   * @param connection - The caller's connection.
   * @returns The revoked token.
   * @throws {TypedError} `CONNECTION_ACTION_PARAM_VALIDATION` with no id from a
   *   browser; `CONNECTION_ACTION_NOT_FOUND` for a token that is not the
   *   caller's, or is already revoked.
   */
  async runWithAudit(
    tx: TxHandle,
    params: ActionParams<CliTokenRevoke>,
    connection: AuditedConnection,
  ) {
    const principal = connection.metadata.principal;
    const id =
      params.cliTokenId ??
      (principal?.kind === "cli" ? principal.cliTokenId : undefined);
    if (id === undefined) {
      throw new TypedError({
        message: "cliTokenId is required",
        type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
        key: "cliTokenId",
      });
    }

    // Someone else's token and no token at all are the same answer, so this
    // endpoint does not confirm which ids exist.
    const [before] = await tx
      .select()
      .from(cliTokens)
      .where(
        and(
          eq(cliTokens.id, id),
          eq(cliTokens.userId, connection.session!.data.userId!),
          isNull(cliTokens.revokedAt),
        ),
      )
      .for("update")
      .limit(1);
    if (!before) {
      throw new TypedError({
        message: "CLI sign-in not found",
        type: ErrorType.CONNECTION_ACTION_NOT_FOUND,
      });
    }

    const [after] = await tx
      .update(cliTokens)
      .set({ revokedAt: new Date() })
      .where(eq(cliTokens.id, id))
      .returning();

    connection.metadata.auditBefore = serializeCliToken(before);
    connection.metadata.auditAfter = serializeCliToken(after);
    connection.metadata.auditTargetType = "cli-token";
    connection.metadata.auditTargetPath = after.device;
    return { cliToken: serializeCliToken(after) };
  }
}
