import type { BotRepositories } from "@backend/actions/bot/bot-repositories";
import type { GithubInstallUrl } from "@backend/actions/github/github-install-url";
import type { GithubInstallationList } from "@backend/actions/github/github-installation-list";
import type { RepositoryGrantList } from "@backend/actions/repository-grant/repository-grant-list";
import type { ActionResponse } from "keryx";
import type { Bot } from "../components/bots/data";
import type { SandboxJobDetail } from "./sandboxJobs";

/** An attached GitHub App installation, as `github:installation-list` serializes it. */
export type GithubInstallation =
  ActionResponse<GithubInstallationList>["installations"][number];

/** A repository grant, as `repository-grant:list` serializes it. */
export type RepositoryGrant =
  ActionResponse<RepositoryGrantList>["repositoryGrants"][number];

/** `github:install-url`'s answer. */
export type InstallUrl = ActionResponse<GithubInstallUrl>;

/** One repository a bot may reach, as `bot:repositories` lists it. */
export type BotRepository =
  ActionResponse<BotRepositories>["repositories"][number];

/** One git credential a sandbox job asked for. */
export type GitHandout = SandboxJobDetail["gitHandouts"][number];

/** One pull request a sandbox job opened. */
export type JobPullRequest = SandboxJobDetail["pullRequests"][number];

/** One event on a pull request that can wake a bot. */
export type GithubWakeEvent = Bot["githubWakeEvents"][number];

/**
 * The pull-request events a bot can be woken by, in the server's order, with
 * the words the bot page shows for each.
 */
export const GITHUB_WAKE_EVENTS = [
  { value: "changes_requested", label: "A review requests changes" },
  { value: "approved", label: "A review approves it" },
  { value: "commented", label: "A review comments on it" },
  { value: "review_comment", label: "A comment on a line of its diff" },
  { value: "check_failed", label: "A check fails" },
  { value: "check_passed", label: "Its checks pass" },
  { value: "closed", label: "It is closed without merging" },
  { value: "merged", label: "It is merged" },
] as const satisfies readonly { value: GithubWakeEvent; label: string }[];

/** What a new bot wakes for. */
export const DEFAULT_WAKE_EVENTS: readonly GithubWakeEvent[] = [
  "changes_requested",
  "check_failed",
];

/**
 * Put chosen wake events in the server's order, without repeats.
 * @param chosen - The events, in any order.
 * @returns Them, ordered as {@link GITHUB_WAKE_EVENTS}.
 */
export function orderWakeEvents(
  chosen: Iterable<GithubWakeEvent>,
): GithubWakeEvent[] {
  const set = new Set(chosen);
  return GITHUB_WAKE_EVENTS.map((e) => e.value).filter((v) => set.has(v));
}

/**
 * Whether two sets of wake events are the same, regardless of order.
 * @param a - One set.
 * @param b - The other.
 * @returns Whether they hold the same events.
 */
export function sameWakeEvents(
  a: readonly GithubWakeEvent[],
  b: readonly GithubWakeEvent[],
): boolean {
  return orderWakeEvents(a).join(",") === orderWakeEvents(b).join(",");
}

/** The branch prefix a grant falls back to, as the form's placeholder shows it. */
export const BRANCH_PREFIX_PLACEHOLDER = "hypotenuse/<bot-slug>/";

/** The badge tone an installation's status takes. */
export const INSTALLATION_STATUS_TONE: Record<string, string> = {
  active: "success",
  suspended: "warning",
  removed: "secondary",
};

/**
 * An installation's status in words.
 * @param status - `active`, `suspended`, or `removed`.
 * @returns The words.
 */
export function installationStatusLabel(status: string): string {
  switch (status) {
    case "active":
      return "Active";
    case "suspended":
      return "Suspended on GitHub";
    case "removed":
      return "Removed from GitHub";
    default:
      return status;
  }
}

/**
 * What a grant lets a bot do, in words.
 * @param push - Whether the grant allows pushes.
 * @returns `"Read"` or `"Read and push"`.
 */
export function grantAccessWords(push: boolean): string {
  return push ? "Read and push" : "Read";
}

/**
 * Which bots a grant covers, in words.
 * @param grant - The grant's `allBots` and `botIds`.
 * @param names - Bot names by id, for the bots the reader can see.
 * @returns "Every bot", or the bots' names.
 */
