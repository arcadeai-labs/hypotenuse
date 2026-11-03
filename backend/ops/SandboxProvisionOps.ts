import { readFileSync } from "node:fs";
import { join } from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import { api, config } from "keryx";
// Type-only, purely for the `declare module "keryx"` augmentation inside.
import type {} from "../config/sandbox";
import {
  assertSandboxProviderAllowed,
  canNarrowEgress,
} from "../sandbox/registry";
import type { Sandbox } from "../sandbox/types";
import { type Bot, bots } from "../schema/bots";
import { channels } from "../schema/channels";
import type { Conversation } from "../schema/conversations";
import { modelAliases } from "../schema/model_aliases";
import { modelConnections } from "../schema/model_connections";
import { participants } from "../schema/participants";
import { type SandboxJob, sandboxJobs } from "../schema/sandbox_jobs";
import { users } from "../schema/users";
import type { DbHandle } from "./DbOps";
import {
  branchPrefixFor,
  GIT_CREDENTIAL_HELPER_FILENAME,
  GITHUB_CLI_REAL_PATH,
  GITHUB_CLI_WRAPPER_FILENAME,
  gitCredentialHelperScript,
  gitCredentialUrl,
  githubCliWrapperScript,
  gitRefProblem,
  gitSandboxConfigCommands,
  persistGithubCliPathScript,
} from "./GitAccessOps";
import {
  grantForBot,
  type JobRepository,
  jobRepository,
} from "./GitCredentialOps";
import { githubWebOrigin, installationUnavailableReason } from "./GitHubAppOps";
import { botServers } from "./McpCatalogOps";
import {
  effectiveSandboxSettings,
  getOrCreateSettings,
} from "./ProjectSettingsOps";
import {
  finalizeSandboxJob,
  generateJobToken,
  loadJob,
  parentOf,
  redactJobTokens,
  registerJobToken,
  revokeJobToken,
} from "./SandboxJobOps";
import { provisionSandbox } from "./SandboxOps";

/**
 * **Provisioning**: everything a job's sandbox is given, built from rows and
 * config — and never a credential beyond the job token. The briefing, the MCP
 * config (every server is ours: `hypotenuse` at `/mcp`, each of the bot's
 * shared servers through the gateway proxy, all authenticated by
 * `${HYPOTENUSE_JOB_TOKEN}`, a reference the CLI expands at run time, never
 * a value on disk), the coding CLI's settings — Claude Code for a bot on an
 * Anthropic model, Codex for one on an OpenAI model — the supervisor's
 * files, the environment, and — for a job started on a repository — git's credential
 * helper, the managed `gh`, and the clone, none of which holds a GitHub token.
 */

/** The sandbox's working directory. */
export const SANDBOX_CWD = "/work";

/** Where everything Hypotenuse writes into a sandbox lives. */
export const CONTROL_DIR = `${SANDBOX_CWD}/.hypotenuse`;

/** Every path the provisioner writes. */
export const SANDBOX_PATHS = {
  prompt: `${CONTROL_DIR}/prompt.md`,
  mcpConfig: `${CONTROL_DIR}/mcp.json`,
  settings: `${CONTROL_DIR}/settings.json`,
  codexHome: `${CONTROL_DIR}/codex`,
  codexConfig: `${CONTROL_DIR}/codex/config.toml`,
  runnerDir: `${CONTROL_DIR}/runner`,
  runner: `${CONTROL_DIR}/runner/runner.ts`,
  log: `${CONTROL_DIR}/supervisor.log`,
  binDir: `${CONTROL_DIR}/bin`,
  gitCredentialHelper: `${CONTROL_DIR}/bin/${GIT_CREDENTIAL_HELPER_FILENAME}`,
  githubCli: `${CONTROL_DIR}/bin/${GITHUB_CLI_WRAPPER_FILENAME}`,
} as const;

/** The environment variable that carries the job token. */
export const JOB_TOKEN_ENV = "HYPOTENUSE_JOB_TOKEN";

/** The supervisor's source files, copied into every sandbox. */
const RUNNER_FILES = ["runner.ts", "parser.ts", "batcher.ts", "usage.ts"];

/**
 * The base URL a sandbox reaches this server on: `SANDBOX_API_URL` when set,
 * else the web server's own URL, with a loopback host rewritten to
 * `host.docker.internal` for `docker` (whose containers add that host) —
 * unless they join the host's network, where loopback is the host's.
 * @param provider - The job's provider.
 * @returns The base URL, without a trailing slash.
 */
export function resolveSandboxApiUrl(provider: string): string {
  if (config.sandbox.apiUrl) return config.sandbox.apiUrl.replace(/\/+$/, "");
  const web = api.servers.servers.find((s) => s.name === "web") as
    | { url?: string }
    | undefined;
  const base = (web?.url || config.server.web.applicationUrl).replace(
    /\/+$/,
    "",
  );
  // On the host's network, loopback is the host's own.
  if (provider !== "docker" || config.sandbox.dockerNetwork === "host") {
    return base;
  }
  try {
    const url = new URL(base);
    if (
      ["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"].includes(
        url.hostname,
      )
    ) {
      url.hostname = "host.docker.internal";
    }
    return url.toString().replace(/\/+$/, "");
  } catch {
    return base;
  }
}

/** The coding CLI a job runs, chosen by the provider of the bot's model. */
export type CodingAgent = "claude_code" | "codex";

/** The model providers a coding CLI speaks to, through the model proxy. */
export type CodingProvider = "anthropic" | "openai";

/** Which coding CLI speaks each provider's API. */
export const CODING_AGENT_FOR: Record<CodingProvider, CodingAgent> = {
  anthropic: "claude_code",
  openai: "codex",
};

/** The model a job's coding CLI is told to use, its small one, and whose API they speak. */
export interface JobModels {
  /** The provider of the bot's main model; the model proxy forwards only its API. */
  provider: CodingProvider;
  /** The coding CLI that speaks that API: Claude Code for Anthropic, Codex for OpenAI. */
  agent: CodingAgent;
  model: string;
  /** The fast model, when it is on the same provider; `null` otherwise. */
  fastModel: string | null;
}

