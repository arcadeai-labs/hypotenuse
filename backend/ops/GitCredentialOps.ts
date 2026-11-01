/**
 * Handing a sandbox job a GitHub credential, and taking it back when the job
 * ends. Ported from ToolExec's `GitCredentialOps`, keyed by job.
 *
 * A sandbox's git asks for a password, this mints one: a GitHub App
 * installation token scoped to the single repository git named, carrying
 * every **repository** permission the installation currently has — capped to
 * `write` only when the repository's grant allows a push *and* the job was
 * started to change that repository, otherwise `read` — plus the mandatory
 * `metadata: read`. Two bounds apply and they are not the same bound: the
 * **installation** says what is possible on GitHub, and the bot's **grants**
 * say what this job may ask for. A repository the installation can see but no
 * grant names is refused here, before GitHub is asked for anything.
 *
 * **Every token this issues is revoked when the job finishes.** GitHub's own
 * expiry is an hour; {@link revokeJobGitTokens}, called from the one funnel
 * every ending goes through, is what makes "a finished job holds no live
 * credential" true for GitHub the way revoking the job token makes it true for
 * ours. Revocation is by presenting the token itself, so the tokens are kept —
 * in Redis, keyed by job, never in Postgres, which holds only their hashes
 * (`sandbox_job_git_tokens`, the job's ledger of handouts and refusals).
 *
 * Reuse is per job and only per job. Two jobs sharing a cached token would
 * mean the first to finish revoked the second's credential mid-clone, which
 * is why `mintInstallationToken` does no caching of its own.
 */

import { createHash } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { api, ErrorType, TypedError } from "keryx";
import { githubInstallations } from "../schema/github_installations";
import { repositoryGrants } from "../schema/repository_grants";
import { sandboxJobGitTokens } from "../schema/sandbox_job_git_tokens";
import type { SandboxJob } from "../schema/sandbox_jobs";
import type { DbHandle } from "./DbOps";
import { findGrant, GITHUB_HOST, type GrantLevel } from "./GitAccessOps";
import {
  appForInstallation,
  fetchInstallationPermissions,
  githubAppFingerprint,
  INSTALLATION_TOKEN_TTL_SECONDS,
  mintInstallationToken,
  revokeInstallationToken,
} from "./GitHubAppOps";

/** How git will use the credential, which decides the permission minted. */
export type GitPermission = "read" | "write";

/** What a job was started to do with its repository. */
export interface JobRepository {
  host: string;
  owner: string;
  name: string;
  ref?: string | null;
  mode: "read" | "write";
}

/**
 * The repository a job was started on, as `sandbox_start` wrote it.
 * @param job - The job.
 * @returns The repository, or `null` for a job started without one.
 */
export function jobRepository(
  job: Pick<SandboxJob, "repository">,
): JobRepository | null {
  const r = job.repository as Partial<JobRepository> | null;
  if (!r || typeof r.owner !== "string" || typeof r.name !== "string") {
    return null;
  }
  return {
    host: typeof r.host === "string" ? r.host : GITHUB_HOST,
    owner: r.owner,
    name: r.name,
    ref: typeof r.ref === "string" ? r.ref : null,
    mode: r.mode === "write" ? "write" : "read",
  };
}

/**
 * Permissions asked of GitHub when the installation's own map could not be
 * read: `contents`, `issues`, and `pull_requests` at the grant's level, so a
 * pushable checkout can also open pull requests with `gh`, `checks: read` so
 * a job can read its CI, and the mandatory `metadata: read`.
 * @param permission - `write` when the job may push, otherwise `read`.
 * @returns The permission map passed to `mintInstallationToken`.
 */
export function sandboxInstallationPermissions(
  permission: GitPermission,
): Record<string, string> {
  return {
    contents: permission,
    metadata: "read",
    issues: permission,
    pull_requests: permission,
    checks: "read",
  };
}

/**
 * GitHub App permissions that attach to an account or organization, not a
 * repository. Requesting them on a mint would give the sandbox those APIs even
 * when `repositories` names one repo.
 */
const ORGANIZATION_GITHUB_PERMISSIONS = new Set([
  "members",
  "team_discussions",
]);

/**
 * Permissions GitHub only offers at `write`. Asking for `read` on a read-only
 * grant 422s the mint, so they are omitted instead of capped.
 */
