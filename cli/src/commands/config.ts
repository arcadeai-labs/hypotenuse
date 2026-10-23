/**
 * `hypotenuse config` — the daemon's config file: write a starter
 * (`init`), check one (`validate`), print its JSON Schema (`schema`), and say
 * which files are in play (`path`).
 *
 * `validate` exits 0 when the file is valid (warnings allowed), 1 on errors,
 * and 2 when the file cannot be read or parsed.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, resolve } from "node:path";
import type { Command } from "commander";
import { PROTOCOL_VERSION } from "../../../protocol/src/index";
import pkg from "../../package.json";
import { originOf } from "../api/credentials";
import { checkConfig, formatIssue, summarize } from "../config/check";
import type { ConfigIssue } from "../config/loader";
import { applyOverrides } from "../config/loader";
import { type MachineEnv, realMachine } from "../config/machine";
import { daemonPaths, expandPath, tildify } from "../config/paths";
import { AGENT_PRESETS, PRESET_NAMES } from "../config/presets";
import {
  type Config,
  configJsonSchema,
  defaultMaxParallelJobs,
} from "../config/schema";
import template from "../config/template.toml" with { type: "text" };
import { mergeFindings, validateOnline } from "../config/validate";
import { type CliContext, emit, runCommand } from "../context";
import {
  buildCapabilities,
  buildLimits,
  daemonRepositories,
} from "../daemon/capabilities";
import { color, glyph } from "../output/theme";
import { machineId, platform } from "../runner/machine";
import { ExitError } from "../shutdown";

/** `config validate`'s exit code for a file that cannot be read or parsed. */
export const EXIT_UNREADABLE = 2;

/**
 * The preset `config init` enables: `claude` when Claude Code is installed,
 * else the first preset whose binary resolves.
 * @param machine - The machine.
 * @returns A preset name.
 */
export function detectPreset(machine: MachineEnv): string {
  if (machine.which("claude")) return "claude";
  for (const name of PRESET_NAMES) {
    const binary = AGENT_PRESETS[name].command[0] as string;
    if (machine.which(binary)) return name;
  }
  return "claude";
}

/**
 * Describe repositories for the starter file. Only the path: the remote is
 * the clone's origin and the base branch its `origin/HEAD`, read from git
 * every time the daemon starts or reloads, so the file never repeats them.
 * @param paths - The `--repo` paths, absolute.
 * @param env - Environment variables.
 * @returns TOML text.
 */
export function repositoryBlocks(
  paths: string[],
  env: Record<string, string | undefined>,
): string {
  const overrides = [
    '# base_branch = "develop"           # default: the branch origin/HEAD names',
    '# setup = ["bun install --frozen-lockfile"]',
  ];
  if (paths.length === 0) {
    return [
      "# One table per git clone this runner works in (`config init --repo <path>` fills these in):",
      "# [[repositories]]",
      '# path = "~/code/web"',
      ...overrides,
    ].join("\n");
  }
  return paths
    .map((path) =>
      [
        "[[repositories]]",
        `path = ${JSON.stringify(tildify(path, env))}`,
        ...overrides,
      ].join("\n"),
    )
    .join("\n\n");
}

/**
 * The starter config text.
 * @param input - What was detected.
 * @returns The file's contents.
 */
export function renderTemplate(input: {
  server: string | null;
  agent: string;
  repositories: string;
  cpus: number;
}): string {
  return template
    .replaceAll(
      "{{server}}",
      // A comment either way: with no url the daemon uses the server this
      // machine's runner is registered on.
      `# url = ${JSON.stringify(input.server ?? "https://api.hypotenuse.cloud")}   # default: where this machine's runner is registered`,
    )
    .replaceAll("{{hostname}}", hostname().replace(/\.local$/i, ""))
    .replaceAll("{{jobs}}", String(defaultMaxParallelJobs(input.cpus)))
    .replaceAll("{{agent}}", input.agent)
    .replaceAll("{{repositories}}", input.repositories);
}

/** `--json`'s shape for `validate`. */
export interface ValidateReport {
  valid: boolean;
  path: string;
  errors: ConfigIssue[];
  warnings: ConfigIssue[];
}

/**
 * Run every pass over a file (and the online checks when asked).
 * @param ctx - The command context.
 * @param options - `online` and `offline`.
 * @returns The report and whether the file was unreadable.
 */