/**
 * The models a bot's coding agent speaks to: its `modelAlias`, on an
 * Anthropic connection (Claude Code runs) or an OpenAI one (Codex runs), and
 * its `fastModelAlias` when that is on the same provider — a CLI speaks one
 * API, and the model proxy forwards only that one.
 * @param db - A database handle.
 * @param bot - The bot.
 * @returns The provider and model ids, or `null` when the bot's main model is
 *   on neither an Anthropic nor an OpenAI connection.
 */
export async function jobModels(
  db: DbHandle,
  bot: Pick<Bot, "projectId" | "modelAlias" | "fastModelAlias">,
): Promise<JobModels | null> {
  const resolve = async (alias: string) => {
    const [row] = await db
      .select({
        modelId: modelAliases.modelId,
        provider: modelConnections.provider,
      })
      .from(modelAliases)
      .innerJoin(
        modelConnections,
        eq(modelConnections.id, modelAliases.connectionId),
      )
      .where(
        and(
          eq(modelAliases.projectId, bot.projectId),
          eq(modelAliases.name, alias),
          eq(modelAliases.kind, "language"),
        ),
      )
      .limit(1);
    if (!row || !Object.hasOwn(CODING_AGENT_FOR, row.provider)) return null;
    return { modelId: row.modelId, provider: row.provider as CodingProvider };
  };
  const main = await resolve(bot.modelAlias);
  if (!main) return null;
  const fast = await resolve(bot.fastModelAlias);
  return {
    provider: main.provider,
    agent: CODING_AGENT_FOR[main.provider],
    model: main.modelId,
    fastModel: fast?.provider === main.provider ? fast.modelId : null,
  };
}

/**
 * The sentence a job fails with (and `sandbox_start` refuses with) when the
 * bot's model is on a provider no coding CLI here speaks.
 * @param botName - The bot's name, or `null` to address the bot itself.
 * @param alias - The bot's `modelAlias`.
 * @returns The sentence.
 */
export function unsupportedCodingModel(
  botName: string | null,
  alias: string,
): string {
  const whose = botName ? `${botName}'s` : "your";
  return `A coding agent runs on an Anthropic model (Claude Code) or an OpenAI model (Codex), and ${whose} "${alias}" model is on neither kind of connection.`;
}

/** One MCP server entry in the sandbox's config. */
export interface SandboxMcpServer {
  name: string;
  url: string;
}

/**
 * The MCP servers a job's agent sees: Hypotenuse's own sandbox tools, then
 * each enabled shared server the bot is bound to, through the gateway proxy.
 * @param db - A database handle.
 * @param bot - The bot.
 * @param apiUrl - The base URL the sandbox reaches us on.
 * @returns The servers.
 */
export async function collectMcpServers(
  db: DbHandle,
  bot: Pick<Bot, "id">,
  apiUrl: string,
): Promise<SandboxMcpServer[]> {
  const servers: SandboxMcpServer[] = [
    { name: "hypotenuse", url: `${apiUrl}/mcp` },
  ];
  for (const { server } of await botServers(db, bot.id)) {
    servers.push({
      name: server.name,
      url: `${apiUrl}/api/proxy/mcp/${server.id}`,
    });
  }
  return servers;
}

/**
 * Claude Code's `--mcp-config` file. Every header is a `${VAR}` reference the
 * CLI expands from its environment, so the file on disk holds no secret.
 * @param servers - The servers.
 * @returns The file's contents.
 */
export function buildMcpConfig(servers: SandboxMcpServer[]): string {
  const mcpServers: Record<string, unknown> = {};
  for (const s of servers) {
    mcpServers[s.name] = {
      type: "http",
      url: s.url,
      headers: { Authorization: `Bearer \${${JOB_TOKEN_ENV}}` },
    };
  }
  return `${JSON.stringify({ mcpServers }, null, 2)}\n`;
}

/**
 * Claude Code's settings: no WebFetch preflight (it calls the model host
 * directly, whatever `ANTHROPIC_BASE_URL` says) and no telemetry.
 * @returns The file's contents.
 */
export function buildClaudeSettings(): string {
  return `${JSON.stringify({ skipWebFetchPreflight: true, permissions: { defaultMode: "bypassPermissions" } }, null, 2)}\n`;
}

/**
 * A TOML basic string: quoted, with backslashes, quotes, and control
 * characters escaped.
 * @param value - The text.
 * @returns The literal.
 */
function tomlString(value: string): string {
  return JSON.stringify(value);
}

/**
 * A TOML table key: bare when it can be, quoted otherwise.
 * @param key - The key.
 * @returns The key as written.
 */
function tomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : tomlString(key);
}

/** The id Codex's config gives the model proxy as its model provider. */
export const CODEX_PROVIDER_ID = "hypotenuse";

/**
 * Codex's `$CODEX_HOME/config.toml`: the model proxy as its only model
 * provider and every MCP server ours. The job token is named, never written:
 * `env_key` and `bearer_token_env_var` tell Codex which variable to read, so
 * the file on disk holds no secret. Approvals and Codex's own sandbox are off
 * (the container is the sandbox, and nobody is there to approve); updates,
 * analytics, and feedback are off.
 * @param input - What it points at.
 * @param input.apiUrl - The URL the sandbox reaches this API at.
 * @param input.models - The job's models.
 * @param input.servers - The MCP servers.
 * @returns The file's contents.
 */
export function buildCodexConfig(input: {
  apiUrl: string;
  models: JobModels;
  servers: SandboxMcpServer[];
}): string {
  const lines = [
    `model = ${tomlString(input.models.model)}`,
    `model_provider = ${tomlString(CODEX_PROVIDER_ID)}`,
    `approval_policy = "never"`,
    `sandbox_mode = "danger-full-access"`,
    "check_for_update_on_startup = false",
    "",
    "[analytics]",
    "enabled = false",
    "",
    "[feedback]",
    "enabled = false",
    "",
    `[model_providers.${CODEX_PROVIDER_ID}]`,
    `name = "Hypotenuse"`,
    `base_url = ${tomlString(`${input.apiUrl}/api/proxy/model/openai/v1`)}`,
    `env_key = ${tomlString(JOB_TOKEN_ENV)}`,
    `wire_api = "responses"`,
  ];
  for (const s of input.servers) {
    lines.push(
      "",
      `[mcp_servers.${tomlKey(s.name)}]`,
      `url = ${tomlString(s.url)}`,
      `bearer_token_env_var = ${tomlString(JOB_TOKEN_ENV)}`,
      // A server that cannot start fails the run rather than leaving the
      // agent silently without its tools.
      "required = true",
    );
  }
  return `${lines.join("\n")}\n`;
}

