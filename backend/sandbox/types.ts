/**
 * The sandbox abstraction every provider implements.
 *
 * The shape is modelled on the **union** of what Docker and the hosted
 * sandbox services expose, not their lowest common denominator. Two things are in the core
 * interface because retrofitting either later would touch every call site:
 * batched file writes ({@link Sandbox.writeFiles}) and an egress policy
 * ({@link EgressPolicy}). A third — {@link SandboxProvider.connect} plus
 * {@link Sandbox.attach} — is here because a thirty-minute job outlives a
 * deploy, and job orchestration cannot survive a worker restart without it.
 *
 * Providers declare what they can actually do in {@link ProviderCapabilities}
 * and **throw** when asked for something they cannot honor. A provider that
 * quietly ignored a `deny-all` policy would run an agent unfirewalled while
 * reporting success, which is the one failure mode this file exists to prevent.
 */

/**
 * A sandbox's network egress policy.
 *
 * `allow-all` is the provisioning posture: the sandbox needs the package
 * registry, GitHub, and the model API to install the CLI. `deny-all` plus an
 * explicit allowlist is the running posture, narrowed by the provisioning step
 * immediately before the agent starts.
 */
export interface EgressPolicy {
  /** `allow-all` permits everything; `deny-all` permits only what the lists below name. */
  mode: "allow-all" | "deny-all";
  /** Hostnames the sandbox may reach, e.g. `"api.anthropic.com"` or `"*.arcade.dev"`. */
  allowDomains?: string[];
  /** CIDR blocks the sandbox may reach. */
  allowCidrs?: string[];
  /** CIDR blocks the sandbox may never reach, even if a domain resolves into one. */
  denyCidrs?: string[];
}

/** Everything a provider needs to bring a sandbox up. */
export interface CreateSandboxOptions {
  /**
   * The single provider-neutral "what to boot" slot: a runtime, a template, or
   * an image name, depending on the provider. Defaults to the provider's own.
   *
   * Filled from a project's `sandboxConfig`; `docker` spends it on an image
   * reference.
   */
  image?: string;
  /** Virtual CPUs to allocate. */
  vcpus?: number;
  /** Memory to allocate, in MiB. */
  memoryMiB?: number;
  /** Hard session deadline: the provider destroys the sandbox after this long, no matter what. */
  timeoutMs: number;
  /** Environment variables to set inside the sandbox. */
  env?: Record<string, string>;
  /** The egress policy to start with — wide enough to provision, narrowed later. */
  egress?: EgressPolicy;
  /**
   * Provider-side labels. Always carries `job` and `project` so a sandbox
   * found on the provider can be matched back to the `sandboxes` ledger — which
   * is what makes an orphan identifiable rather than merely unfamiliar.
   */
  labels?: Record<string, string>;
}

/** Options for a single command run inside a sandbox. */
export interface ExecOptions {
  /** Working directory for the command. */
  cwd?: string;
  /** Extra environment variables, merged over the sandbox's own. */
  env?: Record<string, string>;
  /** Run as a privileged user, where the provider supports it. */
  sudo?: boolean;
}

/**
 * One event from a running command. `stdout` / `stderr` carry decoded text
 * chunks, not necessarily whole lines — a consumer that needs lines must buffer.
 */
export type ExecEvent =
  | { type: "start"; pid?: string }
  | { type: "stdout"; data: string }
  | { type: "stderr"; data: string }
  | { type: "exit"; exitCode: number; durationMs?: number };

/**
 * A handle on a command running inside a sandbox.
 *
 * {@link ExecHandle.events} is an async iterable rather than a callback
 * registration: a hosted provider hands us an `AsyncGenerator` natively and Docker
 * hands us a byte stream, and an async iterable is the easiest target to adapt to from
 * both. It also composes with `AbortSignal` without inventing an unsubscribe
 * protocol.
 */
export interface ExecHandle {
  /** The provider-side command id, stable enough to {@link Sandbox.attach} to later. */
  readonly id: string;
  /**
   * Stream the command's output. Iterating twice, or iterating after a restart
   * via {@link Sandbox.attach}, replays from the beginning of what the provider
   * still retains — providers do not guarantee an exactly-once stream.
   * @param signal - Abort to stop iterating; the command keeps running.
   * @returns An async iterable of {@link ExecEvent}.
   */
  events(signal?: AbortSignal): AsyncIterable<ExecEvent>;
  /**
   * Wait for the command to exit.
   * @returns The command's exit code.
   */
  wait(): Promise<{ exitCode: number }>;
  /**
   * Signal the command.
   * @param signal - `SIGTERM` (default) or `SIGKILL`.
   */
  kill(signal?: "SIGTERM" | "SIGKILL"): Promise<void>;
}

/** One file to write into a sandbox. */
export interface FileWrite {
  /** Absolute path inside the sandbox. */
  path: string;
  /** File contents. */
  content: Buffer | string;
  /** Unix mode, e.g. `0o755` for an executable. Defaults to the provider's own. */
  mode?: number;
}

/** The result of a command run to completion. */
export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** A live sandbox. */
export interface Sandbox {
  /** The provider-side sandbox id (a container id for docker). */
  readonly id: string;
  /** The name of the provider that created it. */
  readonly provider: string;
  /** When the provider will destroy it regardless of what is running. */
  readonly expiresAt?: Date;

