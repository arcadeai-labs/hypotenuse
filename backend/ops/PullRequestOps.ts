import { and, eq } from "drizzle-orm";
import { api } from "keryx";
// Type-only, purely for the `declare module "keryx"` augmentation inside.
import type {} from "../config/github";
import type { Conversation } from "../schema/conversations";
import {
  type SandboxJobPullRequest,
  sandboxJobPullRequests,
} from "../schema/sandbox_job_pull_requests";
import type { SandboxJob } from "../schema/sandbox_jobs";
import {
  lockConversation,
  receiveMessage,
  statusChange,
} from "./ConversationOps";
import type { DbHandle } from "./DbOps";
import { GITHUB_HOST } from "./GitAccessOps";
import { grantForBot } from "./GitCredentialOps";
import {
  appForInstallation,
  githubRest,
  githubWebOrigin,
  mintInstallationToken,
  revokeInstallationToken,
} from "./GitHubAppOps";
import { afterRelay, lockJob } from "./SandboxJobOps";
import { fenced, jobLabel, type RelayResult } from "./SandboxRelayOps";
import { emit } from "./SurfaceOps";
import { appendEntries } from "./TranscriptOps";

/**
 * **Pull requests a sandbox job opened**: recognizing one, recording it
 * against the job, and relaying it to the conversation that asked for the
 * work. Two ways in, one way through:
 *
 * | Way in | Caller | On a URL that is not a pull request, or a repository the bot is not granted |
 * |---|---|---|
 * | the agent submits it, `sandbox:submit-artifact { name: "pull_request", content: <url> }` | the coding agent | refused with a sentence it can act on; the artifact is still stored |
 * | the supervisor's transcript carries it — a tool result with a line that is only a pull request URL, which is what `gh pr create` prints | `sandbox:events` | skipped silently |
 *
 * Recording, once a URL names a granted repository:
 *
 * 1. If the pull request is already recorded (for this or an earlier job),
 *    nothing happens: a pull request stays with the job that first opened it.
 * 2. Outside any transaction, read its title and head branch from GitHub's
 *    REST API with a token minted for that one repository at
 *    `pull_requests: read`, then revoke the token. **Best effort**: GitHub
 *    being down never fails the record; the title is then unknown.
 * 3. In one transaction, lock the conversation, then the job (the one lock
 *    order), and insert the row `ON CONFLICT DO NOTHING`. Only the insert
 *    that wins relays:
 *    - a transcript `status_change` naming the job and the pull request;
 *    - a `link` surface row, label "Pull Request", the title as its text —
 *      a Slack message, a Linear session's `externalUrls`, a Pylon note;
 *    - a quiet inbox `system` message to the bot (fenced, `answers: false`):
 *      it reads it at its next step, and it wakes nobody;
 *    - `relayedAt` stamped.
 * 4. After commit, the relay's owed delivery and ping (`afterRelay`).
 *
 * A conversation a person disengaged (`ended`, `cancelled`) gets the row and
 * the transcript entry, and nothing on its surface.
 */

/** The artifact name that records a pull request. */
export const PULL_REQUEST_ARTIFACT = "pull_request";

/** The label a pull request's link carries on every surface. */
export const PULL_REQUEST_LABEL = "Pull Request";

/** A pull request URL, parsed. */
export interface ParsedPullRequest {
  host: string;
  owner: string;
  name: string;
  number: number;
  /** The canonical URL: `<origin>/<owner>/<name>/pull/<number>`. */
  url: string;
}

/** An owner (user or organization) as GitHub allows one. */
const OWNER = "[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})";
/** A repository name as GitHub allows one. */
const REPO = "[A-Za-z0-9._-]{1,100}";

/**
 * Escape a string for use inside a regular expression.
 * @param s - The string.
 * @returns It, escaped.
 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The web origins a pull request URL may start with: the configured one
 * (a GitHub fake under test) and github.com's own forms.
 * @returns Origins, no trailing slash.
 */
function pullRequestOrigins(): string[] {
  const configured = githubWebOrigin().replace(/\/+$/, "");
  return [
    ...new Set([configured, "https://github.com", "https://www.github.com"]),
  ];
}

/**
 * The pattern of a pull request URL on any accepted origin.
 * @param flags - Regular expression flags.
 * @returns The pattern; group 1 is the origin, 2 the owner, 3 the name, 4 the number.
 */
function pullRequestPattern(flags = ""): RegExp {
  const origins = pullRequestOrigins().map(escapeRegExp).join("|");
  return new RegExp(
    `(${origins})/(${OWNER})/(${REPO})/pull/([1-9][0-9]{0,9})(?=$|[/?#\\s)\\]>"'.,])`,
    `i${flags}`,
  );
}