/**
 * The files a job's coding CLI is configured with.
 * @param input - What they point at.
 * @param input.apiUrl - The URL the sandbox reaches this API at.
 * @param input.models - The job's models, which choose the CLI.
 * @param input.servers - The MCP servers.
 * @returns The writes.
 */
export function agentConfigFiles(input: {
  apiUrl: string;
  models: JobModels;
  servers: SandboxMcpServer[];
}): { path: string; content: string }[] {
  if (input.models.agent === "codex") {
    return [
      { path: SANDBOX_PATHS.codexConfig, content: buildCodexConfig(input) },
    ];
  }
  return [
    { path: SANDBOX_PATHS.mcpConfig, content: buildMcpConfig(input.servers) },
    { path: SANDBOX_PATHS.settings, content: buildClaudeSettings() },
  ];
}

/** What the briefing says about a job's repository. */
export interface BriefingRepository {
  /** `owner/name`. */
  fullName: string;
  /** Where it is checked out. */
  dir: string;
  /** The ref checked out, when the job named one. */
  ref: string | null;
  /** Whether the job may push. */
  mode: "read" | "write";
  /** The branch namespace it pushes into. */
  branchPrefix: string;
  /** Who commits are authored as, `Name <email>`. */
  identity: string;
  /** The requester, `Name <email>`, when they are a linked user with an email. */
  coAuthor: string | null;
  /** Where repositories are cloned from. */
  webOrigin: string;
}

/** What the briefing names, read from the conversation's rows. */
export interface BriefingContext {
  botName: string;
  platform: string;
  channel: string;
  requester: string;
  servers: string[];
  /** The job's repository, for a job started with one. */
  repository?: BriefingRepository | null;
}

/**
 * Who asked and where, for the briefing.
 * @param db - A database handle.
 * @param job - The job.
 * @param conversation - Its conversation.
 * @param bot - Its bot.
 * @param servers - The shared servers the agent will see.
 * @returns The briefing's context.
 */
export async function briefingContext(
  db: DbHandle,
  job: SandboxJob,
  conversation: Conversation,
  bot: Bot,
  servers: SandboxMcpServer[],
): Promise<BriefingContext> {
  const [channel] = await db
    .select()
    .from(channels)
    .where(eq(channels.id, conversation.channelId))
    .limit(1);
  let requester = "Someone on the team";
  if (job.triggeredByParticipantId) {
    const [p] = await db
      .select()
      .from(participants)
      .where(eq(participants.id, job.triggeredByParticipantId))
      .limit(1);
    if (p?.displayName) requester = p.displayName;
  } else if (job.triggeredByUserId) {
    const [u] = await db
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, job.triggeredByUserId))
      .limit(1);
    if (u?.name) requester = u.name;
  }
  return {
    botName: bot.displayName,
    platform: channel?.type ?? "api",
    channel: channel?.name ?? "a conversation",
    requester,
    servers: servers.filter((s) => s.name !== "hypotenuse").map((s) => s.name),
  };
}

/**
 * Render the briefing the agent reads before its task, from
 * `sandbox/briefing.md`. Recorded on the job, so what the agent saw is
 * inspectable.
 * @param job - The job.
 * @param ctx - Who, where, and which servers.
 * @returns The prompt.
 */
export function renderBriefing(
  job: Pick<SandboxJob, "title" | "task">,
  ctx: BriefingContext,
): string {
  const template = readFileSync(
    join(import.meta.dir, "..", "sandbox", "briefing.md"),
    "utf8",
  );
  const servers =
    ctx.servers.length > 0
      ? `- The team's shared MCP servers are here too: ${ctx.servers.map((s) => `\`${s}\``).join(", ")}. Only the tools this bot may use without asking are listed.`
      : "";
  const values: Record<string, string> = {
    botName: ctx.botName,
    platform: ctx.platform,
    channel: ctx.channel,
    requester: ctx.requester,
    title: job.title,
    task: job.task,
    servers,
    repository: ctx.repository ? repositorySection(ctx.repository) : "",
    cwd: ctx.repository?.dir ?? SANDBOX_CWD,
  };
  return template
    .replace(/\{\{(\w+)\}\}/g, (_, key: string) => values[key] ?? "")
    .replace(/\n{3,}/g, "\n\n");
}

/**
 * The briefing's repository section: what is checked out where, whether the
 * job may push, the branch convention, and how a pull request is opened and
 * reported. Plain lines, so `renderBriefing`'s placeholders stay simple.
 * @param r - The repository.
 * @returns The section, in markdown.
 */
export function repositorySection(r: BriefingRepository): string {
  const lines = [
    "## The repository",
    "",
    `\`${r.fullName}\` is cloned at \`${r.dir}\`${r.ref ? ` with \`${r.ref}\` checked out` : ""}; it is your working directory.`,
    "",
  ];
  if (r.mode === "write") {
    lines.push(
      `- You may push to it. Work on a new branch under \`${r.branchPrefix}\` (for example \`${r.branchPrefix}fix-flaky-test\`) and push it with \`git push -u origin <branch>\`. Never push to the default branch or to a branch you did not create.`,
      `- To open a pull request, run \`gh pr create --repo ${r.fullName} --head <branch> --title "…" --body "…"\`, saying what changed and why. Then report it with \`sandbox-submit-artifact\`, the name \`pull_request\`, and the pull request's URL as the content. People review and merge it; you do not merge.`,
      `- Your commits are authored as ${r.identity}.${r.coAuthor ? ` End every commit message with a blank line and \`Co-authored-by: ${r.coAuthor}\`.` : ""}`,
    );
  } else {
    lines.push(
      "- This checkout is read-only: read it, run it, and answer. Do not commit or push; a push is refused.",
    );
  }
  lines.push(
    `- \`git\` and \`gh\` authenticate by themselves, one command at a time, for the repositories this bot was granted; there is no token to find or set, and no \`gh auth login\`. Outside a checkout, pass \`gh\` a \`--repo owner/name\`. Another granted repository clones from \`${r.webOrigin}/<owner>/<name>.git\`, read-only.`,
  );
  return lines.join("\n");
}