const WRITE_ONLY_GITHUB_PERMISSIONS = new Set(["workflows"]);

/**
 * Permissions a sandbox never holds above `read`, whatever its grant:
 * `checks` (a job reads its CI; it does not write check runs), and the
 * repository's own administration and secrets.
 */
const READ_CAPPED_GITHUB_PERMISSIONS = new Set(["checks", "statuses"]);

/** Repository permissions a sandbox is never handed at all. */
const NEVER_GITHUB_PERMISSIONS = new Set([
  "administration",
  "secrets",
  "environments",
  "workflows",
]);

/**
 * Whether a GitHub App permission is organization- or account-scoped.
 * @param name - GitHub's permission key.
 * @returns `true` when it must not appear on a per-repository sandbox token.
 */
export function isOrganizationGitHubPermission(name: string): boolean {
  return (
    name.startsWith("organization") || ORGANIZATION_GITHUB_PERMISSIONS.has(name)
  );
}

/**
 * Cap one installation permission to what this job may hold.
 * @param name - GitHub's permission key.
 * @param installed - The level the installation currently has.
 * @param grant - `write` when the job may push, otherwise `read`.
 * @returns The level to request, or `null` to omit the permission.
 */
export function capSandboxGitHubPermission(
  name: string,
  installed: string,
  grant: GitPermission,
): string | null {
  const installedLevel = installed.trim().toLowerCase();
  if (installedLevel === "") return null;
  if (name === "metadata") return "read";
  if (NEVER_GITHUB_PERMISSIONS.has(name)) return null;

  if (grant === "read" || READ_CAPPED_GITHUB_PERMISSIONS.has(name)) {
    if (WRITE_ONLY_GITHUB_PERMISSIONS.has(name)) return null;
    return "read";
  }

  if (installedLevel === "admin" || installedLevel === "write") return "write";
  if (installedLevel === "read") return "read";
  return null;
}

/**
 * Permissions asked of GitHub for one sandbox repository credential, taken
 * from the installation's live map: every repository permission the App was
 * granted, at `read` or `write` matching the job, never above what the
 * installation has. Organization permissions are dropped so the
 * `repositories` scope remains the bound. `metadata: read` is always present.
 * @param permission - `write` when the job may push, otherwise `read`.
 * @param installed - `permissions` from `GET /app/installations/{id}`.
 * @returns The permission map passed to `mintInstallationToken`.
 */
export function installationSandboxPermissions(
  permission: GitPermission,
  installed: Record<string, string>,
): Record<string, string> {
  const permissions: Record<string, string> = {};
  for (const [name, level] of Object.entries(installed)) {
    if (isOrganizationGitHubPermission(name)) continue;
    const capped = capSandboxGitHubPermission(name, level, permission);
    if (capped) permissions[name] = capped;
  }
  permissions.metadata = "read";
  return permissions;
}

/** What a sandbox's credential helper is answered with. */
export interface IssuedGitCredential {
  /** GitHub's own convention for an App token over HTTPS git. */
  username: "x-access-token";
  /** The installation token. */
  password: string;
  /** When GitHub stops accepting it, in epoch milliseconds. */
  expiresAtMs: number;
  /** The repository it is good for, as `owner/repo`. */
  repository: string;
  /** The permission it carries. */
  permission: GitPermission;
}

/** A cached token, as it is stored. */
interface CachedToken {
  token: string;
  expiresAtMs: number;
}

/**
 * How long the set of a job's live tokens is kept: longer than GitHub's own
 * hour, so a job whose last token was minted moments before it ended still
 * has it in the set when the ending reads it. The set is deleted on
 * revocation; this bound only covers a process that died before getting
 * there.
 */
const TOKEN_SET_TTL_SECONDS = 90 * 60;

/**
 * The Redis key one job's reusable token for one repository lives under.
 * @param jobId - The job.
 * @param fingerprint - The App the token was minted from.
 * @param repository - `owner/repo`, lowercased by the caller.
 * @param permission - Which permission it carries.
 * @returns The key.
 */
function tokenKey(
  jobId: number,
  fingerprint: string,
  repository: string,
  permission: GitPermission,
): string {
  return `hypotenuse:job-git-token:${jobId}:${fingerprint}:${repository}:${permission}`;
}

/**
 * The Redis key holding every token a job is still responsible for revoking.
 * @param jobId - The job.
 * @returns The key.
 */
