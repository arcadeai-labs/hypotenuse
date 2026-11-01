import { readFileSync } from "node:fs";
import { join } from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import { api, config } from "keryx";
// Type-only, purely for the `declare module "keryx"` augmentation inside.
import type {} from "../config/sandbox";
import {
  assertSandboxProviderAllowed,
  buildSandboxProvider,
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
  gitSandboxConfigCommands,
  persistGithubCliPathScript,
} from "./GitAccessOps";
import {
  grantForBot,
  type JobRepository,
  jobRepository,
} from "./GitCredentialOps";
import { githubWebOrigin } from "./GitHubAppOps";
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
 * a value on disk), Claude Code's settings, the supervisor's files, the
 * environment, and — for a job started on a repository — git's credential
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

/** The model a job's coding CLI is told to use, and its small one. */
export interface JobModels {
  model: string;
  fastModel: string | null;
}

/**
 * The models a bot's coding agent speaks to: its `modelAlias` and
 * `fastModelAlias`, when each points at an Anthropic connection — the API the
 * coding CLI speaks, and the only one the model proxy forwards.
 * @param db - A database handle.
 * @param bot - The bot.
 * @returns The model ids, or `null` when the bot's main model is not Anthropic.
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
    return row?.provider === "anthropic" ? row.modelId : null;
  };
  const model = await resolve(bot.modelAlias);
  if (!model) return null;
  return { model, fastModel: await resolve(bot.fastModelAlias) };
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
 * Where a job's repository is checked out.
 * @param repo - The job's repository.
 * @returns The directory, under the sandbox's working directory.
 */
export function repositoryDir(repo: Pick<JobRepository, "name">): string {
  return `${SANDBOX_CWD}/${repo.name}`;
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
  const dir = repositoryDir(repo);
  const origin = webOrigin.replace(/\/+$/, "");
  await mustExec(sandbox, `cloning ${repo.owner}/${repo.name}`, [
    "git",
    "clone",
    "--quiet",
    `${origin}/${repo.owner}/${repo.name}.git`,
    dir,
  ]);
  if (repo.ref) {
    // A branch or tag name checks out directly (a remote branch gets a
    // tracking branch); anything else — a commit, a pull request's ref — is
    // fetched and checked out detached.
    const direct = await sandbox.exec(
      "git",
      ["checkout", "--quiet", repo.ref],
      { cwd: dir, env: { GIT_TERMINAL_PROMPT: "0" } },
    );
    if (direct.exitCode !== 0) {
      await mustExec(
        sandbox,
        `fetching ${repo.ref}`,
        ["git", "fetch", "--quiet", "origin", repo.ref],
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
    HYPOTENUSE_COMMAND: JSON.stringify(claudeCommand(input.models)),
    HYPOTENUSE_RESUME_COMMAND: JSON.stringify(
      claudeCommand(input.models, true),
    ),
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
    const provider = job.provider ?? config.sandbox.defaultProvider;
    assertSandboxProviderAllowed(provider);
    const models = await jobModels(api.db.db, bot);
    if (!models) {
      throw new Error(
        `The coding agent speaks the Anthropic API, and ${bot.displayName}'s "${bot.modelAlias}" model is not on an Anthropic connection. A project admin can point it at one under Settings → Models.`,
      );
    }
    const settings = effectiveSandboxSettings(
      await getOrCreateSettings(api.db.db, job.projectId),
    );

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
    const apiUrl = resolveSandboxApiUrl(provider);
    const servers = await collectMcpServers(api.db.db, bot, apiUrl);
    const repo = jobRepository(job);
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
        image: settings.image ?? undefined,
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

    // 4. Its files.
    await sandbox.writeFiles([
      { path: SANDBOX_PATHS.prompt, content: briefing },
      { path: SANDBOX_PATHS.mcpConfig, content: buildMcpConfig(servers) },
      { path: SANDBOX_PATHS.settings, content: buildClaudeSettings() },
      ...runnerFiles(),
      ...(repo ? gitFiles(apiUrl, webOrigin) : []),
    ]);
    if (!(await stillWanted())) return "cancelled";

    // 5. Narrow egress where the provider can hold a sandbox to a list.
    if (buildSandboxProvider(provider).capabilities.domainEgressAllowlist) {
      await sandbox.setEgress({
        mode: "deny-all",
        allowDomains: sandboxEgressHosts(apiUrl, repo !== null),
      });
    }

    // 6. A repository job's prologue: git configured, the managed gh on
    //    PATH, the repository cloned.
    if (repo && repository) {
      await prepareRepository(sandbox, {
        repo,
        identity: gitIdentity(bot),
        webOrigin,
      });
      if (!(await stillWanted())) return "cancelled";
    }

    // 7. The supervisor, and the job is running. The managed gh's directory
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