/**
 * Where a job's repository is checked out: `/work/<name>`, except for a name
 * that would land on the control directory or outside a directory of its own
 * (`.hypotenuse`, `.`, `..` — GitHub allows the first), which clones into
 * `/work/repo` instead. A clone into the control directory would put the
 * repository's files beside the prompt, the supervisor, and the credential
 * helper — files the repository could then overwrite.
 * @param repo - The job's repository.
 * @returns The directory, under the sandbox's working directory.
 */
export function repositoryDir(repo: Pick<JobRepository, "name">): string {
  const reserved = new Set([".", "..", CONTROL_DIR.split("/").pop()]);
  const name = reserved.has(repo.name.toLowerCase()) ? "repo" : repo.name;
  return `${SANDBOX_CWD}/${name}`;
}

/**
 * Who a job's commits are authored as: the bot, by name, at an address that
 * is nobody's mailbox.
 * @param bot - The bot.
 * @returns The git `user.name` and `user.email`.
 */
export function gitIdentity(bot: Pick<Bot, "displayName" | "slug">): {
  name: string;
  email: string;
} {
  return {
    name: `${bot.displayName} (Hypotenuse)`,
    email: `${bot.slug}@users.noreply.hypotenuse`,
  };
}

/**
 * The egress a sandbox is narrowed to, for a provider that can hold one to a
 * list — **only for a job on a repository**, where repository content is the
 * untrusted input and must not coexist with open egress. A job without one
 * keeps the provider's default egress (`null`), so it can still reach a
 * package registry or whatever its task needs.
 * @param apiUrl - The URL the sandbox reaches this API at.
 * @param hasRepository - Whether the job was started on a repository.
 * @param github - GitHub's origins; `config.github` by default.
 * @param github.webUrl - Where git clones from.
 * @param github.apiUrl - Where `gh` calls the REST API.
 * @returns `setEgress`'s argument, or `null` to leave egress alone.
 */
export function sandboxEgressPolicy(
  apiUrl: string,
  hasRepository: boolean,
  github: { webUrl: string; apiUrl: string } = config.github,
): { mode: "deny-all"; allowDomains: string[] } | null {
  if (!hasRepository) return null;
  return {
    mode: "deny-all",
    allowDomains: sandboxEgressHosts(apiUrl, true, github),
  };
}

/**
 * The hosts a sandbox needs once it is running, for a provider that can hold
 * it to an allowlist: this API (the model and MCP proxies, the supervisor's
 * endpoints, the credential handout) and, for a job with a repository,
 * GitHub's web and API hosts. Ports are not part of a domain allowlist.
 * @param apiUrl - The URL the sandbox reaches this API at.
 * @param hasRepository - Whether the job was started on a repository.
 * @param github - GitHub's origins; `config.github` by default.
 * @param github.webUrl - Where git clones from.
 * @param github.apiUrl - Where `gh` calls the REST API.
 * @returns The hostnames, without duplicates.
 */
export function sandboxEgressHosts(
  apiUrl: string,
  hasRepository: boolean,
  github: { webUrl: string; apiUrl: string } = config.github,
): string[] {
  const hosts = [apiUrl];
  if (hasRepository) hosts.push(github.webUrl, github.apiUrl);
  const names: string[] = [];
  for (const origin of hosts) {
    try {
      const host = new URL(origin).hostname;
      if (host && !names.includes(host)) names.push(host);
    } catch {
      // Not a URL: nothing to allow.
    }
  }
  return names;
}

/**
 * The hosts a sandbox reaches while its runtime is installed, on top of the
 * running set: the npm registry (bun and the coding CLI) and GitHub's release
 * hosts (the GitHub CLI's tarball). Open only until egress narrows, before
 * the agent starts.
 */
export const INSTALL_EGRESS_HOSTS = [
  "registry.npmjs.org",
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
] as const;

/**
 * A job's two allowlists: what it reaches while it is set up (`install`) and
 * what it reaches while its agent runs (`run`).
 * @param apiUrl - The URL the sandbox reaches this API at.
 * @param hasRepository - Whether the job was started on a repository.
 * @param github - GitHub's origins; `config.github` by default.
 * @param github.webUrl - Where git clones from.
 * @param github.apiUrl - Where `gh` calls the REST API.
 * @returns Both sets of hostnames.
 */
export function buildEgressAllowlist(
  apiUrl: string,
  hasRepository: boolean,
  github: { webUrl: string; apiUrl: string } = config.github,
): { install: string[]; run: string[] } {
  const run = sandboxEgressHosts(apiUrl, hasRepository, github);
  const install = [...run];
  for (const host of INSTALL_EGRESS_HOSTS) {
    if (!install.includes(host)) install.push(host);
  }
  return { install, run };
}

/** What provisioning does with a job's egress. */
export type EgressPlan =
  /** The job cannot run here; `reason` is the sentence it fails with. */
  | { kind: "refuse"; reason: string }
  /** Leave the provider's default egress alone. */
  | { kind: "leave" }
  /**
   * Create with `create` (or the provider's default, when `null`), and
   * narrow to `run` after the runtime is installed, before the clone.
   */
  | {
      kind: "narrow";
      create: { mode: "deny-all"; allowDomains: string[] } | null;
      run: { mode: "deny-all"; allowDomains: string[] };
    };