export function grantBotsWords(
  grant: Pick<RepositoryGrant, "allBots" | "botIds">,
  names: ReadonlyMap<number, string>,
): string {
  if (grant.allBots || !grant.botIds) return "Every bot";
  const known = grant.botIds.map((id) => names.get(id) ?? `Bot #${id}`);
  return known.join(", ");
}

/**
 * The recommended ruleset as the JSON a person pastes into GitHub.
 * @param grant - The grant.
 * @returns Indented JSON, or `null` when the grant has no branch prefix.
 */
export function rulesetJson(
  grant: Pick<RepositoryGrant, "recommendedRuleset">,
): string | null {
  return grant.recommendedRuleset
    ? JSON.stringify(grant.recommendedRuleset, null, 2)
    : null;
}

/**
 * Where a repository lives on the web.
 * @param fullName - `owner/name`.
 * @param host - The git host; GitHub unless said otherwise.
 * @returns The repository's URL.
 */
export function repositoryUrl(fullName: string, host = "github.com"): string {
  return `https://${host}/${fullName}`;
}

/**
 * A git handout's outcome in words.
 * @param outcome - `issued`, `reused`, or `refused`.
 * @returns The words.
 */
export function handoutOutcomeLabel(outcome: string): string {
  switch (outcome) {
    case "issued":
      return "Issued";
    case "reused":
      return "Reused";
    case "refused":
      return "Refused";
    default:
      return outcome;
  }
}

/** The badge tone each handout outcome takes. */
export const HANDOUT_OUTCOME_TONE: Record<string, string> = {
  issued: "info",
  reused: "secondary",
  refused: "danger",
};

/**
 * A pull request's state in words.
 * @param state - `open`, `closed`, or `merged`.
 * @returns The words.
 */
export function pullRequestStateLabel(state: string): string {
  switch (state) {
    case "open":
      return "Open";
    case "closed":
      return "Closed";
    case "merged":
      return "Merged";
    default:
      return state;
  }
}

/** The badge tone each pull-request state takes. */
export const PULL_REQUEST_STATE_TONE: Record<string, string> = {
  open: "success",
  merged: "info",
  closed: "secondary",
};

/** A sandbox job's repository, as the job records it. */
export interface JobRepository {
  host: string;
  owner: string;
  name: string;
  ref: string | null;
  mode: "read" | "write";
}

/**
 * Read a job's `repository`, which the server stores as JSON.
 * @param raw - The job's `repository` field.
 * @returns The repository, or `null` for a job on none (or one this cannot read).
 */
export function jobRepository(raw: unknown): JobRepository | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.owner !== "string" || typeof r.name !== "string") return null;
  return {
    host: typeof r.host === "string" && r.host ? r.host : "github.com",
    owner: r.owner,
    name: r.name,
    ref: typeof r.ref === "string" && r.ref ? r.ref : null,
    mode: r.mode === "read" ? "read" : "write",
  };
}

/**
 * A job's repository line: `owner/name`, and the ref when one was named.
 * @param repository - The job's repository, or `null`.
 * @returns The words, or `null` for a job on no repository.
 */
export function jobRepositoryWords(
  repository: JobRepository | null,
): string | null {
  if (!repository) return null;
  const ref = repository.ref ? ` at ${repository.ref}` : "";
  return `${repository.owner}/${repository.name}${ref}`;
}

/**
 * A job's mode in words.
 * @param mode - `read` or `write`.
 * @returns The words.
 */
export function jobModeWords(mode: string): string {
  return mode === "write" ? "Write" : "Read only";
}

/**
 * What a job's mode lets it do, for the mode's tooltip.
 * @param mode - `read` or `write`.
 * @returns The sentence.
 */
export function jobModeDetail(mode: string): string {
  return mode === "write"
    ? "May push a branch under its prefix and open a pull request."
    : "May read and run the code; pushes nothing.";
}

/**
 * What the Repositories page says on arrival from GitHub's install flow.
 * @param search - The page's query string.
 * @returns A notice and its tone, or `null` when there is nothing to say.
 */
export function installNotice(
  search: URLSearchParams,
): { tone: "success" | "danger"; text: string } | null {
  const error = search.get("error");
  if (error) return { tone: "danger", text: error };
  if (search.get("installed")) {
    return {
      tone: "success",
      text: "The GitHub App is attached. Grant its repositories to your bots below.",
    };
  }
  return null;
}

