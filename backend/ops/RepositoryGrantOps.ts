import { and, eq, inArray } from "drizzle-orm";
import { ErrorType, TypedError } from "keryx";
import { z } from "zod";
import { bots } from "../schema/bots";
import {
  type GithubInstallation,
  githubInstallations,
} from "../schema/github_installations";
import {
  type RepositoryGrant,
  repositoryGrants,
} from "../schema/repository_grants";
import type { DbHandle } from "./DbOps";
import {
  appForInstallation,
  isUsableInstallation,
  mintInstallationToken,
  revokeInstallationToken,
} from "./GitHubAppOps";

/**
 * The rules a repository grant is held to before it is saved: the
 * installation is the project's and usable, the repository is on that
 * installation's account and visible to it, the bots are the project's, and
 * a push grant without a branch prefix says why that matters.
 */

/** A branch namespace jobs are asked to push into. */
export const branchPrefixInput = z
  .string()
  .trim()
  .min(1, "A branch prefix cannot be empty; send null to clear it")
  .max(200)
  .regex(
    /^[A-Za-z0-9._\-/]+$/,
    "A branch prefix may hold letters, digits, '.', '_', '-', and '/'",
  )
  .refine((v) => !v.includes("..") && !v.startsWith("/"), {
    message: "A branch prefix cannot start with '/' or contain '..'",
  })
  .describe(
    "The branch namespace jobs are asked to push into, e.g. hypotenuse/ada/ (guidance; a GitHub ruleset enforces it). Default: hypotenuse/<bot-slug>/",
  );

/** The bots a grant covers, or null for every bot. */
export const grantBotIdsInput = z
  .array(z.coerce.number().int().positive())
  .min(1, "List at least one bot, or send null for every bot in the project")
  .max(500)
  .nullable()
  .describe(
    "The ids of the bots in this project that may use the grant; null (or omitted on create) for every bot",
  );

/** The warning a push grant without a branch prefix carries. */
export const NO_PREFIX_WARNING =
  "This grant may push and has no branch prefix: jobs are asked to use hypotenuse/<bot-slug>/, but an installation token can write every branch. Set a branch prefix and add a ruleset on GitHub that only lets the App push under it.";

/**
 * The warnings a grant's settings carry.
 * @param grant - The grant as saved.
 * @returns Sentences for a person; empty when none apply.
 */
export function grantWarnings(
  grant: Pick<RepositoryGrant, "push" | "branchPrefix">,
): string[] {
  return grant.push && !grant.branchPrefix?.trim() ? [NO_PREFIX_WARNING] : [];
}

/**
 * Load a grant in a project, with the installation it is reached through.
 * @param db - A database handle.
 * @param projectId - The project.
 * @param grantId - The grant.
 * @param options.lock - Take `FOR UPDATE` on the grant.
 * @returns The grant and its installation.
 * @throws {TypedError} `CONNECTION_ACTION_NOT_FOUND`.
 */
export async function loadGrant(
  db: DbHandle,
  projectId: number,
  grantId: number,
  options: { lock?: boolean } = {},
): Promise<{ grant: RepositoryGrant; installation: GithubInstallation }> {
  const query = db
    .select({ grant: repositoryGrants, installation: githubInstallations })
    .from(repositoryGrants)
    .innerJoin(
      githubInstallations,
      eq(githubInstallations.id, repositoryGrants.githubInstallationId),
    )
    .where(
      and(
        eq(repositoryGrants.id, grantId),
        eq(repositoryGrants.projectId, projectId),
      ),
    )
    .limit(1);
  const [row] = options.lock
    ? await query.for("update", { of: repositoryGrants })
    : await query;
  if (!row) {
    throw new TypedError({
      message: "Repository grant not found in this project",
      type: ErrorType.CONNECTION_ACTION_NOT_FOUND,
    });
  }
  return row;
}

/**
 * Load an attached installation a grant may be made through: the project's,
 * and neither suspended nor removed.
 * @param db - A database handle.
 * @param projectId - The project.
 * @param id - The `github_installations` row.
 * @returns The installation.
 * @throws {TypedError} `CONNECTION_ACTION_PARAM_VALIDATION`.
 */
export async function loadUsableInstallation(
  db: DbHandle,
  projectId: number,
  id: number,
): Promise<GithubInstallation> {
  const [row] = await db
    .select()
    .from(githubInstallations)
    .where(
      and(
        eq(githubInstallations.id, id),
        eq(githubInstallations.projectId, projectId),
      ),
    )
    .limit(1);
  if (!row) {
    throw new TypedError({
      message: `No GitHub installation ${id} is attached to this project. List them with github:installation-list, or attach one with github:install-url.`,
      type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
      key: "githubInstallationId",
    });
  }
  if (!isUsableInstallation(row)) {
    throw new TypedError({
      message: `The GitHub installation on ${row.accountLogin} is ${row.revokedAt ? "removed" : "suspended"} on GitHub, so nothing can be granted through it. Reinstall or unsuspend the App there first.`,
      type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
      key: "githubInstallationId",
    });
  }
  return row;
}

/**
 * Refuse bot ids that are not bots in the project.
 * @param db - A database handle.
 * @param projectId - The project.
 * @param botIds - The ids, or `null` for every bot.
 * @returns The ids deduplicated and sorted, or `null`.
 * @throws {TypedError} `CONNECTION_ACTION_PARAM_VALIDATION` naming the unknown ids.
 */
export async function assertGrantBots(
  db: DbHandle,
  projectId: number,
  botIds: number[] | null,
): Promise<number[] | null> {
  if (botIds === null) return null;
  const ids = [...new Set(botIds)].sort((a, b) => a - b);
  const found = await db
    .select({ id: bots.id })
    .from(bots)
    .where(and(eq(bots.projectId, projectId), inArray(bots.id, ids)));
  const known = new Set(found.map((b) => b.id));
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    throw new TypedError({
      message: `No bot ${unknown.join(", ")} in this project. List the project's bots with bot:list.`,
      type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
      key: "botIds",
    });
  }
  return ids;
}

/**
 * Prove the installation can see a repository before a grant names it: mint a
 * `metadata: read` token for that one repository and revoke it at once.
 * GitHub answers a repository the installation was not granted with a 422,
 * which becomes a sentence saying where to fix it.
 * @param installation - The attached installation.
 * @param name - The repository's name (without the owner).
 * @throws {TypedError} `CONNECTION_ACTION_PARAM_VALIDATION` when it cannot.
 */
export async function probeRepositoryAccess(
  installation: GithubInstallation,
  name: string,
): Promise<void> {
  const app = appForInstallation(installation);
  if (!app) {
    throw new TypedError({
      message:
        "This deployment's GitHub App is not configured, so the repository cannot be checked. Ask an operator to set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY.",
      type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
      key: "githubInstallationId",
    });
  }
  let token: string;
  try {
    ({ token } = await mintInstallationToken(app, {
      repositories: [name],
      permissions: { metadata: "read" },
    }));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const status = /: (\d{3})\b/.exec(message)?.[1];
    throw new TypedError({
      message:
        status === "422"
          ? `The GitHub App's installation on ${installation.accountLogin} cannot see ${installation.accountLogin}/${name}. Add the repository to the App's installation on GitHub (the organization's settings → GitHub Apps → Configure → Repository access), then grant it again.`
          : `GitHub would not confirm the installation on ${installation.accountLogin} can see ${name}${status ? ` (${status})` : ""}. Try again, or check the App's installation on GitHub.`,
      type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
      key: "repository",
    });
  }
  await revokeInstallationToken(token);
}