/**
 * **Decide a job's egress.** An allowlist is *wanted* when the project's
 * egress mode is `allowlist` or the bot requires one; a repository job is
 * narrowed wherever the provider can, wanted or not, because repository
 * content is untrusted input and must not meet open egress. Every
 * combination:
 *
 * | Wanted | Provider can narrow | Repository | Plan |
 * |---|---|---|---|
 * | yes | no | either | refuse, with a sentence naming why |
 * | yes | yes | either | create on the install list, narrow to the run list |
 * | no | yes | yes | create with the provider's default, narrow to the run list |
 * | no | yes | no | leave the provider's default |
 * | no | no | yes | leave (a development provider; it cannot hold a list) |
 * | no | no | no | leave |
 * @param input - What decides it.
 * @param input.canNarrow - Whether the provider holds a list on a running sandbox.
 * @param input.providerLabel - The provider's name, for the refusal.
 * @param input.egressMode - The project's egress mode.
 * @param input.botRequires - Whether the bot requires an allowlist.
 * @param input.botName - The bot's name, for the refusal.
 * @param input.hasRepository - Whether the job was started on a repository.
 * @param input.apiUrl - The URL the sandbox reaches this API at.
 * @param input.github - GitHub's origins; `config.github` by default.
 * @returns The plan.
 */
export function planEgress(input: {
  canNarrow: boolean;
  providerLabel: string;
  egressMode: "open-world" | "allowlist";
  botRequires: boolean;
  botName: string;
  hasRepository: boolean;
  apiUrl: string;
  github?: { webUrl: string; apiUrl: string };
}): EgressPlan {
  const wanted = input.egressMode === "allowlist" || input.botRequires;
  if (wanted && !input.canNarrow) {
    return {
      kind: "refuse",
      reason: input.botRequires
        ? `${input.botName} may only run sandbox jobs behind an egress allowlist, and this project's sandbox provider (${input.providerLabel}) cannot enforce one. A project admin can choose a provider that can under Settings → Sandboxes.`
        : `This project's sandbox egress mode is "allowlist", and its sandbox provider (${input.providerLabel}) cannot enforce one. A project admin can choose a provider that can, or open egress, under Settings → Sandboxes.`,
    };
  }
  if (!input.canNarrow) return { kind: "leave" };
  const lists = buildEgressAllowlist(
    input.apiUrl,
    input.hasRepository,
    input.github,
  );
  const run = { mode: "deny-all" as const, allowDomains: lists.run };
  if (wanted) {
    return {
      kind: "narrow",
      create: { mode: "deny-all", allowDomains: lists.install },
      run,
    };
  }
  if (input.hasRepository) return { kind: "narrow", create: null, run };
  return { kind: "leave" };
}

/** The GitHub CLI release a provider on stock runtimes installs; `Dockerfile.dev` bakes the same. */
export const GITHUB_CLI_VERSION = "2.62.0";

/** Each coding CLI's binary and the npm package that installs it. */
export const CODING_AGENT_PACKAGES: Record<
  CodingAgent,
  { bin: string; npm: string }
> = {
  claude_code: { bin: "claude", npm: "@anthropic-ai/claude-code" },
  codex: { bin: "codex", npm: "@openai/codex" },
};

/**
 * The script that installs our runtime into a sandbox that boots without it
 * (a provider whose registry entry says `bakesRuntimeIntoImage: false`): bun,
 * the job's coding CLI, and — for a repository job — the GitHub CLI at the
 * path the managed `gh` wrapper calls. Each step is skipped when the tool is
 * already there, so a sandbox that has them costs nothing.
 * @param input - What to install.
 * @param input.githubCli - Whether to install the GitHub CLI.
 * @param input.agent - The coding CLI; Claude Code by default.
 * @returns A `/bin/sh` script.
 */
export function runtimeInstallScript(input: {
  githubCli: boolean;
  agent?: CodingAgent;
}): string {
  const cli = CODING_AGENT_PACKAGES[input.agent ?? "claude_code"];
  const lines = [
    "set -eu",
    // `sudo` resets PATH; carry ours so npm finds node.
    'asroot() { if [ "$(id -u)" = 0 ]; then "$@"; else sudo env "PATH=$PATH" "$@"; fi; }',
    "command -v bun >/dev/null 2>&1 || asroot npm install -g --no-fund --no-audit bun@1",
    `command -v ${cli.bin} >/dev/null 2>&1 || asroot npm install -g --no-fund --no-audit ${cli.npm}`,
  ];
  if (input.githubCli) {
    lines.push(
      `if [ ! -x ${GITHUB_CLI_REAL_PATH} ]; then`,
      '  case "$(uname -m)" in aarch64|arm64) arch=arm64 ;; *) arch=amd64 ;; esac',
      `  v=${GITHUB_CLI_VERSION}`,
      "  tmp=$(mktemp -d)",
      '  curl -fsSL "https://github.com/cli/cli/releases/download/v$v/gh_${v}_linux_$arch.tar.gz" -o "$tmp/gh.tar.gz"',
      '  tar -xzf "$tmp/gh.tar.gz" -C "$tmp"',
      `  asroot install -D -m 0755 "$tmp/gh_\${v}_linux_$arch/bin/gh" ${GITHUB_CLI_REAL_PATH}`,
      '  rm -rf "$tmp"',
      "fi",
    );
  }
  lines.push("bun --version >/dev/null", `${cli.bin} --version >/dev/null`);
  return lines.join("\n");
}

/**
 * The in-sandbox git files: the credential helper and the managed `gh`,
 * both executable, both naming the job token's variable rather than any
 * value, so nothing on disk is a credential.
 * @param apiUrl - The URL the sandbox reaches this API at.
 * @param webOrigin - Where repositories live.
 * @returns The writes.
 */
export function gitFiles(
  apiUrl: string,
  webOrigin: string,
): { path: string; content: string; mode: number }[] {
  const credentialUrl = gitCredentialUrl(apiUrl);
  return [
    {
      path: SANDBOX_PATHS.gitCredentialHelper,
      content: gitCredentialHelperScript(credentialUrl, JOB_TOKEN_ENV),
      mode: 0o755,
    },
    {
      path: SANDBOX_PATHS.githubCli,
      content: githubCliWrapperScript(
        credentialUrl,
        JOB_TOKEN_ENV,
        GITHUB_CLI_REAL_PATH,
        webOrigin,
      ),
      mode: 0o755,
    },
  ];
}

/**
 * Run one command in a sandbox and fail with what it said, redacted.
 * @param sandbox - The sandbox.
 * @param what - What the command was for, for the error.
 * @param argv - The command.
 * @param cwd - Where to run it.
 * @returns Its stdout.
 * @throws {Error} When it exits non-zero.
 */