  /**
   * Write files into the sandbox, creating parent directories as needed.
   * Batched on purpose: one staged tree copied once beats N round trips.
   * @param files - The files to write.
   */
  writeFiles(files: FileWrite[]): Promise<void>;
  /**
   * Read a file out of the sandbox.
   * @param path - Absolute path inside the sandbox.
   * @returns The file's bytes, or `null` if it does not exist.
   */
  readFile(path: string): Promise<Buffer | null>;
  /**
   * Create a directory (and its parents) inside the sandbox.
   * @param path - Absolute path inside the sandbox.
   */
  mkdir(path: string): Promise<void>;
  /**
   * Run a command to completion, collecting its output.
   * @param cmd - The executable.
   * @param args - Its arguments.
   * @param options - Working directory, environment, privilege.
   * @returns The exit code and the collected stdout/stderr.
   */
  exec(
    cmd: string,
    args?: string[],
    options?: ExecOptions,
  ): Promise<ExecResult>;
  /**
   * Start a command in the background and return a handle on it.
   * @param cmd - The executable.
   * @param args - Its arguments.
   * @param options - Working directory, environment, privilege.
   * @returns A handle for streaming, waiting, and killing.
   */
  spawn(
    cmd: string,
    args?: string[],
    options?: ExecOptions,
  ): Promise<ExecHandle>;
  /**
   * Reattach to a command started earlier, possibly by a different process.
   * @param handleId - The id from a previous {@link ExecHandle}.
   * @returns A handle equivalent to the original.
   */
  attach(handleId: string): Promise<ExecHandle>;
  /**
   * Replace the sandbox's egress policy.
   * @param policy - The new policy.
   * @throws {TypedError} If the provider cannot honor it — see
   *   {@link ProviderCapabilities.domainEgressAllowlist}.
   */
  setEgress(policy: EgressPolicy): Promise<void>;
  /**
   * Push the sandbox's hard deadline out.
   * @param ms - The new total lifetime from creation, in milliseconds.
   */
  extendTimeout(ms: number): Promise<void>;
  /** Stop the sandbox, leaving it inspectable. */
  stop(): Promise<void>;
  /** Destroy the sandbox and release its resources. Idempotent. */
  destroy(): Promise<void>;
}

/**
 * What a provider can actually do. Callers branch on these rather than on the
 * provider's name, so adding a provider later touches only the registry.
 */
export interface ProviderCapabilities {
  /** Can enforce a `deny-all` policy with a domain allowlist. Docker cannot. */
  domainEgressAllowlist: boolean;
  /** Can change the policy of a *running* sandbox, not only at creation. */
  liveEgressUpdate: boolean;
  /** Can {@link Sandbox.attach} to a command started by another process. */
  reattach: boolean;
  /** The longest session the provider will grant. */
  maxTimeoutMs: number;
}

/**
 * The name of a registered sandbox provider. A hosted provider for
 * production joins `docker` here and in `registry.ts`.
 */
export type SandboxProviderName = "docker";

/**
 * Thrown by {@link SandboxProvider.connect} when the provider has never heard of
 * a sandbox, or has already collected it.
 *
 * A distinct class rather than a message every caller string-matches, because
 * exactly one caller needs to tell it apart from every other provider failure:
 * `destroySandbox` treats "already gone" as the outcome it was asked for, and
 * "the provider is unreachable" as an error worth reporting. Collapsing the two
 * would either fail requests that already succeeded, or quietly close ledger
 * rows during a provider outage.
 */
export class SandboxNotFoundError extends Error {
  /**
   * @param provider - The provider that was asked.
   * @param id - The provider-side id that did not resolve.
   * @param cause - The underlying error, if there was one.
   */
  constructor(provider: string, id: string, cause?: unknown) {
    super(
      `No such ${provider} sandbox: ${id}${
        cause instanceof Error ? ` (${cause.message})` : ""
      }`,
    );
    this.name = "SandboxNotFoundError";
  }
}

/** One entry in a provider-side sandbox listing. */
export interface SandboxListing {
  /** The provider-side sandbox id. */
  id: string;
  /** The provider's own status string, normalized to lowercase. */
  status: string;
  /** When the provider created it, when the provider reports it. */
  createdAt?: Date;
  /** The labels the sandbox was created with, when the provider returns them. */
  labels?: Record<string, string>;
}

/** A pluggable sandbox backend. */
export interface SandboxProvider {
  /** The registry key, and the value stored in `sandboxes.provider`. */
  readonly name: SandboxProviderName;
  /** What this provider can do — see {@link ProviderCapabilities}. */
  readonly capabilities: ProviderCapabilities;
  /**
   * Bring a new sandbox up.
   * @param options - Image, resources, deadline, environment, egress, labels.
   * @returns The live sandbox.
   */
  create(options: CreateSandboxOptions): Promise<Sandbox>;
  /**
   * Reconnect to an existing sandbox by id, without creating anything.
   * @param id - The provider-side sandbox id.
   * @returns The sandbox.
   * @throws {SandboxNotFoundError} If the provider has no such sandbox.
   */
  connect(id: string): Promise<Sandbox>;
  /**
   * List sandboxes the provider knows about, optionally filtered by label.
   *
   * This is the provider half of orphan detection: the `sandboxes` ledger says
   * what *should* exist, and this says what does. Every implementation must
   * return **only sandboxes this application created** — each provider stamps
   * its own marker at creation and filters on it here — because the orphan sweeper feeds
   * the difference between the two lists straight into a destroy loop, and
   * somebody else's sandbox has no business in it.
   * @param labels - Labels every returned sandbox must carry, on top of that marker.
   * @returns The matching sandboxes.
   */
  list(labels?: Record<string, string>): Promise<SandboxListing[]>;
}
