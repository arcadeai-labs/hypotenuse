import { api } from "keryx";
import { GITHUB_HOST, parseRepositoryName } from "../ops/GitAccessOps";
import { grantForBot } from "../ops/GitCredentialOps";
import {
  appForInstallation,
  githubRest,
  githubWebOrigin,
  mintInstallationToken,
  revokeInstallationToken,
} from "../ops/GitHubAppOps";
import { botRepositories } from "../ops/RepositoryOps";
import { type ToolContext, ToolError } from "./types";

/**
 * What every `github_*` read tool shares: the repository the model named,
 * resolved against **the calling bot's grants** in its own project — never
 * against what the installation can see — and a token minted for that one
 * call, scoped to that one repository at `read`, and revoked when the call
 * ends. The token never leaves the server and never outlives the call.
 */

/** The repository permission a read tool needs, beside `metadata`. */
export type GitHubReadPermission = "contents" | "pull_requests" | "issues";

/** The `repository` input every read tool takes. */
export const REPOSITORY_DESCRIPTION =
  "The repository, as `owner/name` (e.g. `acme/api`). Only repositories granted to you can be read.";

/** A repository a call resolved to. */
export interface GitHubTarget {
  owner: string;
  repo: string;
  /** `owner/name`, lowercased. */
  fullName: string;
}

/**
 * Whether the bot has at least one repository it can read in its project,
 * through an installation that is still attached and usable.
 * @param ctx - The bot and conversation.
 * @returns `true` when it does.
 */
export async function hasGitHubRepositories(
  ctx: Pick<ToolContext, "bot" | "conversation">,
): Promise<boolean> {
  const repos = await botRepositories(
    api.db.db,
    ctx.conversation.projectId,
    ctx.bot.id,
  );
  return repos.length > 0;
}

/**
 * The repositories a bot can read, as a sentence for a refusal.
 * @param ctx - The call's context.
 * @returns `acme/api, acme/web`, or a sentence saying there are none.
 */
async function readableList(ctx: ToolContext): Promise<string> {
  const repos = await botRepositories(
    ctx.db,
    ctx.conversation.projectId,
    ctx.bot.id,
  );
  return repos.length > 0
    ? `The repositories you can read: ${repos.map((r) => r.fullName).join(", ")}.`
    : "You have no repositories granted.";
}

/**
 * Resolve a repository against the bot's grants, mint a read-only token for
 * it alone, run the call with it, and revoke it afterwards — whatever the
 * call did. Revocation never throws: a token that cannot be revoked expires
 * within the hour on its own.
 * @param ctx - The call's context.
 * @param repository - `owner/name`, as the model wrote it.
 * @param permission - The repository permission the call needs.
 * @param fn - The call, given the token and the repository.
 * @returns What `fn` returned.
 * @throws {ToolError} `invalid_repository`, `not_granted`, or `github_unavailable`, or whatever `fn` throws.
 */
export async function withRepositoryToken<T>(
  ctx: ToolContext,
  repository: string,
  permission: GitHubReadPermission,
  fn: (token: string, target: GitHubTarget) => Promise<T>,
): Promise<T> {
  const parsed = parseRepositoryName(repository, githubWebOrigin());
  if (!parsed) {
    throw new ToolError(
      "invalid_repository",
      `"${repository}" is not a repository name.`,
      `Name it as owner/name. ${await readableList(ctx)}`,
    );
  }
  const target: GitHubTarget = {
    owner: parsed.owner,
    repo: parsed.repo,
    fullName: `${parsed.owner}/${parsed.repo}`,
  };
  const found = await grantForBot(
    ctx.db,
    ctx.conversation.projectId,
    ctx.bot.id,
    { host: GITHUB_HOST, owner: target.owner, repo: target.repo },
  );
  if (!found) {
    throw new ToolError(
      "not_granted",
      `You have no access to ${target.fullName}. A project admin grants repositories to bots under Repositories.`,
      `${await readableList(ctx)} Use one of those, or tell the person a project admin must grant ${target.fullName} to you under Repositories.`,
    );
  }
  const app = appForInstallation(found.installation);
  if (!app) {
    throw new ToolError(
      "github_unavailable",
      `GitHub is not available for ${target.fullName}: the project's GitHub App installation on ${found.installation.accountLogin} is suspended or removed, or this deployment's GitHub App is not configured.`,
      "Tell the person; a project admin can reattach the installation under Repositories.",
    );
  }
  let token: string;
  try {
    ({ token } = await mintInstallationToken(app, {
      repositories: [target.repo],
      permissions: { metadata: "read", [permission]: "read" },
    }));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new ToolError(
      "github_unavailable",
      `The project's GitHub installation could not be used for ${target.fullName}: ${message.slice(0, 500)}`,
      "Tell the person; a project admin should check the installation under Repositories.",
    );
  }
  try {
    return await fn(token, target);
  } finally {
    await revokeInstallationToken(token).catch(() => false);
  }
}

/**
 * GET a GitHub REST path with a call's token, turning a refusal into an error
 * the model reads: 404 is `not_found`, any other non-2xx is `github_error`
 * with GitHub's own message.
 * @param token - The call's token.
 * @param path - The path, starting `/`.
 * @param missing - What a 404 means, as a sentence.
 * @param missingHint - What to do about a 404.
 * @returns The parsed body.
 * @throws {ToolError} On any non-2xx answer.
 */
export async function githubGet<T>(
  token: string,
  path: string,
  missing: string,
  missingHint: string,
): Promise<T> {
  const { status, body } = await githubRest(token, path);
  if (status === 404) throw new ToolError("not_found", missing, missingHint);
  if (status < 200 || status >= 300) {
    const message =
      typeof body === "object" && body !== null && "message" in body
        ? String((body as { message: unknown }).message)
        : typeof body === "string"
          ? body
          : "";
    throw new ToolError(
      "github_error",
      `GitHub answered ${status}${message ? `: ${message.slice(0, 500)}` : ""}`,
      "Check the input and try again, or tell the person what you could not read.",
    );
  }
  return body as T;
}

/**
 * Encode a repository path for a URL, keeping its slashes.
 * @param path - `src/app.ts`.
 * @returns The encoded path.
 */
export function encodePath(path: string): string {
  return path
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}