async function mustExec(
  sandbox: Sandbox,
  what: string,
  argv: string[],
  cwd?: string,
): Promise<string> {
  const result = await sandbox.exec(argv[0], argv.slice(1), {
    ...(cwd ? { cwd } : {}),
    env: { GIT_TERMINAL_PROMPT: "0" },
  });
  if (result.exitCode !== 0) {
    const said = redactJobTokens(
      `${result.stderr}${result.stdout}`.trim(),
    ).slice(0, 2000);
    throw new Error(`${what} failed: ${said || `exit ${result.exitCode}`}`);
  }
  return result.stdout;
}

/**
 * **A repository job's prologue**, after the files are written and before
 * the supervisor starts: point git at the credential helper (for GitHub's
 * origin only), name the bot as the committer, put the managed `gh` on PATH
 * for login shells too, and clone. No GitHub token is written anywhere: the
 * helper and the wrapper ask for one per command, with the job token from
 * the environment, and the clone is the first such command. A clone git
 * refuses fails the job with git's own words — which carry the credential
 * endpoint's sentence when the repository was not granted.
 * @param sandbox - The sandbox.
 * @param input - The repository, the bot's identity, and GitHub's origin.
 * @param input.repo - The job's repository.
 * @param input.identity - The committer.
 * @param input.identity.name - `user.name`.
 * @param input.identity.email - `user.email`.
 * @param input.webOrigin - Where repositories live.
 * @returns The checkout's directory.
 */
export async function prepareRepository(
  sandbox: Sandbox,
  input: {
    repo: JobRepository;
    identity: { name: string; email: string };
    webOrigin: string;
  },
): Promise<string> {
  const { repo, identity, webOrigin } = input;
  for (const argv of gitSandboxConfigCommands(
    SANDBOX_PATHS.gitCredentialHelper,
    webOrigin,
  )) {
    await mustExec(sandbox, "configuring git", argv);
  }
  await mustExec(sandbox, "configuring git", [
    "git",
    "config",
    "--global",
    "user.name",
    identity.name,
  ]);
  await mustExec(sandbox, "configuring git", [
    "git",
    "config",
    "--global",
    "user.email",
    identity.email,
  ]);
  await mustExec(sandbox, "putting the managed gh on PATH", [
    "/bin/sh",
    "-c",
    persistGithubCliPathScript(SANDBOX_PATHS.binDir),
  ]);
  // `sandbox_start` refuses a bad ref; this is the last place before git's
  // command line, where a ref starting with `-` would be an option.
  const refProblem = repo.ref ? gitRefProblem(repo.ref) : null;
  if (refProblem) {
    throw new Error(`"${repo.ref}" is not a ref to check out: ${refProblem}`);
  }
  const dir = repositoryDir(repo);
  const origin = webOrigin.replace(/\/+$/, "");
  await mustExec(sandbox, `cloning ${repo.owner}/${repo.name}`, [
    "git",
    "clone",
    "--quiet",
    "--",
    `${origin}/${repo.owner}/${repo.name}.git`,
    dir,
  ]);
  if (repo.ref) {
    // A branch or tag name checks out directly (a remote branch gets a
    // tracking branch); anything else — a commit, a pull request's ref — is
    // fetched and checked out detached.
    const direct = await sandbox.exec(
      "git",
      ["checkout", "--quiet", repo.ref, "--"],
      { cwd: dir, env: { GIT_TERMINAL_PROMPT: "0" } },
    );
    if (direct.exitCode !== 0) {
      await mustExec(
        sandbox,
        `fetching ${repo.ref}`,
        ["git", "fetch", "--quiet", "--", "origin", repo.ref],
        dir,
      );
      await mustExec(
        sandbox,
        `checking out ${repo.ref}`,
        ["git", "checkout", "--quiet", "FETCH_HEAD"],
        dir,
      );
    }
  }
  return dir;
}

/**
 * The supervisor's files, read from this checkout.
 * @returns One write per file, under the control directory.
 */
export function runnerFiles(): { path: string; content: string }[] {
  return RUNNER_FILES.map((name) => ({
    path: `${SANDBOX_PATHS.runnerDir}/${name}`,
    content: readFileSync(
      join(import.meta.dir, "..", "sandbox", "runner", name),
      "utf8",
    ),
  }));
}

/**
 * The coding CLI's command line, with the supervisor's placeholders.
 * @param models - The models to use.
 * @param resume - The resume form: `--resume <session>` with a follow-up.
 * @returns The argv.
 */
export function claudeCommand(models: JobModels, resume = false): string[] {
  return [
    "claude",
    "-p",
    resume ? "__HYPOTENUSE_FOLLOW_UP__" : "__HYPOTENUSE_PROMPT__",
    ...(resume ? ["--resume", "__HYPOTENUSE_SESSION_ID__"] : []),
    "--output-format",
    "stream-json",
    "--verbose",
    "--mcp-config",
    SANDBOX_PATHS.mcpConfig,
    "--settings",
    SANDBOX_PATHS.settings,
    "--permission-mode",
    "bypassPermissions",
    "--model",
    models.model,
  ];
}

/**
 * Codex's command line, with the supervisor's placeholders. Every option goes
 * before `resume`, the subcommand that continues a session; Codex's own
 * sandbox and approvals are bypassed because the container is the sandbox.
 * @param models - The models to use.
 * @param resume - The resume form: `resume <session>` with a follow-up.
 * @returns The argv.
 */
export function codexCommand(models: JobModels, resume = false): string[] {
  return [
    "codex",
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--dangerously-bypass-approvals-and-sandbox",
    "--model",
    models.model,
    ...(resume
      ? ["resume", "__HYPOTENUSE_SESSION_ID__", "__HYPOTENUSE_FOLLOW_UP__"]
      : ["__HYPOTENUSE_PROMPT__"]),
  ];
}

/**
 * The job's coding CLI's command line: Claude Code or Codex, as its models say.
 * @param models - The models to use.
 * @param resume - The resume form.
 * @returns The argv.
 */
