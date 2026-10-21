/**
 * `hypotenuse service` — run the daemon as a user service, so it starts at
 * login and comes back after a crash: a launchd agent on macOS, a systemd user
 * unit on Linux. Never system-wide. Windows has no service yet; `install`
 * prints the foreground command and the docs' Task Scheduler recipe.
 *
 * The unit runs `daemon start --foreground` by absolute path — the compiled
 * binary, or `bun` and the npm bundle — with `-c` when the config is not at
 * its default path, `HYPOTENUSE_SERVICE=1` (so an upgrade exits for the
 * service manager to restart instead of re-executing), and the `PATH` of the
 * shell that installed it, because services start with almost none and the
 * agent presets need `npx`, `node`, `git`, and `gh`.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import type { Command } from "commander";
import { daemonPaths, resolveConfigPath } from "../config/paths";
import { type CliContext, emit, runCommand } from "../context";
import { callDaemon, DaemonNotRunning } from "../daemon/control-client";
import { selfCommand } from "../daemon/self";
import launchdTemplate from "../daemon/units/launchd.plist" with {
  type: "text",
};
import systemdTemplate from "../daemon/units/systemd.service" with {
  type: "text",
};
import { defaultConfigPath } from "../paths";
import { locateDaemon } from "./daemon";

/** The launchd label. */
export const LAUNCHD_LABEL = "dev.hypotenuse.daemon";

/** The systemd unit's name. */
export const SYSTEMD_UNIT = "hypotenuse.service";

/** Where the docs explain the Windows recipe. */
export const WINDOWS_DOCS = "https://www.hypotenuse.cloud/docs/daemon#windows";

/** What a unit is rendered from. */
export interface UnitInput {
  /** The daemon's full command line. */
  args: string[];
  /** `PATH` at install time. */
  path: string;
  /** Where launchd sends the process's own stdout and stderr. */
  output: string;
}

/**
 * The daemon's command line for a unit.
 * @param ctx - The context (config path and state directory).
 * @returns The arguments, the program first.
 */
export function serviceArgs(ctx: CliContext): string[] {
  const configPath = resolveConfigPath(ctx.options.config, ctx.env);
  return [
    ...selfCommand(),
    ...(configPath !== defaultConfigPath(ctx.env) ? ["-c", configPath] : []),
    ...(ctx.options.stateDir ? ["--state-dir", ctx.options.stateDir] : []),
    "daemon",
    "start",
    "--foreground",
  ];
}

/**
 * Escape text for XML.
 * @param value - The text.
 * @returns It, escaped.
 */
function xml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Quote one `ExecStart` argument the way systemd splits them.
 * @param value - The argument.
 * @returns It, quoted when it needs to be.
 */