/**
 * Parse a pull request URL: `<web origin>/<owner>/<name>/pull/<number>`,
 * with the configured web origin or `https://github.com`, optionally
 * followed by a sub-page (`/files`), a query, or a fragment.
 * @param url - The URL.
 * @returns The pull request, or `null` for anything else.
 */
export function parsePullRequestUrl(url: string): ParsedPullRequest | null {
  const trimmed = url.trim();
  const match = new RegExp(
    `^${pullRequestPattern().source}(?:/[A-Za-z0-9/_-]*)?(?:[?#]\\S*)?$`,
    "i",
  ).exec(trimmed);
  if (!match) return null;
  const [, origin, owner, name, number] = match;
  if (name === "." || name === "..") return null;
  return {
    host: GITHUB_HOST,
    owner: owner.toLowerCase(),
    name: name.toLowerCase(),
    number: Number(number),
    url: `${origin}/${owner}/${name}/pull/${number}`,
  };
}

/**
 * The pull request URLs a sandbox transcript event announces: lines that are
 * nothing but a pull request URL, which is what `gh pr create` prints. A URL
 * inside prose (a file that links an old pull request) is not one.
 * @param text - The event's text.
 * @returns The pull requests, deduplicated, in order.
 */
export function announcedPullRequests(text: string): ParsedPullRequest[] {
  if (!text || !/\/pull\/\d/.test(text)) return [];
  const out = new Map<string, ParsedPullRequest>();
  for (const line of text.split(/\r?\n/)) {
    const parsed = parsePullRequestUrl(line);
    if (parsed) out.set(parsed.url.toLowerCase(), parsed);
  }
  return [...out.values()];
}

/** What recording a pull request did. */
export type RecordOutcome =
  | { recorded: true; pullRequest: SandboxJobPullRequest; created: boolean }
  | { recorded: false; reason: string };

/**
 * An existing row for a pull request in a project.
 * @param db - A database handle.
 * @param projectId - The project.
 * @param pr - The pull request.
 * @returns The row, or `undefined`.
 */
async function existingPullRequest(
  db: DbHandle,
  projectId: number,
  pr: ParsedPullRequest,
): Promise<SandboxJobPullRequest | undefined> {
  const [row] = await db
    .select()
    .from(sandboxJobPullRequests)
    .where(
      and(
        eq(sandboxJobPullRequests.projectId, projectId),
        eq(sandboxJobPullRequests.host, pr.host),
        eq(sandboxJobPullRequests.owner, pr.owner),
        eq(sandboxJobPullRequests.name, pr.name),
        eq(sandboxJobPullRequests.number, pr.number),
      ),
    )
    .limit(1);
  return row;
}

/**
 * Read a pull request's title and head branch from GitHub, best effort: a
 * token for the one repository at `pull_requests: read`, revoked after.
 * @param installation - The attached installation the grant reaches it through.
 * @param pr - The pull request.
 * @returns What GitHub said, or empty fields.
 */
async function readPullRequest(
  installation: Parameters<typeof appForInstallation>[0],
  pr: ParsedPullRequest,
): Promise<{ title: string | null; headRef: string | null }> {
  const none = { title: null, headRef: null };
  const app = appForInstallation(installation);
  if (!app) return none;
  let token: string | null = null;
  try {
    const minted = await mintInstallationToken(app, {
      repositories: [pr.name],
      permissions: { metadata: "read", pull_requests: "read" },
    });
    token = minted.token;
    const res = await githubRest(
      token,
      `/repos/${encodeURIComponent(pr.owner)}/${encodeURIComponent(pr.name)}/pulls/${pr.number}`,
    );
    if (res.status !== 200 || !res.body || typeof res.body !== "object") {
      return none;
    }
    const body = res.body as { title?: unknown; head?: { ref?: unknown } };
    return {
      title: typeof body.title === "string" ? body.title.slice(0, 500) : null,
      headRef:
        typeof body.head?.ref === "string" ? body.head.ref.slice(0, 255) : null,
    };
  } catch (e) {
    api.logger.warn("could not read a pull request from GitHub", {
      pullRequest: pr.url,
      error: e instanceof Error ? e.message : String(e),
    });
    return none;
  } finally {
    if (token) await revokeInstallationToken(token);
  }
}

/**
 * How a pull request is named to people and to the bot.
 * @param pr - The pull request.
 * @returns `acme/api#12`.
 */
export function pullRequestName(
  pr: Pick<SandboxJobPullRequest, "owner" | "name" | "number">,
): string {
  return `${pr.owner}/${pr.name}#${pr.number}`;
}

/**
 * Relay a newly recorded pull request to its conversation. Runs with the
 * conversation and the job locked.
 * @param tx - The transaction.
 * @param conversation - The parent, locked.
 * @param job - The job, locked.
 * @param pr - The new row.
 * @returns What the relay did.
 */
