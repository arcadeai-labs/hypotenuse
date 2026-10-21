import { eq } from "drizzle-orm";
import {
  type ActionParams,
  api,
  ErrorType,
  HTTP_METHOD,
  TypedError,
} from "keryx";
import { z } from "zod";
import {
  AuditedAction,
  type AuditedConnection,
  type TxHandle,
} from "../../classes/AuditedAction";
import { AdminMiddleware } from "../../middleware/rbac";
import { catalogKey } from "../../ops/LinearCatalogOps";
import { revokeInstallationTokens } from "../../ops/LinearOAuthOps";
import {
  LinearUnavailableError,
  rateLimitKey,
  serializeLinearInstallation,
} from "../../ops/LinearOps";
import { linearInstallations } from "../../schema/linear_installations";

/**
 * `linear:disconnect` — revoke the project's Linear tokens at Linear and forget
 * them. Revoking an `actor=app` token uninstalls the app from the workspace,
 * so `@hypotenuse` stops answering there at once.
 *
 * The row is kept, `revoked` with both token columns nulled, so whatever points
 * at it keeps its foreign key and the audit trail keeps its subject; the
 * workspace is then free to connect to another project. If Linear cannot be
 * reached nothing is forgotten, so trying again can still revoke.
 */
export class LinearDisconnect extends AuditedAction {
  name = "linear:disconnect";
  description =
    "Disconnect the project from its Linear workspace: revokes both of the app's tokens at Linear (uninstalling @hypotenuse there) and forgets them. Requires the admin tag on the project.";
  middleware = [AdminMiddleware()];
  web = { route: "/linear/installation", method: HTTP_METHOD.DELETE };
  inputs = z.object({
    projectId: z.coerce
      .number()
      .int()
      .positive()
      .describe("The project to disconnect from Linear"),
  });

  /**
   * @param tx - The transaction the update and its audit row share.
   * @param params - The project.
   * @param connection - The admin's connection.
   * @returns The installation, now `revoked`.
   * @throws {TypedError} `CONNECTION_ACTION_NOT_FOUND` when nothing is
   *   connected; `CONNECTION_SERVER_ERROR` when Linear could not be reached.
   */
  async runWithAudit(
    tx: TxHandle,
    params: ActionParams<LinearDisconnect>,
    connection: AuditedConnection,
  ) {
    const [existing] = await tx
      .select()
      .from(linearInstallations)
      .where(eq(linearInstallations.projectId, params.projectId))
      .for("update");
    if (!existing || existing.status === "revoked") {
      throw new TypedError({
        message: "This project is not connected to Linear",
        type: ErrorType.CONNECTION_ACTION_NOT_FOUND,
      });
    }

    try {
      await revokeInstallationTokens(existing);
    } catch (e) {
      if (e instanceof LinearUnavailableError) {
        throw new TypedError({
          message: `Linear could not be reached to revoke the tokens, so nothing was disconnected. Try again. (${e.message})`,
          type: ErrorType.CONNECTION_SERVER_ERROR,
        });
      }
      throw e;
    }

    const [row] = await tx
      .update(linearInstallations)
      .set({
        status: "revoked",
        accessTokenEncrypted: null,
        refreshTokenEncrypted: null,
        accessTokenLastFour: "",
        accessTokenExpiresAt: null,
        refreshError: null,
        refreshFailedAt: null,
      })
      .where(eq(linearInstallations.id, existing.id))
      .returning();

    const serialized = serializeLinearInstallation(row);
    connection.metadata.auditBefore = serializeLinearInstallation(existing);
    connection.metadata.auditAfter = serialized;
    connection.metadata.auditTargetType = "linear-installation";
    connection.metadata.auditTargetPath = existing.urlKey;
    return { installation: serialized };
  }

  /**
   * Drop what Redis caches for the installation.
   * @param result - The disconnected installation.
   */
  async afterCommit(result: unknown) {
    const { installation } = result as {
      installation: { id: number };
    };
    await api.redis.redis.del(
      catalogKey(installation.id),
      rateLimitKey(installation.id),
    );
  }
}
