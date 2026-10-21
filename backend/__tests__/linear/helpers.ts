import { and, eq } from "drizzle-orm";
import { api } from "keryx";
import { decryptSecret } from "../../ops/CryptoOps";
import { type Integration, integrations } from "../../schema/integrations";

/**
 * A project's Linear integration row, read straight from Postgres.
 * @param projectId - The project.
 * @returns The row; throws when there is none.
 */
export async function integrationRow(projectId: number): Promise<Integration> {
  const [row] = await api.db.db
    .select()
    .from(integrations)
    .where(
      and(
        eq(integrations.projectId, projectId),
        eq(integrations.type, "linear"),
      ),
    );
  if (!row) throw new Error(`project ${projectId} has no Linear integration`);
  return row;
}

/**
 * A project's decrypted access token — what a test needs to act as the app in
 * finear directly. No API ever answers it.
 * @param projectId - The project.
 * @returns The plaintext access token.
 */
export async function appToken(projectId: number): Promise<string> {
  const row = await integrationRow(projectId);
  if (!row.accessTokenEncrypted) throw new Error("no access token");
  return decryptSecret(row.accessTokenEncrypted);
}

/**
 * A project's decrypted refresh token.
 * @param projectId - The project.
 * @returns The plaintext refresh token.
 */
export async function refreshTokenOf(projectId: number): Promise<string> {
  const row = await integrationRow(projectId);
  if (!row.refreshTokenEncrypted) throw new Error("no refresh token");
  return decryptSecret(row.refreshTokenEncrypted);
}

/**
 * Put an integration's access-token expiry where a test wants it: the way
 * these suites control time, rather than waiting a day.
 * @param projectId - The project.
 * @param expiresAt - The new expiry.
 */
export async function setTokenExpiry(
  projectId: number,
  expiresAt: Date,
): Promise<void> {
  await api.db.db
    .update(integrations)
    .set({ accessTokenExpiresAt: expiresAt })
    .where(
      and(
        eq(integrations.projectId, projectId),
        eq(integrations.type, "linear"),
      ),
    );
}