async function relayPullRequest(
  tx: DbHandle,
  conversation: Conversation,
  job: SandboxJob,
  pr: SandboxJobPullRequest,
): Promise<RelayResult> {
  const name = pullRequestName(pr);
  await appendEntries(tx, conversation.id, conversation.epoch, [
    statusChange(conversation.state, conversation.state, "pull_request", {
      text: `${jobLabel(job)} opened pull request ${name}: ${pr.url}`,
    }),
  ]);
  const disengaged =
    conversation.state === "ended" && conversation.outcome === "cancelled";
  let outboxWritten = false;
  if (!disengaged) {
    const row = await emit(tx, conversation, {
      kind: "link",
      payload: {
        label: PULL_REQUEST_LABEL,
        url: pr.url,
        text: pr.title ?? name,
        pullRequestId: pr.id,
      },
    });
    outboxWritten = Boolean(row);
  }
  await receiveMessage(tx, conversation, {
    text: [
      `${jobLabel(job)} opened pull request ${name}: ${pr.url}${pr.headRef ? ` (branch ${pr.headRef})` : ""}.`,
      pr.title ? `Its title:\n${fenced(pr.title)}` : "",
      "The link is already shown to the people here. Reviews and CI results on it will reach you in this conversation.",
    ]
      .filter(Boolean)
      .join("\n\n"),
    delivery: "queue",
    deliveryKey: `sandbox:${job.id}:pull:${pr.id}`,
    source: "system",
    // Text from a sandbox never stands in for a person's answer.
    answers: false,
    metadata: { sandboxJobId: job.id, pullRequestId: pr.id },
    // The job's ending is what wakes the bot; this waits for its next step.
    quiet: true,
  });
  await tx
    .update(sandboxJobPullRequests)
    .set({ relayedAt: new Date() })
    .where(eq(sandboxJobPullRequests.id, pr.id));
  return { woke: null, outboxWritten };
}

/**
 * **Record a pull request a job opened**, and relay it to the job's
 * conversation. See the file's table for the steps.
 * @param job - The acting job.
 * @param url - The pull request's URL.
 * @returns The row (and whether this call created it), or why it was not recorded.
 */
export async function recordJobPullRequest(
  job: Pick<SandboxJob, "id" | "projectId" | "botId" | "parentConversationId">,
  url: string,
): Promise<RecordOutcome> {
  const parsed = parsePullRequestUrl(url);
  if (!parsed) {
    return {
      recorded: false,
      reason: `"${url.slice(0, 200)}" is not a pull request URL. Submit the URL gh pr create printed, like ${githubWebOrigin()}/<owner>/<repo>/pull/<number>.`,
    };
  }
  const grant = await grantForBot(api.db.db, job.projectId, job.botId, {
    host: parsed.host,
    owner: parsed.owner,
    repo: parsed.name,
  });
  if (!grant) {
    return {
      recorded: false,
      reason: `This bot is not granted ${parsed.owner}/${parsed.name}, so the pull request was not recorded. Open pull requests only on a repository your job can reach.`,
    };
  }
  const existing = await existingPullRequest(api.db.db, job.projectId, parsed);
  if (existing)
    return { recorded: true, pullRequest: existing, created: false };

  const details = await readPullRequest(grant.installation, parsed);

  let relay: RelayResult | null = null;
  const row = await api.db.db.transaction(async (tx) => {
    // The one lock order: the conversation, then its job.
    const locked = await lockConversation(tx, job.parentConversationId);
    const lockedJob = await lockJob(tx, job.id);
    if (!lockedJob) return null;
    const [inserted] = await tx
      .insert(sandboxJobPullRequests)
      .values({
        projectId: job.projectId,
        jobId: job.id,
        conversationId: job.parentConversationId,
        host: parsed.host,
        owner: parsed.owner,
        name: parsed.name,
        number: parsed.number,
        url: parsed.url,
        title: details.title,
        headRef: details.headRef,
      })
      .onConflictDoNothing()
      .returning();
    if (!inserted) return null;
    if (locked) {
      relay = await relayPullRequest(
        tx,
        locked.conversation,
        lockedJob,
        inserted,
      );
    }
    return inserted;
  });
  await afterRelay(job, relay);
  if (row) return { recorded: true, pullRequest: row, created: true };
  const winner = await existingPullRequest(api.db.db, job.projectId, parsed);
  if (winner) return { recorded: true, pullRequest: winner, created: false };
  return { recorded: false, reason: "The job is gone." };
}

/**
 * The pull requests a job opened, oldest first.
 * @param db - A database handle.
 * @param jobId - The job.
 * @returns The rows.
 */
export async function jobPullRequests(
  db: DbHandle,
  jobId: number,
): Promise<SandboxJobPullRequest[]> {
  return db
    .select()
    .from(sandboxJobPullRequests)
    .where(eq(sandboxJobPullRequests.jobId, jobId))
    .orderBy(sandboxJobPullRequests.id);
}
