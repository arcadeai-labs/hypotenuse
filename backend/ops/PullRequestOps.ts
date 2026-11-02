import { and, eq, sql } from "drizzle-orm";
import { api, config } from "keryx";
// Type-only, purely for the `declare module "keryx"` augmentation inside.
import type {} from "../config/github";
import type { Conversation } from "../schema/conversations";
import { sandboxJobEvents } from "../schema/sandbox_job_events";
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
import { grantForBot, jobPermissionFor } from "./GitCredentialOps";
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
 * | Way in | Caller | When it is not recorded |
 * |---|---|---|
 * | the agent submits it, `sandbox:submit-artifact { name: "pull_request", content: <url> }` | the coding agent | refused with a sentence it can act on; the artifact is still stored |
 * | the supervisor's transcript carries it — the result of a `gh pr create` call (paired with its call by Claude Code's `tool_use_id`, or Codex's `command` on the result), a line that is only a pull request URL | `sandbox:events` | skipped silently |
 *
 * A URL proves nothing — `gh pr view`, `gh pr list`, and `cat` print pull
 * request URLs too, and a job may simply type one. So a pull request is
 * recorded only when **GitHub confirms the job could have opened it**:
 *
 * 1. The URL names a repository the bot is granted, **and the job holds
 *    write on it** (`jobPermissionFor`: a push grant, and the job was started
 *    in `write` mode on that very repository). Only such a job's credential
 *    carries `pull_requests: write`, so no other job can have opened it.
 * 2. Already recorded for this job: nothing happens. Recorded for another
 *    job: refused — a pull request stays with the job that opened it.
 * 3. Outside any transaction, GitHub's REST API is read
 *    (`GET /repos/:owner/:name/pulls/:number`) with a token minted for that
 *    one repository at `pull_requests: read`, revoked after. The pull
 *    request must exist, be **authored by the App's bot user**
 *    (`<config.github.appSlug>[bot]`, which is who a sandbox's `gh` acts
 *    as), have **its head on the granted repository** (not a fork), and —
 *    when the grant names a branch prefix — **a head branch under it**.
 *    GitHub unreachable, or an App slug not configured, is a refusal: an
 *    unconfirmed pull request is never recorded.
 * 4. In one transaction, lock the conversation, then the job (the one lock
 *    order), and insert the row `ON CONFLICT DO NOTHING`. Only the insert
 *    that wins relays:
 *    - a transcript `status_change` naming the job and the pull request;
 *    - a `link` surface row, label "Pull Request", the title as its text —
 *      a Slack message, a Linear session's `externalUrls`, a Pylon note;
 *    - a quiet inbox `system` message to the bot (title and branch fenced,
 *      `answers: false`): it waits for the turn's boundary, wakes nobody,
 *      and never answers a question;
 *    - `relayedAt` stamped.
 * 5. After commit, the relay's owed delivery and ping (`afterRelay`).
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

/** One transcript event, as the supervisor posts it. */
interface TranscriptEvent {
  type: string;
  toolName?: string;
  text?: string;
  payload?: unknown;
}

/**
 * Read a property of an unknown value.
 * @param v - The value.
 * @param key - The property.
 * @returns It, or `undefined`.
 */
function prop(v: unknown, key: string): unknown {
  return v && typeof v === "object"
    ? (v as Record<string, unknown>)[key]
    : undefined;
}

/**
 * Whether a shell command creates a pull request: `gh pr create` as one of
 * its commands.
 * @param command - The command line.
 * @returns `true` for `gh pr create …`, alone or chained.
 */
