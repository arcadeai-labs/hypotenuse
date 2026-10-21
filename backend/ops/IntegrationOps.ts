import { and, eq, ne } from "drizzle-orm";
import { api } from "keryx";
import {
  type Integration,
  integrations,
  type TriggerType,
} from "../schema/integrations";
import { linearConfigured } from "./LinearOps";

/**
 * Integrations — a project's connection to a workspace of one trigger system —
 * independent of which system it is. The type-specific halves live with their
 * type (`LinearOps`, `LinearOAuthOps`, …); this module is what the generic
 * `integration:*` actions and the session mirror share.
 */

/**
 * Whether this deployment can connect integrations of a type at all: its app
 * credentials are configured. Says nothing about whether they are right.
 * @param type - The trigger type.
 * @returns True when the type's app is configured.
 */
export function integrationConfigured(type: TriggerType): boolean {
  switch (type) {
    case "linear":
      return linearConfigured();
  }
}

/**
 * A project's integration of one type, whatever its status.
 * @param projectId - The project.
 * @param type - The trigger type.
 * @returns The row, or null when the project never connected that type.
 */
export async function getIntegration(
  projectId: number,
  type: TriggerType,
): Promise<Integration | null> {
  const [row] = await api.db.db
    .select()
    .from(integrations)
    .where(
      and(eq(integrations.projectId, projectId), eq(integrations.type, type)),
    )
    .limit(1);
  return row ?? null;
}

/**
 * An integration as every API answers it. There is no field either token, or
 * either ciphertext, fits in.
 * @param row - The row.
 * @returns The safe view, timestamps as epoch ms.
 */
export function serializeIntegration(row: Integration) {
  return {
    id: row.id,
    projectId: row.projectId,
    type: row.type,
    externalWorkspaceId: row.externalWorkspaceId,
    workspaceName: row.workspaceName,
    workspaceUrlKey: row.workspaceUrlKey,
    externalAppUserId: row.externalAppUserId,
    appUserName: row.appUserName,
    details: row.details,
    scopes: row.scopes,
    status: row.status,
    accessTokenLastFour: row.accessTokenLastFour,
    accessTokenExpiresAt: row.accessTokenExpiresAt?.getTime() ?? null,
    connectedAt: row.connectedAt.getTime(),
    lastRefreshedAt: row.lastRefreshedAt?.getTime() ?? null,
    refreshFailedAt: row.refreshFailedAt?.getTime() ?? null,
    refreshError: row.refreshError,
    rateLimit: row.rateLimit,
    connectedByUserId: row.connectedByUserId,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

/** {@link serializeIntegration}'s output. */
export type SerializedIntegration = ReturnType<typeof serializeIntegration>;

/**
 * The live integration a webhook delivery belongs to, by its type and the
 * workspace id the delivery names. Revoked rows never match: a disconnected
 * workspace's deliveries are recorded and ignored.
 * @param type - The trigger type whose webhook received it.
 * @param externalWorkspaceId - The workspace id in the body (Linear's
 *   `organizationId`).
 * @returns The integration, or null.
 */
export async function liveIntegrationForWorkspace(
  type: TriggerType,
  externalWorkspaceId: unknown,
): Promise<Integration | null> {
  if (typeof externalWorkspaceId !== "string" || !externalWorkspaceId) {
    return null;
  }
  const [row] = await api.db.db
    .select()
    .from(integrations)
    .where(
      and(
        eq(integrations.type, type),
        eq(integrations.externalWorkspaceId, externalWorkspaceId),
        ne(integrations.status, "revoked"),
      ),
    )
    .limit(1);
  return row ?? null;
}