export function agentCommand(models: JobModels, resume = false): string[] {
  return models.agent === "codex"
    ? codexCommand(models, resume)
    : claudeCommand(models, resume);
}

/**
 * The variables that point a job's coding CLI at the model proxy and its
 * config. Claude Code reads `ANTHROPIC_*`; Codex reads `CODEX_HOME`, whose
 * config names the proxy and the variable holding the job token.
 * @param input - Where the sandbox reaches us, its token, and its models.
 * @param input.apiUrl - The URL the sandbox reaches this API at.
 * @param input.token - The job token.
 * @param input.models - The job's models.
 * @returns The variables.
 */
function agentEnv(input: {
  apiUrl: string;
  token: string;
  models: JobModels;
}): Record<string, string> {
  if (input.models.agent === "codex") {
    return { CODEX_HOME: SANDBOX_PATHS.codexHome };
  }
  return {
    ANTHROPIC_BASE_URL: `${input.apiUrl}/api/proxy/model/anthropic`,
    // Sent as `Authorization: Bearer`, which is what the proxy reads.
    ANTHROPIC_AUTH_TOKEN: input.token,
    ANTHROPIC_MODEL: input.models.model,
    ...(input.models.fastModel
      ? { ANTHROPIC_SMALL_FAST_MODEL: input.models.fastModel }
      : {}),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_AUTOUPDATER: "1",
  };
}

/**
 * The sandbox's environment. The job token is the only credential in it:
 * the model proxy and the gateway proxy attach the real keys server-side, and
 * git's helper trades the job token for a GitHub token one command at a time.
 * @param input - The job, its token, where it reaches us, its models, and the
 *   coding CLI's working directory (a repository job's checkout).
 * @returns The variables.
 */
export function buildSandboxEnv(input: {
  job: Pick<SandboxJob, "id" | "interactive">;
  token: string;
  apiUrl: string;
  models: JobModels;
  cwd?: string;
}): Record<string, string> {
  return {
    [JOB_TOKEN_ENV]: input.token,
    HYPOTENUSE_API_URL: input.apiUrl,
    HYPOTENUSE_JOB_ID: String(input.job.id),
    HYPOTENUSE_CWD: input.cwd ?? SANDBOX_CWD,
    HYPOTENUSE_PROMPT_FILE: SANDBOX_PATHS.prompt,
    HYPOTENUSE_LOG_FILE: SANDBOX_PATHS.log,
    HYPOTENUSE_HEARTBEAT_MS: String(config.sandbox.heartbeatMs),
    HYPOTENUSE_INTERACTIVE: input.job.interactive ? "true" : "false",
    HYPOTENUSE_AGENT: input.models.agent,
    HYPOTENUSE_COMMAND: JSON.stringify(agentCommand(input.models)),
    HYPOTENUSE_RESUME_COMMAND: JSON.stringify(agentCommand(input.models, true)),
    ...agentEnv(input),
  };
}

/**
 * What the briefing says about a job's repository, read from its grant and
 * who asked. The grant is re-read here: one revoked since `sandbox_start`
 * fails the job before a sandbox is created.
 * @param job - The job.
 * @param bot - Its bot.
 * @param repo - Its repository.
 * @param webOrigin - Where repositories live.
 * @returns The briefing's repository.
 * @throws {Error} When the bot no longer holds a grant for it.
 */
async function briefingRepository(
  job: SandboxJob,
  bot: Bot,
  repo: JobRepository,
  webOrigin: string,
): Promise<BriefingRepository> {
  const found = await grantForBot(api.db.db, job.projectId, bot.id, {
    host: repo.host,
    owner: repo.owner,
    repo: repo.name,
  });
  if (!found) {
    throw new Error(
      `${bot.displayName} no longer has access to ${repo.owner}/${repo.name}; a project admin can grant it under Repositories.`,
    );
  }
  const unavailable = installationUnavailableReason(found.installation);
  if (unavailable) {
    throw new Error(
      `${repo.owner}/${repo.name} cannot be cloned: ${unavailable}.`,
    );
  }
  let coAuthor: string | null = null;
  if (job.triggeredByUserId) {
    const [u] = await api.db.db
      .select({ name: users.name, email: users.email })
      .from(users)
      .where(eq(users.id, job.triggeredByUserId))
      .limit(1);
    if (u?.email) coAuthor = `${u.name || u.email} <${u.email}>`;
  }
  const identity = gitIdentity(bot);
  return {
    fullName: `${repo.owner}/${repo.name}`,
    dir: repositoryDir(repo),
    ref: repo.ref ?? null,
    mode: repo.mode === "write" && found.grant.push ? "write" : "read",
    branchPrefix: branchPrefixFor(found.grant, bot.slug),
    identity: `${identity.name} <${identity.email}>`,
    coAuthor,
    webOrigin,
  };
}

/** What `sandbox-job:start` did with a job. */
export type StartOutcome = "running" | "skipped" | "failed" | "cancelled";

/**
 * **Bring a claimed job up**, in ToolExec's order: mint the token, ledger and
 * create the sandbox, write its files, launch the supervisor. `cancelRequested`
 * is re-read between steps, so a cancel during provisioning stops it at the
 * next step rather than after the CLI starts. Any failure ends the job
 * through `finalizeSandboxJob`, which also destroys whatever was created.
 * @param jobId - A job `claimPendingJobs` moved to `provisioning`.
 * @returns What happened.
 */