function systemdQuote(value: string): string {
  const escaped = value.replace(/\\/g, "\\\\").replace(/%/g, "%%");
  return /[\s"']/.test(escaped) ? `"${escaped.replace(/"/g, '\\"')}"` : escaped;
}

/**
 * Render the launchd plist.
 * @param input - The command, `PATH`, and output file.
 * @returns The plist.
 */
export function renderLaunchd(input: UnitInput): string {
  return launchdTemplate
    .replace("{{label}}", LAUNCHD_LABEL)
    .replace(
      "{{args}}",
      input.args.map((a) => `    <string>${xml(a)}</string>`).join("\n"),
    )
    .replace("{{path}}", xml(input.path))
    .replaceAll("{{output}}", xml(input.output));
}

/**
 * Render the systemd user unit.
 * @param input - The command and `PATH`.
 * @returns The unit file.
 */
export function renderSystemd(input: UnitInput): string {
  return systemdTemplate
    .replace("{{exec}}", input.args.map(systemdQuote).join(" "))
    .replace("{{path}}", input.path.replace(/"/g, '\\"'));
}

/**
 * Where this platform's unit file lives.
 * @param platform - `process.platform`.
 * @param env - Environment variables.
 * @returns The path, or null on a platform without a service.
 */
export function unitPath(
  platform: string,
  env: Record<string, string | undefined>,
): string | null {
  const home = env.HOME || homedir();
  if (platform === "darwin")
    return join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
  if (platform === "linux") {
    return join(
      env.XDG_CONFIG_HOME || join(home, ".config"),
      "systemd",
      "user",
      SYSTEMD_UNIT,
    );
  }
  return null;
}

/**
 * Run a service-manager command, failing loudly.
 * @param args - The command.
 * @param allowFailure - Do not throw on a non-zero exit.
 * @returns Its output.
 */
function run(args: string[], allowFailure = false): string {
  const proc = Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe" });
  const out = `${proc.stdout.toString()}${proc.stderr.toString()}`.trim();
  if (proc.exitCode !== 0 && !allowFailure)
    throw new Error(`${args.join(" ")} failed: ${out}`);
  return out;
}

/**
 * Register `service install|uninstall|status`.
 * @param program - The root program.
 */
export function registerServiceCommands(program: Command): void {
  const service = program
    .command("service")
    .description("Run the daemon as a user service (launchd or systemd)");

  service
    .command("install")
    .description("Install and start the daemon as a service for this user")
    .option("--print", "print the unit file instead of installing it")
    .action(async function (this: Command) {
      await runCommand(this, async (ctx) => {
        const { print } = this.opts() as { print?: boolean };
        const platform = process.platform;
        const path = unitPath(platform, ctx.env);
        const args = serviceArgs(ctx);
        if (!path) {
          emit(ctx, { installed: false, command: args }, () =>
            [
              "There is no Windows service yet. Run the daemon in the foreground:",
              `  ${args.join(" ")}`,
              `or start it at logon with Task Scheduler: ${WINDOWS_DOCS}`,
            ].join("\n"),
          );
          return;
        }
        const paths = daemonPaths(
          resolveConfigPath(ctx.options.config, ctx.env),
          ctx.options.stateDir,
          undefined,
          ctx.env,
        );
        const input: UnitInput = {
          args,
          path: ctx.env.PATH ?? "",
          output: join(paths.stateDir, "service.log"),
        };
        const text =
          platform === "darwin" ? renderLaunchd(input) : renderSystemd(input);
        if (print) {
          console.log(text);
          return;
        }
        mkdirSync(dirname(path), { recursive: true });
        mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
        writeFileSync(path, text);
        if (platform === "darwin") {
          const domain = `gui/${userInfo().uid}`;
          run(["launchctl", "bootout", `${domain}/${LAUNCHD_LABEL}`], true);
          run(["launchctl", "bootstrap", domain, path]);
        } else {
          run(["systemctl", "--user", "daemon-reload"]);
          run(["systemctl", "--user", "enable", "--now", SYSTEMD_UNIT]);
        }
        emit(ctx, { installed: true, unit: path }, () =>
          [
            `Installed ${path} and started the daemon.`,
            platform === "linux"
              ? "To keep it running while you are logged out: `loginctl enable-linger $USER`."
              : "",
          ]
            .filter(Boolean)
            .join("\n"),
        );
      });
    });

  service
    .command("uninstall")
    .description("Stop the service and remove its unit file")
    .action(async function (this: Command) {
      await runCommand(this, async (ctx) => {
        const path = unitPath(process.platform, ctx.env);
        if (!path || !existsSync(path)) {
          emit(ctx, { removed: false }, () => "No service is installed.");
          return;
        }
        if (process.platform === "darwin") {
          run(
            ["launchctl", "bootout", `gui/${userInfo().uid}/${LAUNCHD_LABEL}`],
            true,
          );
        } else {
          run(["systemctl", "--user", "disable", "--now", SYSTEMD_UNIT], true);
        }
        rmSync(path, { force: true });
        if (process.platform === "linux")
          run(["systemctl", "--user", "daemon-reload"], true);
        emit(
          ctx,
          { removed: true, unit: path },
          () => `Stopped the service and removed ${path}.`,
        );
      });
    });

  service
    .command("status")
    .description(
      "Show whether the service is installed and loaded, and the daemon's status",
    )
    .action(async function (this: Command) {
      await runCommand(this, async (ctx) => {
        const path = unitPath(process.platform, ctx.env);
        const installed = Boolean(path && existsSync(path));
        let manager = "not installed";
        if (installed && process.platform === "darwin") {
          manager = run(
            ["launchctl", "print", `gui/${userInfo().uid}/${LAUNCHD_LABEL}`],
            true,
          ).includes("state = running")
            ? "running"
            : "loaded, not running";
        } else if (installed) {
          manager =
            run(["systemctl", "--user", "is-active", SYSTEMD_UNIT], true) ||
            "unknown";
        }
        let daemon: unknown = null;
        try {
          daemon = await callDaemon(locateDaemon(ctx).socket, "status");
        } catch (error) {
          if (!(error instanceof DaemonNotRunning)) throw error;
        }
        emit(ctx, { installed, unit: path, manager, daemon }, () =>
          [
            `unit     ${installed ? path : "not installed"}`,
            `manager  ${manager}`,
            `daemon   ${daemon ? "running" : "not running"}`,
          ].join("\n"),
        );
      });
    });
}
