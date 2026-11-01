import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { api, config, ErrorType, TypedError } from "keryx";
// Type-only, purely for the `declare module "keryx"` augmentation inside.
// The frontend resolves action response types through the `@backend/*` alias, so
// its `tsc -b` type-checks this file too — and without this it would not know
// `config.sandbox` exists. A *value* import would work for tsc and then fail
// `vite build`, by pulling keryx's runtime (and `import "bun"`) into the browser
// bundle. Type-only imports are the contract; values never cross.
import type {} from "../../config/sandbox";
import type {
  CreateSandboxOptions,
  EgressPolicy,
  ExecHandle,
  ExecOptions,
  ExecResult,
  FileWrite,
  ProviderCapabilities,
  Sandbox,
  SandboxListing,
  SandboxProvider,
} from "../types";
import { SandboxNotFoundError } from "../types";
import {
  attachProbeScript,
  newHandleId,
  PollingExecHandle,
  SANDBOX_STATE_DIR,
  shellQuote,
  spawnScript,
} from "./execPolling";

/**
 * The label every container this provider creates carries. `list()` filters on
 * it unconditionally, so a stray `docker rm -f` can never reach a container
 * Hypotenuse did not start — which matters, because the orphan sweeper's whole job
 * is to destroy things nobody is watching.
 */
export const MANAGED_LABEL = "hypotenuse.managed";

/** Namespace prefix for the caller-supplied labels in {@link CreateSandboxOptions.labels}. */
const LABEL_PREFIX = "hypotenuse.";

/**
 * The hostname a container reaches the host on. `resolveSandboxApiUrl`
 * substitutes it for a loopback host, and {@link DockerSandboxProvider.create}
 * adds the host entry that makes it resolve.
 */
export const DOCKER_HOST_ALIAS = "host.docker.internal";

/**
 * What this provider can do, as a value rather than an instance property.
 *
 * Exported and referenced by both the class and the registry definition, so a
 * caller that only wants to *describe* the provider — `project:settings-view`
 * — never has to construct one.
 *
 * `domainEgressAllowlist: false` is the honest half of this file: a container on
 * docker's bridge network has unrestricted egress and there is no portable
 * daemon-only way to narrow it, so the provider declares that it cannot rather
 * than accepting a policy it would silently ignore.
 */
export const DOCKER_CAPABILITIES: ProviderCapabilities = {
  domainEgressAllowlist: false,
  liveEgressUpdate: false,
  reattach: true,
  maxTimeoutMs: 24 * 60 * 60 * 1000,
};

/** The file the keep-alive loop reads its deadline (epoch seconds) from. */
const DEADLINE_FILE = `${SANDBOX_STATE_DIR}/deadline`;

/**
 * Parse `docker ps --format {{.CreatedAt}}`, which is Go's
 * `2006-01-02 15:04:05 -0700 MST` — a space-separated date, a numeric offset,
 * and a timezone *abbreviation* that is ambiguous and unparseable. Drop the
 * abbreviation and reshape the rest into an ISO 8601 string rather than trusting
 * the engine's non-standard date fallback.
 * @param raw - The timestamp as docker printed it.
 * @returns The parsed date, or undefined if it did not parse.
 */
function parseDockerTimestamp(raw: string | undefined): Date | undefined {
  if (!raw) return undefined;
  const match = raw
    .trim()
    .match(
      /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.\d+)? ([+-]\d{2})(\d{2})/,
    );
  if (!match) return undefined;
  const date = new Date(`${match[1]}T${match[2]}${match[3]}:${match[4]}`);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** The outcome of one `docker` invocation. */
interface DockerResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Run the `docker` CLI and collect its output. Nothing goes through a shell, so
 * arguments carrying spaces, quotes, or newlines are passed through verbatim.
 * @param args - Arguments to `docker`.
 * @returns The exit code and captured streams.
 * @throws {TypedError} `CONNECTION_ACTION_RUN` if the `docker` binary is missing.
 */