export async function startSandboxJob(jobId: number): Promise<StartOutcome> {
  const job = await loadJob(api.db.db, jobId);
  if (!job || job.status !== "provisioning") return "skipped";
  const stillWanted = async () => {
    const latest = await loadJob(api.db.db, jobId);
    if (!latest || latest.status !== "provisioning") return false;
    if (latest.cancelRequested) {
      await finalizeSandboxJob(jobId, {
        status: "cancelled",
        reason: latest.endReason ?? "cancelled_while_provisioning",
      });
      return false;
    }
    return true;
  };
  try {
    if (!(await stillWanted())) return "cancelled";
    const [bot] = await api.db.db
      .select()
      .from(bots)
      .where(eq(bots.id, job.botId))
      .limit(1);
    const conversation = await parentOf(api.db.db, job);
    if (!bot || !conversation)
      throw new Error("The job's bot or conversation is gone.");
    // The provider is read when the job starts, not when it was created: a
    // job queued before an admin switched providers starts on the new one.
    const settings = effectiveSandboxSettings(
      await getOrCreateSettings(api.db.db, job.projectId),
    );
    const provider = settings.provider;
    const definition = assertSandboxProviderAllowed(provider);
    if (provider !== job.provider) {
      await api.db.db
        .update(sandboxJobs)
        .set({ provider })
        .where(eq(sandboxJobs.id, jobId));
    }
    const models = await jobModels(api.db.db, bot);
    if (!models) {
      throw new Error(
        `${unsupportedCodingModel(bot.displayName, bot.modelAlias)} A project admin can point it at one under Settings → Models.`,
      );
    }
    const apiUrl = resolveSandboxApiUrl(provider);
    const repo = jobRepository(job);
    const egress = planEgress({
      canNarrow: canNarrowEgress(definition.capabilities),
      providerLabel: definition.label,
      egressMode: settings.egressMode,
      botRequires: bot.requireEgressAllowlist,
      botName: bot.displayName,
      hasRepository: repo !== null,
      apiUrl,
    });
    if (egress.kind === "refuse") throw new Error(egress.reason);

    // 1. The token: win the row first, then register it, so two starters
    //    can never clobber each other's credential.
    const { token, tokenHash } = generateJobToken();
    const [won] = await api.db.db
      .update(sandboxJobs)
      .set({ tokenHash })
      .where(
        and(
          eq(sandboxJobs.id, jobId),
          eq(sandboxJobs.status, "provisioning"),
          isNull(sandboxJobs.tokenHash),
        ),
      )
      .returning({ id: sandboxJobs.id });
    if (!won) return "skipped";
    await registerJobToken(jobId, token, job.maxDurationMs + 15 * 60 * 1000);
    // Ended between winning the row and registering (a reap, a cancel): its
    // revocation found nothing to revoke, so revoke the token here.
    if (!(await stillWanted())) {
      await revokeJobToken(jobId);
      return "cancelled";
    }

    // 2. The briefing, recorded on the job.
    const servers = await collectMcpServers(api.db.db, bot, apiUrl);
    const webOrigin = githubWebOrigin().replace(/\/+$/, "");
    const repository = repo
      ? await briefingRepository(job, bot, repo, webOrigin)
      : null;
    const briefing = renderBriefing(job, {
      ...(await briefingContext(api.db.db, job, conversation, bot, servers)),
      repository,
    });
    await api.db.db
      .update(sandboxJobs)
      .set({ briefing })
      .where(eq(sandboxJobs.id, jobId));
    if (!(await stillWanted())) return "cancelled";

    // 3. The sandbox, ledgered before the provider is asked.
    const { sandbox } = await provisionSandbox({
      projectId: job.projectId,
      provider,
      jobId,
      options: {
        image: (settings.image ?? settings.runtime) || undefined,
        ...(settings.vcpus ? { vcpus: settings.vcpus } : {}),
        ...(settings.memoryMiB ? { memoryMiB: settings.memoryMiB } : {}),
        ...(egress.kind === "narrow" && egress.create
          ? { egress: egress.create }
          : {}),
        timeoutMs: job.maxDurationMs + 5 * 60 * 1000,
        env: buildSandboxEnv({
          job,
          token,
          apiUrl,
          models,
          cwd: repository?.dir,
        }),
      },
    });

    // 4. A provider on stock runtimes: our runtime, installed while egress
    //    is still open to the package registries.
    if (!definition.bakesRuntimeIntoImage) {
      const installed = await sandbox.exec("/bin/sh", [
        "-c",
        runtimeInstallScript({
          githubCli: repo !== null,
          agent: models.agent,
        }),
      ]);
      if (installed.exitCode !== 0) {
        throw new Error(
          `installing the sandbox runtime failed: ${redactJobTokens(`${installed.stderr}${installed.stdout}`.trim()).slice(-2000)}`,
        );
      }
      if (!(await stillWanted())) return "cancelled";
    }

    // 5. Its files.
    await sandbox.writeFiles([
      { path: SANDBOX_PATHS.prompt, content: briefing },
      ...agentConfigFiles({ apiUrl, models, servers }),
      ...runnerFiles(),
      ...(repo ? gitFiles(apiUrl, webOrigin) : []),
    ]);
    if (!(await stillWanted())) return "cancelled";

    // 6. Narrow egress to the running list, before any repository content
    //    arrives and before the agent starts (`planEgress`'s table).
    if (egress.kind === "narrow") await sandbox.setEgress(egress.run);

    // 7. A repository job's prologue: git configured, the managed gh on
    //    PATH, the repository cloned.
    if (repo && repository) {
      await prepareRepository(sandbox, {
        repo,
        identity: gitIdentity(bot),
        webOrigin,
      });
      if (!(await stillWanted())) return "cancelled";
    }

    // 8. The supervisor, and the job is running. The managed gh's directory
    //    leads its PATH, which the coding CLI and every command inherit.
    let env: Record<string, string> | undefined;
    if (repo) {
      const path = (
        await sandbox.exec("/bin/sh", ["-c", 'printf %s "$PATH"'])
      ).stdout.trim();
      env = {
        PATH: `${SANDBOX_PATHS.binDir}:${path || "/usr/local/bin:/usr/bin:/bin"}`,
      };
    }
    await sandbox.spawn("bun", [SANDBOX_PATHS.runner], {
      cwd: SANDBOX_CWD,
      ...(env ? { env } : {}),
    });
    const now = new Date();
    await api.db.db
      .update(sandboxJobs)
      .set({ status: "running", lastHeartbeatAt: now, lastActivityAt: now })
      .where(
        and(eq(sandboxJobs.id, jobId), eq(sandboxJobs.status, "provisioning")),
      );
    return "running";
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    api.logger.warn("a sandbox job could not start", { jobId, error: message });
    await finalizeSandboxJob(jobId, {
      status: "failed",
      reason: "provisioning_failed",
      error: message,
    });
    return "failed";
  }
}