export function createsPullRequest(command: unknown): boolean {
  return (
    typeof command === "string" &&
    /(^|[\s;&|(`])gh\s+pr\s+create(\s|$)/.test(command)
  );
}

/**
 * The tool results in a batch that are the output of a `gh pr create` call.
 * A result is paired with its call the way the CLI records it: Claude Code's
 * `tool_result` block names its `tool_use_id`, the `id` of a `tool_use` block
 * in this batch or an earlier one (read from `sandbox_job_events`); Codex's
 * `command_execution` result carries its own `command`. A result that cannot
 * be paired is not one: transcript detection is the fallback, and the
 * agent's `pull_request` artifact is the way in that always works.
 * @param jobId - The job, whose stored events hold earlier calls.
 * @param events - The batch.
 * @returns The texts of the results of `gh pr create` calls.
 */
export async function pullRequestCreateResults(
  jobId: number,
  events: TranscriptEvent[],
): Promise<string[]> {
  const results = events.filter(
    (e) => e.type === "tool_result" && e.text && /\/pull\/\d/.test(e.text),
  );
  if (results.length === 0) return [];
  const out: string[] = [];
  for (const e of results) {
    const text = String(e.text);
    const ownCommand = prop(prop(e.payload, "item"), "command");
    if (createsPullRequest(ownCommand)) {
      out.push(text);
      continue;
    }
    const useId = prop(e.payload, "tool_use_id");
    if (typeof useId !== "string" || !useId) continue;
    const inBatch = events.find(
      (u) => u.type === "tool_use" && prop(u.payload, "id") === useId,
    );
    let input = inBatch ? prop(inBatch.payload, "input") : undefined;
    if (!inBatch) {
      const [stored] = await api.db.db
        .select({ payload: sandboxJobEvents.payload })
        .from(sandboxJobEvents)
        .where(
          and(
            eq(sandboxJobEvents.jobId, jobId),
            eq(sandboxJobEvents.kind, "tool_use"),
            sql`${sandboxJobEvents.payload}->>'id' = ${useId}`,
          ),
        )
        .limit(1);
      input = prop(stored?.payload, "input");
    }
    if (createsPullRequest(prop(input, "command"))) out.push(text);
  }
  return out;
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

/** What GitHub said about a pull request, or why it could not be read. */
type PullRequestRead =
  | {
      ok: true;
      title: string | null;
      headRef: string | null;
      author: string;
      headRepository: string;
    }
  | { ok: false; reason: string };

/**
 * Read a pull request from GitHub: a token for the one repository at
 * `pull_requests: read`, revoked after. Anything short of a 200 with a
 * pull request in it is a refusal, with a sentence.
 * @param installation - The attached installation the grant reaches it through.
 * @param pr - The pull request.
 * @returns What GitHub said, or why it could not be read.
 */
async function readPullRequest(
  installation: Parameters<typeof appForInstallation>[0],
  pr: ParsedPullRequest,
): Promise<PullRequestRead> {
  const unreachable = {
    ok: false as const,
    reason: `GitHub could not be asked about ${pullRequestName(pr)}, so it was not recorded. Submit it again in a moment.`,
  };
  const app = appForInstallation(installation);
  if (!app) return unreachable;
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
    if (res.status === 404) {
      return {
        ok: false,
        reason: `GitHub has no pull request ${pullRequestName(pr)}, so it was not recorded. Submit the URL gh pr create printed.`,
      };
    }
    if (res.status !== 200 || !res.body || typeof res.body !== "object") {
      return unreachable;
    }
    const body = res.body as {
      title?: unknown;
      user?: { login?: unknown };
      head?: { ref?: unknown; repo?: { full_name?: unknown } | null };
    };
    return {
      ok: true,
      title: typeof body.title === "string" ? body.title.slice(0, 500) : null,
      headRef:
        typeof body.head?.ref === "string" ? body.head.ref.slice(0, 255) : null,
      author: typeof body.user?.login === "string" ? body.user.login : "",
      headRepository:
        typeof body.head?.repo?.full_name === "string"
          ? body.head.repo.full_name
          : "",
    };
  } catch (e) {
    api.logger.warn("could not read a pull request from GitHub", {
      pullRequest: pr.url,
      error: e instanceof Error ? e.message : String(e),
    });
    return unreachable;
  } finally {
    if (token) await revokeInstallationToken(token);
  }
}

/**
 * The login GitHub gives the App's bot user, which a sandbox's `gh` acts as.
 * @returns `<appSlug>[bot]`, lowercased, or `null` when no slug is configured.
 */
export function appBotLogin(): string | null {
  const slug = String(config.github.appSlug ?? "")
    .trim()
    .toLowerCase();
  return slug ? `${slug}[bot]` : null;
}

/**
 * Whether what GitHub said about a pull request shows this job opened it:
 * the App's bot authored it, its head is on the granted repository, and its
 * branch is under the grant's prefix when the grant names one.
 * @param pr - The pull request.
 * @param read - What GitHub said.
 * @param branchPrefix - The grant's configured branch prefix, if any.
 * @returns `null` when it checks out, otherwise the sentence why not.
 */
function confirmOpenedByJob(
  pr: ParsedPullRequest,
  read: Extract<PullRequestRead, { ok: true }>,
  branchPrefix: string | null,
): string | null {
  const name = pullRequestName(pr);
  const bot = appBotLogin();
  if (!bot) {
    return `The GitHub App's slug is not configured, so who opened ${name} cannot be confirmed; it was not recorded.`;
  }
  if (read.author.toLowerCase() !== bot) {
    return `${name} was opened by ${read.author || "someone else"}, not by this job (${bot}), so it was not recorded. Submit only a pull request your job opened with gh pr create.`;
  }
  if (read.headRepository.toLowerCase() !== `${pr.owner}/${pr.name}`) {
    return `${name}'s branch is not on ${pr.owner}/${pr.name}, so it was not recorded. Push your branch to ${pr.owner}/${pr.name} and open the pull request from it.`;
  }
  const prefix = branchPrefix?.trim();
  if (prefix && !read.headRef?.startsWith(prefix)) {
    return `${name}'s branch is not under ${prefix}, the branch prefix this repository's grant names, so it was not recorded. Push a branch under ${prefix} and open the pull request from it.`;
  }
  return null;
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
      `${jobLabel(job)} opened pull request ${name}: ${pr.url}.`,
      pr.title || pr.headRef
        ? `Its ${pr.title && pr.headRef ? "title and branch" : pr.title ? "title" : "branch"}:\n${fenced(
            [
              pr.title ? `Title: ${pr.title}` : "",
              pr.headRef ? `Branch: ${pr.headRef}` : "",
            ]
              .filter(Boolean)
              .join("\n"),
          )}`
        : "",
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
  job: Pick<
    SandboxJob,
    "id" | "projectId" | "botId" | "parentConversationId" | "repository"
  >,
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
  // Only a job holding write on the repository can have opened a pull
  // request there: no other job's credential carries `pull_requests: write`.
  if (
    jobPermissionFor(job, grant.grant.push, {
      owner: parsed.owner,
      repo: parsed.name,
    }) !== "write"
  ) {
    return {
      recorded: false,
      reason: `This job was not started to change ${parsed.owner}/${parsed.name}, so it cannot have opened ${pullRequestName(parsed)}; it was not recorded.`,
    };
  }
  const existing = await existingPullRequest(api.db.db, job.projectId, parsed);
  if (existing) {
    if (existing.jobId === job.id) {
      return { recorded: true, pullRequest: existing, created: false };
    }
    return {
      recorded: false,
      reason: `${pullRequestName(parsed)} is already recorded for another sandbox job, so it was not recorded for this one.`,
    };
  }

  const details = await readPullRequest(grant.installation, parsed);
  if (!details.ok) return { recorded: false, reason: details.reason };
  const refused = confirmOpenedByJob(parsed, details, grant.grant.branchPrefix);
  if (refused) return { recorded: false, reason: refused };

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
  if (winner?.jobId === job.id) {
    return { recorded: true, pullRequest: winner, created: false };
  }
  if (winner) {
    return {
      recorded: false,
      reason: `${pullRequestName(parsed)} is already recorded for another sandbox job, so it was not recorded for this one.`,
    };
  }
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
