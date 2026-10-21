import { and, eq } from "drizzle-orm";
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
import { serializeIntegration } from "../../ops/IntegrationOps";
import { catalogKey } from "../../ops/LinearCatalogOps";
import { revokeIntegrationTokens } from "../../ops/LinearOAuthOps";
import { LinearUnavailableError, rateLimitKey } from "../../ops/LinearOps";
import { integrations, TRIGGER_TYPES } from "../../schema/integrations";

/**
 * `integration:disconnect` — revoke the project's tokens for one trigger type
 * at that system and forget them. For `linear`: revoking an `actor=app` token
 * uninstalls the app from the workspace. Revoking an `actor=app` token uninstalls the app from the workspace,
 * so `@hypotenuse` stops answering there at once.
 *
 * The row is kept, `revoked` with both token columns nulled, so whatever points
 * at it keeps its foreign key and the audit trail keeps its subject; the
 * workspace is then free to connect to another project. If Linear cannot be
 * reached nothing is forgotten, so trying again can still revoke.
 */
export class IntegrationDisconnect extends AuditedAction {
  name = "integration:disconnect";
  description =
    "Disconnect the project from its workspace in one trigger system (today: linear): revokes both of the app's tokens there (uninstalling @hypotenuse) and forgets them. Requires the admin tag on the project.";
  middleware = [AdminMiddleware()];
  web = { route: "/integration", method: HTTP_METHOD.DELETE };
  inputs = z.object({
    projectId: z.coerce
      .number()
      .int()
      .positive()
      .describe("The project to disconnect"),
    type: z.enum(TRIGGER_TYPES).describe("The trigger system, e.g. linear"),
  });

  /**
   * @param tx - The transaction the update and its audit row share.
   * @param params - The project and type.
   * @param connection - The admin's connection.
   * @returns The integration, now `revoked`.
   * @throws {TypedError} `CONNECTION_ACTION_NOT_FOUND` when nothing is
   *   connected; `CONNECTION_SERVER_ERROR` when Linear could not be reached.
   */
  async runWithAudit(
    tx: TxHandle,
    params: ActionParams<IntegrationDisconnect>,
    connection: AuditedConnection,
  ) {
    const [existing] = await tx
      .select()
      .from(integrations)
      .where(
        and(
          eq(integrations.projectId, params.projectId),
          eq(integrations.type, params.type),
        ),
      )
      .for("update");
    if (!existing || existing.status === "revoked") {
      throw new TypedError({
        message: `This project has no ${params.type} integration`,
        type: ErrorType.CONNECTION_ACTION_NOT_FOUND,
      });
    }

    try {
      await revokeIntegrationTokens(existing);
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
      .update(integrations)
      .set({
        status: "revoked",
        accessTokenEncrypted: null,
        refreshTokenEncrypted: null,
        accessTokenLastFour: "",
        accessTokenExpiresAt: null,
        refreshError: null,
        refreshFailedAt: null,
      })
      .where(eq(integrations.id, existing.id))
      .returning();

    const serialized = serializeIntegration(row);
    connection.metadata.auditBefore = serializeIntegration(existing);
    connection.metadata.auditAfter = serialized;
    connection.metadata.auditTargetType = "integration";
    connection.metadata.auditTargetPath = `${existing.type}:${existing.workspaceUrlKey}`;
    return { integration: serialized };
  }

  /**
   * Drop what Redis caches for the integration.
   * @param result - The disconnected integration.
   */
  async afterCommit(result: unknown) {
    const { integration } = result as {
      integration: { id: number };
    };
    await api.redis.redis.del(
      catalogKey(integration.id),
      rateLimitKey(integration.id),
    );
  }
}