export async function validateFile(
  ctx: CliContext,
  options: { online?: boolean; offline?: boolean },
): Promise<{
  report: ValidateReport;
  unreadable: boolean;
  config: Config | null;
}> {
  const path = ctx.configPath;
  const machine = realMachine(ctx.env);
  const checked = checkConfig(path, {
    env: ctx.env,
    machine,
    offline: options.offline,
  });
  let findings = checked.findings;
  let config = checked.config;
  if (config && options.online) {
    config = applyOverrides(
      config,
      { url: ctx.options.url, project: ctx.options.project },
      ctx.env,
    );
    const credentials = ctx.credentials;
    const origin = config.server.url
      ? originOf(config.server.url)
      : ctx.server.origin;
    const repositories = daemonRepositories(config, machine);
    const online = await validateOnline(config, {
      server: origin,
      runner: credentials.servers[origin]?.runner ?? null,
      credentialsPath: ctx.credentialsPath,
      machineId: machineId(),
      heartbeat: {
        protocolVersion: PROTOCOL_VERSION,
        daemonVersion: pkg.version,
        platform: platform(),
        hostname: hostname().slice(0, 256) || "unknown",
        draining: false,
        machineId: machineId(),
        limits: buildLimits(config),
        active: [],
        capabilities: buildCapabilities(config, machine, repositories),
      },
    });
    findings = mergeFindings(findings, online);
  }
  return {
    report: {
      valid: findings.errors.length === 0,
      path,
      errors: findings.errors,
      warnings: findings.warnings,
    },
    unreadable: checked.load.unreadable,
    config,
  };
}

/**
 * Print a validation report.
 * @param ctx - The context.
 * @param report - The report.
 */
export function printReport(ctx: CliContext, report: ValidateReport): void {
  emit(ctx, report, () =>
    [
      ...report.errors.map(
        (issue) => `${glyph("error")} ${formatIssue(issue, report.path)}`,
      ),
      ...report.warnings.map(
        (issue) =>
          `${color("status-waiting", "!")} ${formatIssue(issue, report.path)}`,
      ),
      report.valid && report.warnings.length === 0
        ? `${glyph("complete")} ${tildify(report.path, ctx.env)} is valid`
        : summarize(report),
    ].join("\n"),
  );
}

/**
 * Register `config init|validate|schema|path`.
 * @param program - The root program.
 */
export function registerConfigCommands(program: Command): void {
  const config = program
    .command("config")
    .description("The daemon's config file");

  config
    .command("init")
    .description(
      "Write a commented starter config, filled in with what this machine has",
    )
    .option(
      "--repo <path>",
      "add a repository (repeatable)",
      (value: string, all: string[] = []) => [...all, value],
    )
    .option("--force", "overwrite an existing file")
    .action(async function (this: Command) {
      await runCommand(this, async (ctx) => {
        const opts = this.opts() as { repo?: string[]; force?: boolean };
        const path = ctx.configPath;
        if (existsSync(path) && !opts.force) {
          throw new Error(
            `${path} already exists; pass --force to overwrite it`,
          );
        }
        const machine = realMachine(ctx.env);
        const repos = (opts.repo ?? []).map((p) =>
          expandPath(p, process.cwd(), ctx.env),
        );
        let server: string | null = null;
        try {
          server =
            Object.keys(ctx.credentials.servers).length > 0
              ? ctx.server.origin
              : null;
        } catch {
          server = null;
        }
        const text = renderTemplate({
          server,
          agent: detectPreset(machine),
          repositories: repositoryBlocks(repos, ctx.env),
          cpus: navigator.hardwareConcurrency || 1,
        });
        mkdirSync(dirname(resolve(path)), { recursive: true, mode: 0o700 });
        writeFileSync(path, text);
        if (!ctx.json) console.log(`Wrote ${tildify(path, ctx.env)}.`);
        const { report } = await validateFile(ctx, { offline: true });
        printReport(ctx, report);
        if (!report.valid) process.exitCode = 1;
      });
    });

  config
    .command("validate")
    .description(
      "Check the config file: shape, references, and this machine (exit 0 valid, 1 errors, 2 unreadable)",
    )
    .option(
      "--online",
      "also check the server, the runner token, the project, and team keys",
    )
    .option("--offline", "skip checks that reach a git remote")
    .action(async function (this: Command) {
      await runCommand(this, async (ctx) => {
        const opts = this.opts() as { online?: boolean; offline?: boolean };
        const { report, unreadable } = await validateFile(ctx, opts);
        printReport(ctx, report);
        if (unreadable) throw new ExitError(EXIT_UNREADABLE);
        if (!report.valid) throw new ExitError(1);
      });
    });

  config
    .command("schema")
    .description("Print the config file's JSON Schema")
    .action(async function (this: Command) {
      await runCommand(this, async () => {
        console.log(JSON.stringify(configJsonSchema(), null, 2));
      });
    });

  config
    .command("path")
    .description(
      "Print the config file, state directory, and credentials file in use",
    )
    .action(async function (this: Command) {
      await runCommand(this, async (ctx) => {
        const paths = daemonPaths(
          ctx.configPath,
          ctx.options.stateDir,
          undefined,
          ctx.env,
        );
        const value = {
          config: paths.config,
          stateDir: paths.stateDir,
          credentials: ctx.credentialsPath,
        };
        emit(ctx, value, () =>
          [value.config, value.stateDir, value.credentials].join("\n"),
        );
      });
    });
}
