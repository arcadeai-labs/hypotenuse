import {
  type Action,
  type ActionParams,
  ErrorType,
  HTTP_METHOD,
  TypedError,
} from "keryx";
import { z } from "zod";
import {
  actingJob,
  type JobConnection,
  JobTokenMiddleware,
  JobTokenRateLimitMiddleware,
} from "../../middleware/jobToken";
import { GITHUB_HOST, parseCredentialRepository } from "../../ops/GitAccessOps";
import { issueJobGitCredential } from "../../ops/GitCredentialOps";
import { jobTokenInput } from "../../ops/SandboxInputOps";

/**
 * `sandbox:git-credential` — the password a sandbox's git is answered with.
 *
 * Git speaks to GitHub itself; what it lacks is a way in. When it needs one
 * it runs the credential helper provisioning wrote, which presents the **job
 * token** here and is handed back a GitHub App installation token scoped to
 * the one repository it asked about — at `write` only when the bot's grant
 * allows a push and the job was started to change that repository. Every
 * token is revoked when the job ends (`finalizeSandboxJob`).
 *
 * **Not an MCP tool, for anyone — not even a job's own MCP session.** Git
 * gets a credential by running a helper over HTTP; nothing advertises "give
 * me a GitHub token" to a model, and a job token presented on a person's
 * session cannot reach it either.
 *
 * **Unaudited**: machine traffic with no human decision in it, firing several
 * times per clone. `sandbox_job_git_tokens` is its record — one row per
 * handout or refusal, with the repository, the permission, and the reason —
 * shown as the job's git handouts. The audited decision is upstream: the
 * repository grant a project admin made.
 *
 * **The response is the one place a GitHub token crosses**, and it never
 * reaches a log: Keryx logs an action's params (with `secret` fields
 * redacted) and never its response, and the refusals carry no token.
 *
 * **A `GET` that mints**, because git is looking a credential up for a
 * repository the job was already granted; nothing a person owns changes.
 */
export class SandboxGitCredential implements Action {
  name = "sandbox:git-credential";
  description =
    "Issue this sandbox job's git credential for one granted repository. Called by git's credential helper and the managed gh inside a sandbox, with the job token; not for people, and not an agent tool.";
  mcp = { tool: false };
  middleware = [JobTokenMiddleware, JobTokenRateLimitMiddleware];
  web = { route: "/sandbox/git-credential", method: HTTP_METHOD.GET };
  inputs = z.object({
    token: jobTokenInput,
    repository: z
      .string()
      .max(300)
      .describe(
        "The repository git is authenticating to, as `owner/repo` or `owner/repo.git` — the `path` git sends its credential helper",
      ),
    host: z
      .string()
      .max(255)
      .default(GITHUB_HOST)
      .describe("The host git is authenticating to"),
  });

  /**
   * @param params - The repository git named, and its host.
   * @param connection - The connection {@link JobTokenMiddleware} resolved a job on.
   * @returns `{ credential }`: username, password, expiry, repository, permission.
   * @throws {TypedError} 406 when the value is not a repository; 403 when the
   *   bot holds no grant for it; 502 when GitHub could not be asked.
   */
  async run(
    params: ActionParams<SandboxGitCredential>,
    connection: JobConnection,
  ) {
    const job = actingJob(connection);
    const parsed = parseCredentialRepository(params.repository);
    if (!parsed) {
      throw new TypedError({
        message: `"${params.repository}" is not a repository. Git asks for a credential per repository, as owner/repo.`,
        type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
      });
    }
    const credential = await issueJobGitCredential({
      job,
      host: params.host,
      owner: parsed.owner,
      repo: parsed.repo,
    });
    return { credential };
  }
}