async function docker(args: string[]): Promise<DockerResult> {
  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn(["docker", ...args], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (_e) {
    throw new TypedError({
      message:
        "The docker sandbox provider requires the `docker` CLI on PATH, and it was not found",
      type: ErrorType.CONNECTION_ACTION_RUN,
    });
  }

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { exitCode, stdout, stderr };
}

/**
 * Run `docker` and throw unless it succeeded.
 * @param args - Arguments to `docker`.
 * @param what - A short description of the operation, for the error message.
 * @returns The trimmed stdout.
 * @throws {TypedError} `CONNECTION_ACTION_RUN` on a non-zero exit.
 */
async function dockerOrThrow(args: string[], what: string): Promise<string> {
  const result = await docker(args);
  if (result.exitCode !== 0) {
    throw new TypedError({
      message: `docker ${what} failed: ${result.stderr.trim() || result.stdout.trim()}`,
      type: ErrorType.CONNECTION_ACTION_RUN,
    });
  }
  return result.stdout.trim();
}

/**
 * How long to wait for the daemon to answer before calling it unreachable.
 *
 * A bounded wait rather than none, because "no daemon" and "a daemon that never
 * answers" are different failures that look identical from here — and only the
 * first one fails fast. A Docker Desktop that is installed but not running
 * leaves `docker info` blocked on a socket indefinitely, which without this
 * turns a suite that should *skip* into a suite that hangs forever.
 */
const AVAILABILITY_TIMEOUT_MS = 5_000;

/**
 * Whether the local Docker daemon is reachable. Tests gate on this so a
 * contributor without Docker still gets a green suite rather than a wall of
 * failures about a daemon they never asked for.
 * @returns `true` if `docker info` answers successfully within
 *   {@link AVAILABILITY_TIMEOUT_MS}.
 */
export async function isDockerAvailable(): Promise<boolean> {
  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn(["docker", "info", "--format", "{{.ServerVersion}}"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch {
    return false;
  }

  const timer = setTimeout(() => {
    proc.kill("SIGKILL");
  }, AVAILABILITY_TIMEOUT_MS);

  try {
    return (await proc.exited) === 0;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** A live container, presented as a {@link Sandbox}. */
class DockerSandboxImpl implements Sandbox {
  readonly id: string;
  readonly provider = "docker";
  readonly expiresAt?: Date;
  private readonly createdAt: Date;
  /** `uid:gid` of the container's own user, memoized by {@link containerOwner}. */
  private owner?: string;

  /**
   * @param id - The container id.
   * @param createdAt - When the container was created, for deadline arithmetic.
   * @param expiresAt - When the keep-alive loop will let it exit.
   */
  constructor(id: string, createdAt: Date, expiresAt?: Date) {
    this.id = id;
    this.createdAt = createdAt;
    this.expiresAt = expiresAt;
  }

  /**
   * The uid and gid the container's own commands run as, as `uid:gid`.
   *
   * Asked of the container rather than assumed, because the answer is the
   * image's `USER` and a project may point at an image we did not build.
   * Memoized: a container's user does not change, and `writeFiles` is called
   * once per provisioning step with thousands of files behind it.
   * @returns The owner string, ready to hand to `chown`.
   * @throws {TypedError} `CONNECTION_ACTION_RUN` if the container cannot answer,
   *   or answers with something that is not a pair of numbers.
   */
  private async containerOwner(): Promise<string> {
    if (this.owner) return this.owner;

    const output = await dockerOrThrow(
      ["exec", this.id, "/bin/sh", "-c", "id -u; id -g"],
      "id",
    );
    const [uid = "", gid = ""] = output.split("\n").map((line) => line.trim());
    if (!/^\d+$/.test(uid) || !/^\d+$/.test(gid)) {
      throw new TypedError({
        message: `Could not resolve the container user of sandbox ${this.id}: ${output}`,
        type: ErrorType.CONNECTION_ACTION_RUN,
      });
    }

    this.owner = `${uid}:${gid}`;
    return this.owner;
  }

  /**
   * Write files into the container, creating parent directories as needed.
   *
   * Staged into one temp tree on the host and copied with a single `docker cp`,
   * rather than one `cp` per file: a provisioning step writes the
   * prompt, the MCP config, the settings file, and the supervisor together, and
   * four round trips to the daemon for four small files is pure latency.
   * @param files - The files to write.
   */
  async writeFiles(files: FileWrite[]): Promise<void> {
    if (files.length === 0) return;

    const stage = await mkdtemp(join(tmpdir(), "hypotenuse-sbx-"));
    try {
      for (const file of files) {
        const relative = file.path.replace(/^\/+/, "");
        const target = join(stage, relative);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(
          target,
          typeof file.content === "string"
            ? Buffer.from(file.content, "utf8")
            : file.content,
        );
      }

      await dockerOrThrow(["cp", `${stage}/.`, `${this.id}:/`], "cp");

      // `docker cp` also carries the host's *ownership* in, and the daemon does
      // the copy as root, so the tree lands owned by whatever uid the
      // orchestrator happens to run as — 501 on a Mac, 1001 on a CI runner —
      // regardless of who the container is. Since the sandbox images run as a
      // non-root user, that leaves `/work` owned by somebody who does not exist
      // inside the container and not writable by the agent: a clone the agent
      // cannot commit to and a supervisor that cannot open its log. Normalize to
      // the container's own user, as root because only root may give a file
      // away. One recursive pass per top-level directory the copy touched, which
      // for a real run is just `/work`.
      const roots = [
        ...new Set(
          files.map((f) => `/${f.path.replace(/^\/+/, "").split("/")[0]}`),
        ),
      ];
      await dockerOrThrow(
        [
          "exec",
          "-u",
          "0",
          this.id,
          "chown",
          "-R",
          await this.containerOwner(),
          ...roots,
        ],
        "chown",
      );

      // `docker cp` carries the host's modes, which are the temp file's, not the
      // caller's. Apply the requested ones in one exec. After the chown, because
      // giving a file away clears its setuid and setgid bits.
      const chmods = files
        .filter((f) => f.mode !== undefined)
        .map(
          (f) =>
            `chmod ${(f.mode as number).toString(8).padStart(3, "0")} ${shellQuote(f.path)}`,
        );
      if (chmods.length > 0) {
        await dockerOrThrow(
          ["exec", this.id, "/bin/sh", "-c", chmods.join("; ")],
          "chmod",
        );
      }
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  }

  /**
   * Read a file out of the container, base64-wrapped so binary content survives
   * the trip through the CLI's text streams.
   * @param path - Absolute path inside the container.
   * @returns The file's bytes, or `null` if it does not exist.
   * @throws {TypedError} `CONNECTION_ACTION_RUN` if the read itself failed.
   */
  async readFile(path: string): Promise<Buffer | null> {
    const quoted = shellQuote(path);
    const result = await docker([
      "exec",
      this.id,
      "/bin/sh",
      "-c",
      `if [ -f ${quoted} ]; then base64 < ${quoted}; else exit 66; fi`,
    ]);

    // 66 is the wrapper's own "no such file", distinguishing a missing file from
    // a failed read — otherwise an unreadable file would masquerade as absent.
    if (result.exitCode === 66) return null;
    if (result.exitCode !== 0) {
      throw new TypedError({
        message: `Could not read ${path} from sandbox ${this.id}: ${result.stderr.trim()}`,
        type: ErrorType.CONNECTION_ACTION_RUN,
      });
    }

    return Buffer.from(result.stdout.replace(/\s+/g, ""), "base64");
  }

  /**
   * Create a directory (and its parents) inside the container.
   * @param path - Absolute path inside the container.
   */
  async mkdir(path: string): Promise<void> {
    await dockerOrThrow(["exec", this.id, "mkdir", "-p", path], "mkdir");
  }

  /**
   * Run one `/bin/sh` script inside the container.
   *
   * The {@link ShellRunner} {@link PollingExecHandle} is built on, and the only
   * thing this provider has to supply for background commands to work — the
   * bookkeeping, the polling, and the exit-after-drain rule are shared with every
   * other provider that can run a shell.
   * @param script - The script to run.
   * @returns Its exit code and stdout.
   */
  private shell(script: string): Promise<{ exitCode: number; stdout: string }> {
    return docker(["exec", this.id, "/bin/sh", "-c", script]);
  }

  /**
   * Build the `docker exec` prefix shared by {@link exec} and {@link spawn}.
   * @param options - Working directory, environment, privilege.
   * @param includeCwd - Whether to emit `-w`. {@link spawn} passes `false`,
   *   because its wrapper script must be able to create its state directory even
   *   when the requested working directory does not exist.
   * @returns The flags to place between `exec` and the container id.
   */
  private execFlags(options?: ExecOptions, includeCwd = true): string[] {
    const flags: string[] = [];
    if (includeCwd && options?.cwd) flags.push("-w", options.cwd);
    for (const [key, value] of Object.entries(options?.env ?? {})) {
      flags.push("-e", `${key}=${value}`);
    }
    if (options?.sudo) flags.push("-u", "root");
    return flags;
  }

  /**
   * Run a command to completion inside the container.
   * @param cmd - The executable.
   * @param args - Its arguments.
   * @param options - Working directory, environment, privilege.
   * @returns The exit code and the collected stdout/stderr.
   */
  async exec(
    cmd: string,
    args: string[] = [],
    options?: ExecOptions,
  ): Promise<ExecResult> {
    const result = await docker([
      "exec",
      ...this.execFlags(options),
      this.id,
      cmd,
      ...args,
    ]);
    return result;
  }

  /**
   * Start a command in the background and return a handle on it.
   *
   * The command runs under a wrapper script that redirects both streams to
   * files and records the pid and exit code beside them, so every fact
   * {@link PollingExecHandle} needs lives in the container rather than in this
   * process — which is what lets {@link attach} pick the command up after a
   * deploy.
   * @param cmd - The executable.
   * @param args - Its arguments.
   * @param options - Working directory, environment, privilege.
   * @returns A handle for streaming, waiting, and killing.
   */
  async spawn(
    cmd: string,
    args: string[] = [],
    options?: ExecOptions,
  ): Promise<ExecHandle> {
    const handleId = newHandleId();
    const commandLine = [cmd, ...args].map(shellQuote).join(" ");

    await dockerOrThrow(
      [
        "exec",
        "-d",
        ...this.execFlags(options, false),
        this.id,
        "/bin/sh",
        "-c",
        spawnScript(handleId, commandLine, options?.cwd),
      ],
      "exec -d",
    );

    return new PollingExecHandle(handleId, (script) => this.shell(script));
  }

  /**
   * Reattach to a command started earlier, possibly by another process.
   * @param handleId - The id from a previous {@link ExecHandle}.
   * @returns A handle equivalent to the original.
   * @throws {TypedError} `CONNECTION_ACTION_RUN` if the container no longer has
   *   that command's state directory.
   */
  async attach(handleId: string): Promise<ExecHandle> {
    const result = await this.shell(attachProbeScript(handleId));
    if (result.exitCode !== 0) {
      throw new TypedError({
        message: `No such command ${handleId} in sandbox ${this.id}`,
        type: ErrorType.CONNECTION_ACTION_RUN,
      });
    }
    return new PollingExecHandle(handleId, (script) => this.shell(script));
  }

  /**
   * Apply an egress policy — which this provider can only do for `allow-all`.
   *
   * A `deny-all` policy **throws** rather than being ignored. Docker's default
   * bridge network gives a container unrestricted egress, and there is no
   * portable, daemon-only way to enforce a domain allowlist on it. Silently
   * accepting the policy would mean an agent believed to be firewalled running
   * with the whole internet available, which is worse than refusing to start.
   * @param policy - The requested policy.
   * @throws {TypedError} `CONNECTION_ACTION_RUN` for any `deny-all` policy.
   */
  async setEgress(policy: EgressPolicy): Promise<void> {
    if (policy.mode === "deny-all") {
      throw new TypedError({
        message:
          "The docker sandbox provider cannot enforce a deny-all egress policy. Use a provider that can enforce an allowlist for jobs that need one.",
        type: ErrorType.CONNECTION_ACTION_RUN,
      });
    }
  }

  /**
   * Push the container's deadline out by rewriting the file its keep-alive loop
   * reads. There is no `docker` command for this — the deadline is ours.
   * @param ms - The new total lifetime measured from creation.
   */
  async extendTimeout(ms: number): Promise<void> {
    const deadline = Math.floor((this.createdAt.getTime() + ms) / 1000);
    await dockerOrThrow(
      ["exec", this.id, "/bin/sh", "-c", `echo ${deadline} > ${DEADLINE_FILE}`],
      "extendTimeout",
    );
  }

  /** Stop the container, leaving it inspectable with `docker logs`. */
  async stop(): Promise<void> {
    await docker(["stop", "-t", "5", this.id]);
  }

  /** Remove the container. Idempotent — an already-gone container is success. */
  async destroy(): Promise<void> {
    const result = await docker(["rm", "-f", this.id]);
    if (result.exitCode !== 0 && !/no such container/i.test(result.stderr)) {
      throw new TypedError({
        message: `Could not destroy sandbox ${this.id}: ${result.stderr.trim()}`,
        type: ErrorType.CONNECTION_ACTION_RUN,
      });
    }
  }
}

/**
 * The development-only sandbox provider: one container per sandbox on the
 * host's Docker daemon.
 *
 * It exists so the whole sandbox contract — create, write, exec, stream,
 * reattach, destroy — is testable in CI with no cloud credentials, and so the
 * local inner loop does not depend on a network round trip. It is barred from
 * production by {@link assertSandboxProviderAllowed}, both because a deployed
 * dyno has no daemon and because it cannot honor an egress allowlist.
 */
export class DockerSandboxProvider implements SandboxProvider {
  readonly name = "docker" as const;

  readonly capabilities = DOCKER_CAPABILITIES;

  /**
   * Start a container and hold it open with a deadline-watching keep-alive loop.
   *
   * The loop, rather than a plain `sleep`, is what makes
   * {@link Sandbox.extendTimeout} implementable: the deadline lives in a file
   * the loop re-reads every second, so extending it is a one-line write instead
   * of a container restart.
   * @param options - Image, resources, deadline, environment, egress, labels.
   * @returns The live sandbox.
   * @throws {TypedError} `CONNECTION_ACTION_RUN` if the daemon refuses, or if a
   *   `deny-all` egress policy was requested.
   */
  async create(options: CreateSandboxOptions): Promise<Sandbox> {
    if (options.egress && options.egress.mode === "deny-all") {
      throw new TypedError({
        message:
          "The docker sandbox provider cannot enforce a deny-all egress policy. Use a provider that can enforce an allowlist for jobs that need one.",
        type: ErrorType.CONNECTION_ACTION_RUN,
      });
    }

    const timeoutMs = Math.min(
      options.timeoutMs,
      this.capabilities.maxTimeoutMs,
    );
    const createdAt = new Date();
    const deadline = Math.floor((createdAt.getTime() + timeoutMs) / 1000);

    const args = [
      "run",
      "-d",
      "--label",
      `${MANAGED_LABEL}=true`,
      // The one thing a container cannot work out for itself: where we are.
      // `localhost` inside a container is the container, so an in-sandbox
      // supervisor pointed at the orchestrator's own base URL posts its events
      // into the void. Docker Desktop provides this alias natively; on Linux —
      // which is what CI is — it only exists if asked for.
      "--add-host",
      `${DOCKER_HOST_ALIAS}:host-gateway`,
    ];
    if (config.sandbox.dockerNetwork) {
      args.push("--network", config.sandbox.dockerNetwork);
    }
    for (const [key, value] of Object.entries(options.labels ?? {})) {
      args.push("--label", `${LABEL_PREFIX}${key}=${value}`);
    }
    for (const [key, value] of Object.entries(options.env ?? {})) {
      args.push("-e", `${key}=${value}`);
    }
    if (options.vcpus) args.push("--cpus", String(options.vcpus));
    if (options.memoryMiB) args.push("--memory", `${options.memoryMiB}m`);

    args.push(
      "--entrypoint",
      "/bin/sh",
      options.image || config.sandbox.dockerImage,
      "-c",
      [
        `mkdir -p ${SANDBOX_STATE_DIR} /work`,
        `echo ${deadline} > ${DEADLINE_FILE}`,
        `while [ "$(date +%s)" -lt "$(cat ${DEADLINE_FILE})" ]; do sleep 1; done`,
      ].join("\n"),
    );

    const id = await dockerOrThrow(args, "run");
    api.logger.debug("docker sandbox created", { id, timeoutMs });

    return new DockerSandboxImpl(id, createdAt, new Date(deadline * 1000));
  }

  /**
   * Reconnect to an existing container by id.
   * @param id - The container id.
   * @returns The sandbox.
   * @throws {SandboxNotFoundError} If no such container exists.
   */
  async connect(id: string): Promise<Sandbox> {
    const result = await docker([
      "inspect",
      "--format",
      "{{.Id}}\t{{.Created}}",
      id,
    ]);
    if (result.exitCode !== 0) {
      throw new SandboxNotFoundError("docker", id);
    }

    const [fullId, created] = result.stdout.trim().split("\t");
    const createdAt = new Date(created);

    // The deadline lives in the container, so a reconnecting worker learns the
    // real expiry rather than recomputing one from a timeout it never saw.
    const deadlineResult = await docker([
      "exec",
      fullId,
      "/bin/sh",
      "-c",
      `cat ${DEADLINE_FILE} 2>/dev/null`,
    ]);
    const seconds = Number.parseInt(deadlineResult.stdout.trim(), 10);

    return new DockerSandboxImpl(
      fullId,
      createdAt,
      Number.isFinite(seconds) ? new Date(seconds * 1000) : undefined,
    );
  }

  /**
   * List the containers this provider manages, optionally narrowed by label.
   *
   * Always filtered to {@link MANAGED_LABEL}, so the result can be fed straight
   * to a destroy loop without a second guard against somebody's database
   * container sharing a label name.
   * @param labels - Labels every returned container must carry, unprefixed.
   * @returns The matching sandboxes, with their labels.
   */
  async list(labels?: Record<string, string>): Promise<SandboxListing[]> {
    const args = [
      "ps",
      "-a",
      "--no-trunc",
      "--filter",
      `label=${MANAGED_LABEL}=true`,
    ];
    for (const [key, value] of Object.entries(labels ?? {})) {
      args.push("--filter", `label=${LABEL_PREFIX}${key}=${value}`);
    }
    args.push("--format", "{{.ID}}\t{{.State}}\t{{.CreatedAt}}\t{{.Labels}}");

    const output = await dockerOrThrow(args, "ps");
    if (output === "") return [];

    return output.split("\n").map((line) => {
      const [id, state, createdAt, labelList = ""] = line.split("\t");
      const parsed: Record<string, string> = {};
      for (const pair of labelList.split(",")) {
        const eq = pair.indexOf("=");
        if (eq === -1) continue;
        const key = pair.slice(0, eq);
        if (!key.startsWith(LABEL_PREFIX)) continue;
        parsed[key.slice(LABEL_PREFIX.length)] = pair.slice(eq + 1);
      }
      return {
        id,
        status: state.toLowerCase(),
        createdAt: parseDockerTimestamp(createdAt),
        labels: parsed,
      };
    });
  }
}
