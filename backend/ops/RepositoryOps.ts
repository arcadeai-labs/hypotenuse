import { and, eq, isNull } from "drizzle-orm";
import type { GithubInstallation } from "../schema/github_installations";
import { githubInstallations } from "../schema/github_installations";
import {
  type RepositoryGrant,
  repositoryGrants,
} from "../schema/repository_grants";
import type { SandboxJobGitToken } from "../schema/sandbox_job_git_tokens";
import type { SandboxJobPullRequest } from "../schema/sandbox_job_pull_requests";
import type { DbHandle } from "./DbOps";
import { grantCoversBot, recommendedRuleset } from "./GitAccessOps";

/**
 * Repositories as people and bots see them: attached GitHub App
 * installations, the grants a project admin made, a job's git handouts, and
 * the pull requests its jobs opened. Every serializer here is the only shape
 * those rows leave the server in, and none has a field a token fits in.
 */

/**
 * Shape an attached installation for any answer.
 * @param i - The row.
 * @returns The serialized installation.
 */
export function serializeGithubInstallation(i: GithubInstallation) {
  return {
    id: i.id,
    projectId: i.projectId,
    installationId: i.installationId,
    accountLogin: i.accountLogin,
    accountType: i.accountType,
    permissions: i.permissions,
    attachedByUserId: i.attachedByUserId,
    status: i.revokedAt ? "removed" : i.suspendedAt ? "suspended" : "active",
    suspendedAt: i.suspendedAt?.getTime() ?? null,
    revokedAt: i.revokedAt?.getTime() ?? null,
    createdAt: i.createdAt.getTime(),
    updatedAt: i.updatedAt.getTime(),
  };
}

/**
 * Shape a grant for any answer, with the ruleset that would enforce its
 * branch prefix.
 * @param g - The row.
 * @param installation - The installation it is reached through, if read.
 * @returns The serialized grant.
 */
export function serializeRepositoryGrant(
  g: RepositoryGrant,
  installation?: Pick<GithubInstallation, "accountLogin"> | null,
) {
  const prefix = g.branchPrefix?.trim() || null;
  return {
    id: g.id,
    projectId: g.projectId,
    githubInstallationId: g.githubInstallationId,
    accountLogin: installation?.accountLogin ?? null,
    host: g.host,
    owner: g.owner,
    name: g.name,
    fullName: `${g.owner}/${g.name}`,
    push: g.push,
    branchPrefix: prefix,
    botIds: g.botIds,
    allBots: g.botIds === null,
    recommendedRuleset: prefix ? recommendedRuleset(prefix) : null,
    createdByUserId: g.createdByUserId,
    createdAt: g.createdAt.getTime(),
    updatedAt: g.updatedAt.getTime(),
  };
}

/**
 * Shape a git handout for any answer. The token's hash stays in the row.
 * @param t - The row.
 * @returns The serialized handout.
 */
export function serializeGitHandout(t: SandboxJobGitToken) {
  return {
    id: t.id,
    jobId: t.jobId,
    repository: t.repository,
    permission: t.permission,
    outcome: t.outcome,
    reason: t.reason,
    expiresAt: t.expiresAt?.getTime() ?? null,
    revokedAt: t.revokedAt?.getTime() ?? null,
    createdAt: t.createdAt.getTime(),
  };
}

/**
 * Shape a pull request a job opened for any answer.
 * @param p - The row.
 * @returns The serialized pull request.
 */
export function serializePullRequest(p: SandboxJobPullRequest) {
  return {
    id: p.id,
    jobId: p.jobId,
    conversationId: p.conversationId,
    repository: `${p.owner}/${p.name}`,
    number: p.number,
    url: p.url,
    title: p.title,
    headRef: p.headRef,
    state: p.state,
    relayedAt: p.relayedAt?.getTime() ?? null,
    createdAt: p.createdAt.getTime(),
    updatedAt: p.updatedAt.getTime(),
  };
}

/** One repository a bot may reach, as the bot page and the read tools see it. */
export interface BotRepository {
  grantId: number;
  host: string;
  owner: string;
  name: string;
  fullName: string;
  access: "read" | "write";
  branchPrefix: string | null;
}

/**
 * Every repository a bot may reach in its project, through installations
 * that are still attached and usable, sorted by name.
 * @param db - A database handle.
 * @param projectId - The project.
 * @param botId - The bot.
 * @returns The repositories.
 */
export async function botRepositories(
  db: DbHandle,
  projectId: number,
  botId: number,
): Promise<BotRepository[]> {
  const rows = await db
    .select({ grant: repositoryGrants })
    .from(repositoryGrants)
    .innerJoin(
      githubInstallations,
      eq(githubInstallations.id, repositoryGrants.githubInstallationId),
    )
    .where(
      and(
        eq(repositoryGrants.projectId, projectId),
        isNull(githubInstallations.revokedAt),
        isNull(githubInstallations.suspendedAt),
      ),
    );
  return rows
    .map((r) => r.grant)
    .filter((g) => grantCoversBot(g, botId))
    .map((g) => ({
      grantId: g.id,
      host: g.host,
      owner: g.owner,
      name: g.name,
      fullName: `${g.owner}/${g.name}`,
      access: g.push ? ("write" as const) : ("read" as const),
      branchPrefix: g.branchPrefix?.trim() || null,
    }))
    .sort((a, b) => a.fullName.localeCompare(b.fullName));
}