/** The grant form, as typed. */
export interface GrantDraft {
  /** The installation's id, as the picker holds it; `""` for none chosen. */
  installationId: string;
  repository: string;
  push: boolean;
  branchPrefix: string;
  /** `true` for every bot in the project. */
  allBots: boolean;
  botIds: number[];
}

/** An empty grant form. */
export const EMPTY_GRANT_DRAFT: GrantDraft = {
  installationId: "",
  repository: "",
  push: false,
  branchPrefix: "",
  allBots: true,
  botIds: [],
};

/**
 * A grant as the form shows it, for editing.
 * @param grant - The grant.
 * @returns The draft.
 */
export function grantDraftOf(grant: RepositoryGrant): GrantDraft {
  return {
    installationId: String(grant.githubInstallationId),
    repository: grant.fullName,
    push: grant.push,
    branchPrefix: grant.branchPrefix ?? "",
    allBots: grant.allBots,
    botIds: grant.botIds ?? [],
  };
}

/**
 * Normalize what someone typed as a repository: `owner/name`, or its GitHub
 * URL, to `owner/name`. The server decides; this catches the obvious slip
 * before a round trip.
 * @param text - What was typed.
 * @returns `owner/name`, or `null` when it is not one.
 */
export function parseRepositoryInput(text: string): string | null {
  const trimmed = text
    .trim()
    .replace(/^https?:\/\/(www\.)?github\.com\//i, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");
  return /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/.test(trimmed)
    ? trimmed
    : null;
}

/** The body `repository-grant:create` takes. */
export interface GrantCreateBody {
  githubInstallationId: number;
  repository: string;
  push: boolean;
  branchPrefix: string | null;
  botIds: number[] | null;
}

/**
 * Check a new grant's form and turn it into `repository-grant:create`'s body.
 * @param draft - The form.
 * @returns The body, or the sentence that says what to fix.
 */
export function grantCreateBody(draft: GrantDraft): GrantCreateBody | string {
  const installation = Number(draft.installationId);
  if (!draft.installationId || !Number.isInteger(installation)) {
    return "Choose the installation the repository is reached through.";
  }
  const repository = parseRepositoryInput(draft.repository);
  if (!repository) {
    return "Write the repository as owner/name, e.g. acme/api.";
  }
  if (!draft.allBots && draft.botIds.length === 0) {
    return "Choose at least one bot, or grant it to every bot.";
  }
  return {
    githubInstallationId: installation,
    repository,
    push: draft.push,
    branchPrefix: draft.branchPrefix.trim() || null,
    botIds: draft.allBots ? null : [...draft.botIds].sort((a, b) => a - b),
  };
}

/** The body `repository-grant:edit` takes: only what changed. */
export interface GrantEditBody {
  push?: boolean;
  branchPrefix?: string | null;
  botIds?: number[] | null;
}

/**
 * Compare an edited grant with the saved one and keep only what changed.
 * @param grant - The saved grant.
 * @param draft - The form.
 * @returns The fields to send (possibly none), or the sentence that says what to fix.
 */
export function grantEditBody(
  grant: RepositoryGrant,
  draft: GrantDraft,
): GrantEditBody | string {
  if (!draft.allBots && draft.botIds.length === 0) {
    return "Choose at least one bot, or grant it to every bot.";
  }
  const body: GrantEditBody = {};
  if (draft.push !== grant.push) body.push = draft.push;
  const prefix = draft.branchPrefix.trim() || null;
  if (prefix !== (grant.branchPrefix ?? null)) body.branchPrefix = prefix;
  const bots = draft.allBots ? null : [...draft.botIds].sort((a, b) => a - b);
  const saved = grant.allBots
    ? null
    : [...(grant.botIds ?? [])].sort((a, b) => a - b);
  if (JSON.stringify(bots) !== JSON.stringify(saved)) body.botIds = bots;
  return body;
}

/**
 * Find the pull-request link in a transcript line the server wrote when a
 * job opened one: `<job> opened pull request <owner/name#n>: <url>`.
 * @param text - The `status_change` entry's text.
 * @returns The pull request's name and URL, or `null` when the text holds none.
 */
export function pullRequestFromText(
  text: string,
): { name: string; url: string } | null {
  const match = text.match(
    /opened pull request (\S+): (https?:\/\/\S+?)[.,)]?$/,
  );
  if (!match?.[1] || !match[2]) return null;
  return { name: match[1], url: match[2] };
}