function tokenSetKey(jobId: number): string {
  return `hypotenuse:job-git-tokens:${jobId}`;
}

/**
 * The Redis key holding every cache key a job has filled. A second set
 * rather than a hash of key → token, because a token within ten minutes of
 * expiry is not reused, so one cache key can name a second token while the
 * first is still live, and a structure that overwrote by key would drop that
 * first one from the revocation set.
 * @param jobId - The job.
 * @returns The key.
 */
function tokenKeySetKey(jobId: number): string {
  return `hypotenuse:job-git-token-keys:${jobId}`;
}

/**
 * The SHA-256 of a token, the only form Postgres keeps.
 * @param token - The token.
 * @returns Hex.
 */
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Record one credential request in the job's ledger. Never throws: the
 * ledger is a record, and a failure to write it must not fail the clone.
 * @param row - What happened.
 */
async function recordHandout(row: {
  jobId: number;
  projectId: number;
  repository: string;
  outcome: "issued" | "reused" | "refused";
  permission?: GitPermission | null;
  reason?: string | null;
  token?: string | null;
  expiresAtMs?: number | null;
}): Promise<void> {
  try {
    await api.db.db.insert(sandboxJobGitTokens).values({
      jobId: row.jobId,
      projectId: row.projectId,
      repository: row.repository,
      outcome: row.outcome,
      permission: row.permission ?? null,
      reason: row.reason ?? null,
      tokenHash: row.token ? hashToken(row.token) : null,
      expiresAt: row.expiresAtMs ? new Date(row.expiresAtMs) : null,
    });
  } catch (e) {
    api.logger.warn("could not record a git credential handout", {
      jobId: row.jobId,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * The grant covering a repository for a bot, with the installation it is
 * reached through.
 * @param db - A database handle.
 * @param projectId - The project.
 * @param botId - The bot.
 * @param target - The repository.
 * @returns The grant and installation, or `null`.
 */
export async function grantForBot(
  db: DbHandle,
  projectId: number,
  botId: number,
  target: { host: string; owner: string; repo: string },
) {
  const rows = await db
    .select({ grant: repositoryGrants, installation: githubInstallations })
    .from(repositoryGrants)
    .innerJoin(
      githubInstallations,
      eq(githubInstallations.id, repositoryGrants.githubInstallationId),
    )
    .where(
      and(
        eq(repositoryGrants.projectId, projectId),
        eq(repositoryGrants.host, target.host.toLowerCase()),
        eq(repositoryGrants.owner, target.owner.toLowerCase()),
        eq(repositoryGrants.name, target.repo.toLowerCase()),
        isNull(githubInstallations.revokedAt),
      ),
    );
  const grant = findGrant(
    rows.map((r) => r.grant),
    botId,
    target,
  );
  if (!grant) return null;
  const row = rows.find((r) => r.grant.id === grant.id);
  return row ?? null;
}

/**
 * What a bot may do with a repository: `none`, `read`, or `write`. The same
 * answer drives `sandbox_start`'s check, the token's permission, and the read
 * tools.
 * @param db - A database handle.
 * @param projectId - The project.
 * @param botId - The bot.
 * @param target - The repository.
 * @returns The level.
 */
export async function botRepositoryAccess(
  db: DbHandle,
  projectId: number,
  botId: number,
  target: { host?: string; owner: string; repo: string },
): Promise<GrantLevel> {
  const found = await grantForBot(db, projectId, botId, {
    host: target.host ?? GITHUB_HOST,
    owner: target.owner,
    repo: target.repo,
  });
  if (!found) return "none";
  return found.grant.push ? "write" : "read";
}

/**
 * The permission a job's credential for a repository carries: `write` only
 * when the grant allows a push **and** the job was started in `write` mode on
 * this very repository. A job may read any repository its bot is granted (a
 * submodule, a library it depends on), and write only the one it was started
 * to change.
 * @param job - The job.
 * @param grantPush - The grant's `push`.
 * @param target - The repository asked about.
 * @returns `read` or `write`.
 */
export function jobPermissionFor(
  job: Pick<SandboxJob, "repository">,
  grantPush: boolean,
  target: { owner: string; repo: string },
): GitPermission {
  const repo = jobRepository(job);
  if (
    grantPush &&
    repo?.mode === "write" &&
    repo.owner.toLowerCase() === target.owner.toLowerCase() &&
    repo.name.toLowerCase() === target.repo.toLowerCase()
  ) {
    return "write";
  }
  return "read";
}

/**
 * Mint — or reuse — this job's credential for one repository.
 *
 * The gates, in the order they are cheapest: the bot's grants, then the
 * project's installation, then GitHub itself. A repository nobody granted
 * never reaches a mint, so a job cannot use the credential handout to
 * discover what else the installation can see.
 *
 * Refusals are `TypedError`s with a sentence a model can act on, because the
 * helper prints the answer to git's stderr — the only place a coding agent
 * finds out why a clone failed. Every request, issued or refused, is a row in
 * the job's ledger.
 * @param input - The job and the repository git named.
 * @param input.job - The acting job.
 * @param input.host - The host git is authenticating to.
 * @param input.owner - The repository's owner.
 * @param input.repo - The repository's name.
 * @returns The credential to hand back to git.
 * @throws {TypedError} 403 when the repository was not granted to the bot;
 *   502 when the project's installation cannot be used or GitHub refused.
 */
export async function issueJobGitCredential(input: {
  job: Pick<SandboxJob, "id" | "projectId" | "botId" | "repository">;
  host: string;
  owner: string;
  repo: string;
}): Promise<IssuedGitCredential> {
  const { job } = input;
  const repository = `${input.owner}/${input.repo}`;
  const refuse = async (
    reason: string,
    type: ErrorType,
    permission: GitPermission | null = null,
  ): Promise<never> => {
    await recordHandout({
      jobId: job.id,
      projectId: job.projectId,
      repository,
      outcome: "refused",
      permission,
      reason,
    });
    throw new TypedError({ message: reason, type });
  };

  const found = await grantForBot(api.db.db, job.projectId, job.botId, {
    host: input.host,
    owner: input.owner,
    repo: input.repo,
  });
  if (!found) {
    return refuse(
      `this bot has no access to ${repository}. A job reaches exactly the repositories its project granted its bot; ask a project admin to grant ${repository} under Repositories.`,
      ErrorType.CONNECTION_CHANNEL_AUTHORIZATION,
    );
  }

  const permission = jobPermissionFor(job, found.grant.push, input);
  const app = appForInstallation(found.installation);
  if (!app) {
    return refuse(
      `GitHub is not available for ${repository}: the project's GitHub App installation for ${found.installation.accountLogin} is suspended or removed, or this deployment's GitHub App is not configured. Tell the person; a project admin can reattach it under Repositories.`,
      ErrorType.CONNECTION_SERVER_ERROR,
      permission,
    );
  }

  const fingerprint = githubAppFingerprint(app);
  const key = tokenKey(
    job.id,
    fingerprint,
    repository.toLowerCase(),
    permission,
  );

  const cached = await readCachedToken(key);
  if (cached) {
    await recordHandout({
      jobId: job.id,
      projectId: job.projectId,
      repository,
      outcome: "reused",
      permission,
    });
    return {
      username: "x-access-token",
      password: cached.token,
      expiresAtMs: cached.expiresAtMs,
      repository,
      permission,
    };
  }

  let minted: Awaited<ReturnType<typeof mintInstallationToken>>;
  try {
    const installed = await fetchInstallationPermissions(app);
    const permissions = installed
      ? installationSandboxPermissions(permission, installed)
      : sandboxInstallationPermissions(permission);
    minted = await mintInstallationToken(app, {
      // GitHub scopes to the installation's own account, so the owner is not
      // part of the name here. A grant whose owner is not that account is
      // refused by GitHub rather than silently widened.
      repositories: [input.repo],
      permissions,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    api.logger.warn("could not mint a GitHub installation token", {
      jobId: job.id,
      repository,
      error: message,
    });
    return refuse(
      `this project's GitHub installation could not be used for ${repository}: ${message}`,
      ErrorType.CONNECTION_SERVER_ERROR,
      permission,
    );
  }

  await rememberToken(job.id, key, minted);
  await recordHandout({
    jobId: job.id,
    projectId: job.projectId,
    repository,
    outcome: "issued",
    permission,
    token: minted.token,
    expiresAtMs: minted.expiresAtMs,
  });

  return {
    username: "x-access-token",
    password: minted.token,
    expiresAtMs: minted.expiresAtMs,
    repository,
    permission,
  };
}

/**
 * Read a job's cached token, ignoring one too close to expiry: a token handed
 * out with five minutes left is one a slow clone can lose halfway through.
 * @param key - The cache key.
 * @returns The token, or `null`.
 */
async function readCachedToken(key: string): Promise<CachedToken | null> {
  const raw = await api.redis.redis.get(key);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as CachedToken;
    if (typeof parsed.token !== "string") return null;
    if (parsed.expiresAtMs - Date.now() < 10 * 60 * 1000) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Cache a minted token for this job, and add it to the job's revocation set.
 * @param jobId - The job.
 * @param key - The cache key.
 * @param minted - The token and its expiry.
 */
async function rememberToken(
  jobId: number,
  key: string,
  minted: { token: string; expiresAtMs: number },
): Promise<void> {
  const payload: CachedToken = {
    token: minted.token,
    expiresAtMs: minted.expiresAtMs,
  };
  await api.redis.redis.set(
    key,
    JSON.stringify(payload),
    "EX",
    INSTALLATION_TOKEN_TTL_SECONDS,
  );
  await api.redis.redis.sadd(tokenSetKey(jobId), minted.token);
  await api.redis.redis.expire(tokenSetKey(jobId), TOKEN_SET_TTL_SECONDS);
  await api.redis.redis.sadd(tokenKeySetKey(jobId), key);
  await api.redis.redis.expire(tokenKeySetKey(jobId), TOKEN_SET_TTL_SECONDS);
}

/**
 * Hand every token this job was issued back to GitHub, and stamp the ledger.
 *
 * Called after `finalizeSandboxJob` commits, beside revoking the job token
 * and for the same reason: a finished job holds no live credential. A token
 * that cannot be revoked — GitHub unreachable, the App key rotated — expires
 * on its own inside the hour, so this never throws and never blocks a job
 * from finishing.
 * @param jobId - The job that just reached a terminal state.
 * @returns How many tokens were issued and how many GitHub confirmed revoked.
 */
export async function revokeJobGitTokens(
  jobId: number,
): Promise<{ issued: number; revoked: number }> {
  try {
    const key = tokenSetKey(jobId);
    const tokens = await api.redis.redis.smembers(key);
    if (tokens.length === 0) return { issued: 0, revoked: 0 };

    let revoked = 0;
    for (const token of tokens) {
      if (await revokeInstallationToken(token)) revoked += 1;
    }
    await api.db.db
      .update(sandboxJobGitTokens)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(sandboxJobGitTokens.jobId, jobId),
          eq(sandboxJobGitTokens.outcome, "issued"),
          isNull(sandboxJobGitTokens.revokedAt),
        ),
      );

    // The cached entries go with them: a key naming a token GitHub has
    // already rejected should not outlive the call that rejected it.
    const cacheKeys = await api.redis.redis.smembers(tokenKeySetKey(jobId));
    await api.redis.redis.del(key, tokenKeySetKey(jobId), ...cacheKeys);

    api.logger.info("revoked a sandbox job's GitHub credentials", {
      jobId,
      issued: tokens.length,
      revoked,
    });
    return { issued: tokens.length, revoked };
  } catch (e) {
    api.logger.warn("could not revoke a sandbox job's GitHub credentials", {
      jobId,
      error: e instanceof Error ? e.message : String(e),
    });
    return { issued: 0, revoked: 0 };
  }
}

/** What any GitHub installation or user token looks like. */
const GITHUB_TOKEN_PATTERN = /\b(gh[supor]_[A-Za-z0-9_]{20,})\b/g;

/**
 * Remove every GitHub token from what a sandbox sends — its events, status,
 * artifacts — before it is stored or relayed. A token is handed to one git or
 * `gh` process, but an agent can still print one.
 * @param value - A string, or anything JSON-shaped holding strings.
 * @returns The same shape with each token replaced.
 */
export function redactGitHubTokens<T>(value: T): T {
  if (typeof value === "string") {
    return value.replace(
      GITHUB_TOKEN_PATTERN,
      (t) => `${t.slice(0, 4)}[redacted]`,
    ) as T;
  }
  if (Array.isArray(value)) return value.map(redactGitHubTokens) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, redactGitHubTokens(v)]),
    ) as T;
  }
  return value;
}
