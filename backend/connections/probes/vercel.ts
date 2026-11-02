import {
  VercelSandboxProvider,
  vercelCredentials,
} from "../../sandbox/providers/vercel";
import type { ProviderConnection } from "../../sandbox/types";

/**
 * Prove a Vercel connection before it is saved: list the project's
 * sandboxes carrying our managed tag. A bad token, team, or project fails
 * here, where an admin can fix it, rather than in a job later. Lists, never
 * creates: a probe costs nothing.
 * @param connection - The decrypted connection.
 * @returns A sentence saying what was found.
 * @throws {TypedError} The provider's failure, its token removed.
 */
export async function probeVercel(
  connection: ProviderConnection,
): Promise<string> {
  const provider = new VercelSandboxProvider(vercelCredentials(connection));
  const listed = await provider.list();
  return `Reached the Vercel project; ${listed.length} sandbox${listed.length === 1 ? "" : "es"} of ours there now.`;
}
