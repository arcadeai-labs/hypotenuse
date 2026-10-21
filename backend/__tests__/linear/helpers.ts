import { eq } from "drizzle-orm";
import { api } from "keryx";
import { decryptSecret } from "../../ops/CryptoOps";
import {
  type LinearInstallation,
  linearInstallations,
} from "../../schema/linear_installations";

/**
 * A project's installation row, read straight from Postgres.
 * @param projectId - The project.
 * @returns The row; throws when there is none.
 */
export async function installationRow(
  projectId: number,
): Promise<LinearInstallation> {
  const [row] = await api.db.db
    .select()
    .from(linearInstallations)
    .where(eq(linearInstallations.projectId, projectId));
  if (!row) throw new Error(`project ${projectId} has no installation`);
  return row;
}

/**
 * A project's decrypted access token — what a test needs to act as the app in
 * finear directly. No API ever answers it.
 * @param projectId - The project.
 * @returns The plaintext access token.
 */
export async function appToken(projectId: number): Promise<string> {
  const row = await installationRow(projectId);
  if (!row.accessTokenEncrypted) throw new Error("no access token");
  return decryptSecret(row.accessTokenEncrypted);
}

/**
 * A project's decrypted refresh token.
 * @param projectId - The project.
 * @returns The plaintext refresh token.
 */
export async function refreshTokenOf(projectId: number): Promise<string> {
  const row = await installationRow(projectId);
  if (!row.refreshTokenEncrypted) throw new Error("no refresh token");
  return decryptSecret(row.refreshTokenEncrypted);
}

/**
 * Put an installation's access-token expiry where a test wants it: the way
 * these suites control time, rather than waiting a day.
 * @param projectId - The project.
 * @param expiresAt - The new expiry.
 */
export async function setTokenExpiry(
  projectId: number,
  expiresAt: Date,
): Promise<void> {
  await api.db.db
    .update(linearInstallations)
    .set({ accessTokenExpiresAt: expiresAt })
    .where(eq(linearInstallations.projectId, projectId));
}
