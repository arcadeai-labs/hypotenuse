import {
  APIError,
  type Command,
  type NetworkPolicy,
  Sandbox as VercelSandbox,
} from "@vercel/sandbox";
import { api, config, ErrorType, TypedError } from "keryx";
// Type-only, purely for the `declare module "keryx"` augmentation inside.
import type {} from "../../config/sandbox";
import type {
  CreateSandboxOptions,
  EgressPolicy,
  ExecEvent,
  ExecHandle,
  ExecOptions,
  ExecResult,
  FileWrite,
  ProviderCapabilities,
  ProviderConnection,
  Sandbox,
  SandboxListing,
  SandboxProvider,
} from "../types";
import { SandboxNotFoundError } from "../types";

/**
 * The production sandbox provider: one Vercel Sandbox (a Firecracker microVM
 * on a stock runtime) per job, through `@vercel/sandbox`.
 *
 * Three properties made it the first hosted provider: the network policy of
 * a *running* sandbox can be replaced, so a job installs with the network
 * open and narrows before its agent starts; a command started by one process
 * can be found again by id from another, so a worker restart does not orphan
 * a job; and a session can run for up to a day.
 *
 * Vercel boots stock runtimes only, so nothing of ours is baked in: the
 * registry entry says `bakesRuntimeIntoImage: false`, and provisioning
 * installs bun, the coding CLI, and the GitHub CLI into each sandbox.
 *
 * The project's token is held by this instance and nowhere else. Every SDK
 * call goes through {@link VercelSandboxProvider.call} (or the sandbox's own
 * copy), which rewrites any error to a `TypedError` with the token's
 * plaintext removed, so a provider failure recorded on a job or a ledger row
 * never carries it.
 */

/** The fields of a project's Vercel connection, decrypted. */
export interface VercelCredentials {
  /** A Vercel access token with access to the team. */
  token: string;
  /** The team (`team_…`) the sandboxes are billed to. */
  teamId: string;
  /** The Vercel project (`prj_…`) the sandboxes belong to. */
  projectId: string;
}

/**
 * What Vercel Sandbox can do.
 *
 * `domainEgressAllowlist` and `liveEgressUpdate` are why it exists here: a
 * network policy is enforced by the platform outside the VM, and can be
 * replaced while the sandbox runs.
 */
export const VERCEL_CAPABILITIES: ProviderCapabilities = {
  domainEgressAllowlist: true,
  liveEgressUpdate: true,
  reattach: true,
  maxTimeoutMs: 24 * 60 * 60 * 1000,
};

/** The stock runtimes a project may boot. */
export const VERCEL_RUNTIMES = ["node24", "node22", "python3.13"] as const;

/** The runtime a project boots unless it names another. */
export const VERCEL_DEFAULT_RUNTIME = "node24";

/** The vCPUs a sandbox may be given; Vercel pairs each with 2 GiB. */
export const VERCEL_VCPU_RANGE = { min: 1, max: 8, default: 2 } as const;

/** Memory per vCPU, in MiB. */
export const VERCEL_MIB_PER_VCPU = 2048;

/** The most tags Vercel keeps on one sandbox. */
export const VERCEL_MAX_TAGS = 5;

/** The tag every sandbox this provider creates carries; `list()` filters on it. */
export const VERCEL_MANAGED_TAG = "managed";

/** Vercel's own API origin, which `SANDBOX_VERCEL_API_URL` replaces for the fake. */
const VERCEL_API_ORIGIN = "https://vercel.com/api";

/**
 * Remove a token's plaintext from a message, and any bearer credential with
 * it, so nothing a provider says about a failure carries the secret.
 * @param message - The message.
 * @param token - The token to remove.
 * @returns The message, scrubbed.
 */
export function scrubToken(message: string, token: string): string {
  let out = message;
  if (token.length >= 4) out = out.split(token).join("[redacted]");
  return out.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [redacted]");
}

/**
 * The HTTP status of an SDK error, when it has one.
 * @param e - What was thrown.
 * @returns The status, or `undefined`.
 */
function statusOf(e: unknown): number | undefined {
  return e instanceof APIError ? e.response.status : undefined;
}

/**
 * Rewrite an SDK failure as a `TypedError` that carries no token.
 * @param what - What was being done, for the message.
 * @param e - What was thrown.
 * @param token - The token to remove from it.
 * @returns The error to throw.
 */
function vercelError(what: string, e: unknown, token: string): TypedError {
  const raw = e instanceof Error ? e.message : String(e);
  const status = statusOf(e);
  const hint =
    status === 401 || status === 403
      ? " The project's Vercel token was refused; a project admin can replace it under Settings → Sandboxes."
      : "";
  return new TypedError({
    message: scrubToken(`Vercel sandbox ${what} failed: ${raw}`, token) + hint,
    type: ErrorType.CONNECTION_ACTION_RUN,
  });
}

/**
 * Translate our egress policy into Vercel's.
 * @param policy - Ours.
 * @returns Vercel's.
 */
export function toVercelNetworkPolicy(policy: EgressPolicy): NetworkPolicy {
  if (policy.mode === "allow-all") return "allow-all";
  const allow = policy.allowDomains ?? [];
  const subnets =
    policy.allowCidrs?.length || policy.denyCidrs?.length
      ? {
          subnets: {
            ...(policy.allowCidrs?.length ? { allow: policy.allowCidrs } : {}),
            ...(policy.denyCidrs?.length ? { deny: policy.denyCidrs } : {}),
          },
        }
      : {};
  if (allow.length === 0 && !("subnets" in subnets)) return "deny-all";
  return { allow, ...subnets };
}

/**
 * Whether the policy a sandbox reports is the one it was asked for, by
 * mode and domains. Vercel answers a custom policy in its older shape
 * (`mode: "custom"`, `allowedDomains`); the SDK hands either back.
 * @param asked - The policy sent.
 * @param got - The policy the sandbox reports.
 * @returns `true` when they agree.
 */
export function networkPolicyHonoured(
  asked: NetworkPolicy,
  got: unknown,
): boolean {
  if (asked === "allow-all" || asked === "deny-all") {
    if (got === asked) return true;
    return (got as { mode?: string } | undefined)?.mode === asked;
  }
  const want = [...((asked.allow as string[] | undefined) ?? [])].sort();
  const g = got as
    | { allow?: unknown; allowedDomains?: unknown; mode?: string }
    | undefined;
  if (!g || typeof g !== "object") return false;
  const have = Array.isArray(g.allow)
    ? (g.allow as string[])
    : Array.isArray(g.allowedDomains)
      ? (g.allowedDomains as string[])
      : g.allow && typeof g.allow === "object"
        ? Object.keys(g.allow)
        : [];
  return JSON.stringify([...have].sort()) === JSON.stringify(want);
}

/**
 * The SDK options every call shares: the credentials, and — when
 * `SANDBOX_VERCEL_API_URL` points at the in-process fake — a `fetch` that
 * sends Vercel's origin there instead. The SDK has no base-URL option; a
 * `fetch` it does take.
 * @param creds - The project's credentials.
 * @returns The options.
 */
function sdkOptions(creds: VercelCredentials) {
  const base = config.sandbox.vercelApiUrl.replace(/\/+$/, "");
  const options: {
    token: string;
    teamId: string;
    projectId: string;
    fetch?: typeof fetch;
  } = {
    token: creds.token,
    teamId: creds.teamId,
    projectId: creds.projectId,
  };
  if (base) {
    options.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      return fetch(url.replace(VERCEL_API_ORIGIN, base), init);
    }) as typeof fetch;
  }
  return options;
}

/** A handle on a command running in a Vercel sandbox. */
class VercelExecHandle implements ExecHandle {
  readonly id: string;
  private readonly command: Command;
  private readonly token: string;

  /**
   * @param command - The SDK's command.
   * @param token - The token errors are scrubbed of.
   */
  constructor(command: Command, token: string) {
    this.command = command;
    this.id = command.cmdId;
    this.token = token;
  }

  /**
   * Stream the command's output from its beginning, then its exit.
   * @param signal - Abort to stop iterating; the command keeps running.
   * @yields Each event.
   */
  async *events(signal?: AbortSignal): AsyncIterable<ExecEvent> {
    yield { type: "start" };
    try {
      for await (const line of this.command.logs({ signal })) {
        if (line.stream === "stdout" || line.stream === "stderr") {
          yield { type: line.stream, data: line.data };
        }
      }
      if (signal?.aborted) return;
      const done = await this.command.wait({ signal });
      yield {
        type: "exit",
        exitCode: done.exitCode,
        durationMs: done.durationMs,
      };
    } catch (e) {
      if (signal?.aborted) return;
      throw vercelError("log stream", e, this.token);
    }
  }

  /** @returns The command's exit code, once it exits. */
  async wait(): Promise<{ exitCode: number }> {
    try {
      const done = await this.command.wait();
      return { exitCode: done.exitCode };
    } catch (e) {
      throw vercelError("wait", e, this.token);
    }
  }

  /** @param signal - `SIGTERM` (default) or `SIGKILL`. */
  async kill(signal: "SIGTERM" | "SIGKILL" = "SIGTERM"): Promise<void> {
    try {
      await this.command.kill(signal);
    } catch (e) {
      // A command that already exited has nothing to kill.
      if (statusOf(e) === 404 || statusOf(e) === 409) return;
      throw vercelError("kill", e, this.token);
    }
  }
}

/** A live Vercel sandbox, presented as a {@link Sandbox}. */
class VercelSandboxImpl implements Sandbox {
  readonly id: string;
  readonly provider = "vercel";
  readonly expiresAt?: Date;
  private readonly sdk: VercelSandbox;
  private readonly token: string;

  /**
   * @param sdk - The SDK's sandbox.
   * @param token - The token errors are scrubbed of.
   */
  constructor(sdk: VercelSandbox, token: string) {
    this.sdk = sdk;
    this.id = sdk.name;
    this.token = token;
    try {
      this.expiresAt = sdk.expiresAt;
    } catch {
      this.expiresAt = undefined;
    }
  }

  /**
   * Run one SDK call, rewriting a failure without the token.
   * @param what - What it does, for the message.
   * @param fn - The call.
   * @returns Its answer.
   */
  private async call<T>(what: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      throw vercelError(what, e, this.token);
    }
  }

  /** @param files - The files to write, as one gzipped tarball. */
  async writeFiles(files: FileWrite[]): Promise<void> {
    if (files.length === 0) return;
    await this.call("writeFiles", () =>
      this.sdk.writeFiles(
        files.map((f) => ({
          path: f.path,
          content:
            typeof f.content === "string"
              ? Buffer.from(f.content, "utf8")
              : f.content,
          ...(f.mode !== undefined ? { mode: f.mode } : {}),
        })),
      ),
    );
  }

  /**
   * @param path - Absolute path inside the sandbox.
   * @returns The file's bytes, or `null` if it does not exist.
   */
  async readFile(path: string): Promise<Buffer | null> {
    return this.call("readFile", () => this.sdk.readFileToBuffer({ path }));
  }

  /** @param path - The directory to create, with its parents. */
  async mkdir(path: string): Promise<void> {
    const result = await this.exec("mkdir", ["-p", path]);
    if (result.exitCode !== 0) {
      throw new TypedError({
        message: `Could not create ${path} in sandbox ${this.id}: ${result.stderr.trim()}`,
        type: ErrorType.CONNECTION_ACTION_RUN,
      });
    }
  }

  /**
   * @param cmd - The executable.
   * @param args - Its arguments.
   * @param options - Working directory, environment, privilege.
   * @returns The exit code and collected output.
   */
  async exec(
    cmd: string,
    args: string[] = [],
    options?: ExecOptions,
  ): Promise<ExecResult> {
    return this.call("exec", async () => {
      const done = await this.sdk.runCommand({
        cmd,
        args,
        ...(options?.cwd ? { cwd: options.cwd } : {}),
        ...(options?.env ? { env: options.env } : {}),
        ...(options?.sudo ? { sudo: true } : {}),
      });
      const [stdout, stderr] = await Promise.all([
        done.stdout(),
        done.stderr(),
      ]);
      return { exitCode: done.exitCode, stdout, stderr };
    });
  }

  /**
   * @param cmd - The executable.
   * @param args - Its arguments.
   * @param options - Working directory, environment, privilege.
   * @returns A handle whose id {@link attach} finds again from any process.
   */
  async spawn(
    cmd: string,
    args: string[] = [],
    options?: ExecOptions,
  ): Promise<ExecHandle> {
    const command = await this.call("spawn", () =>
      this.sdk.runCommand({
        cmd,
        args,
        detached: true,
        ...(options?.cwd ? { cwd: options.cwd } : {}),
        ...(options?.env ? { env: options.env } : {}),
        ...(options?.sudo ? { sudo: true } : {}),
      }),
    );
    return new VercelExecHandle(command, this.token);
  }

  /**
   * @param handleId - A command id from an earlier {@link spawn}.
   * @returns A handle on it.
   */
  async attach(handleId: string): Promise<ExecHandle> {
    const command = await this.call("attach", () =>
      this.sdk.getCommand(handleId),
    );
    return new VercelExecHandle(command, this.token);
  }

  /**
   * Replace the running sandbox's network policy, and read back that the
   * platform holds it — a policy reported back as anything else throws,
   * because a job believed narrowed must be.
   * @param policy - The new policy.
   */
  async setEgress(policy: EgressPolicy): Promise<void> {
    const wanted = toVercelNetworkPolicy(policy);
    const got = await this.call("setEgress", () =>
      this.sdk.updateNetworkPolicy(wanted),
    );
    if (!networkPolicyHonoured(wanted, got)) {
      throw new TypedError({
        message: `Vercel did not apply the egress policy to sandbox ${this.id}; it reports ${JSON.stringify(got)}.`,
        type: ErrorType.CONNECTION_ACTION_RUN,
      });
    }
  }

  /**
   * Push the deadline out. Vercel extends *by* a duration; ours is the total
   * lifetime from creation, so only the difference is asked for.
   * @param ms - The new total lifetime, in milliseconds.
   */
  async extendTimeout(ms: number): Promise<void> {
    const total = Math.min(ms, VERCEL_CAPABILITIES.maxTimeoutMs);
    const current = this.sdk.timeout ?? 0;
    const delta = total - current;
    if (delta <= 0) return;
    await this.call("extendTimeout", () => this.sdk.extendTimeout(delta));
  }

  /** Stop the sandbox's session. */
  async stop(): Promise<void> {
    await this.call("stop", async () => {
      await this.sdk.stop();
    });
  }

  /** Delete the sandbox. A sandbox already gone is success. */
  async destroy(): Promise<void> {
    try {
      await this.sdk.delete();
    } catch (e) {
      if (statusOf(e) === 404 || statusOf(e) === 410) return;
      throw vercelError("destroy", e, this.token);
    }
  }
}

/** The production sandbox provider, bound to one project's Vercel account. */
export class VercelSandboxProvider implements SandboxProvider {
  readonly name = "vercel" as const;

  readonly capabilities = VERCEL_CAPABILITIES;

  private readonly creds: VercelCredentials;

  /** @param creds - The project's Vercel account. */
  constructor(creds: VercelCredentials) {
    this.creds = creds;
  }

  /**
   * Run one SDK call, rewriting a failure without the token.
   * @param what - What it does, for the message.
   * @param fn - The call.
   * @returns Its answer.
   */
  private async call<T>(what: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      throw vercelError(what, e, this.creds.token);
    }
  }

  /**
   * Create a sandbox on the project's runtime, tagged as ours, then give it
   * the `/work` every provider's sandbox has.
   * @param options - Runtime, vCPUs, deadline, environment, egress, labels.
   * @returns The live sandbox.
   * @throws {TypedError} For more labels than Vercel keeps, or a failed create.
   */
  async create(options: CreateSandboxOptions): Promise<Sandbox> {
    const tags: Record<string, string> = {
      [VERCEL_MANAGED_TAG]: config.sandbox.managedTag,
      ...(options.labels ?? {}),
    };
    if (Object.keys(tags).length > VERCEL_MAX_TAGS) {
      throw new TypedError({
        message: `A Vercel sandbox keeps at most ${VERCEL_MAX_TAGS} tags; asked for ${Object.keys(tags).join(", ")}.`,
        type: ErrorType.CONNECTION_ACTION_RUN,
      });
    }
    const runtime = options.image || VERCEL_DEFAULT_RUNTIME;
    const vcpus = options.vcpus ?? VERCEL_VCPU_RANGE.default;
    const timeout = Math.min(options.timeoutMs, this.capabilities.maxTimeoutMs);
    const sdk = await this.call("create", () =>
      VercelSandbox.create({
        ...sdkOptions(this.creds),
        runtime,
        resources: { vcpus },
        timeout,
        persistent: false,
        tags,
        ...(options.env ? { env: options.env } : {}),
        ...(options.egress
          ? { networkPolicy: toVercelNetworkPolicy(options.egress) }
          : {}),
      }),
    );
    const sandbox = new VercelSandboxImpl(sdk, this.creds.token);
    api.logger.debug("vercel sandbox created", { id: sandbox.id, timeout });
    try {
      const user = await sandbox.exec("/bin/sh", ["-c", "id -u; id -g"]);
      const [uid = "", gid = ""] = user.stdout.trim().split("\n");
      if (!/^\d+$/.test(uid) || !/^\d+$/.test(gid)) {
        throw new TypedError({
          message: `Could not read the user of sandbox ${sandbox.id}: ${user.stdout}${user.stderr}`,
          type: ErrorType.CONNECTION_ACTION_RUN,
        });
      }
      const prepared = await sandbox.exec(
        "/bin/sh",
        ["-c", `mkdir -p /work && chown ${uid}:${gid} /work`],
        { sudo: true },
      );
      if (prepared.exitCode !== 0) {
        throw new TypedError({
          message: `Could not prepare /work in sandbox ${sandbox.id}: ${prepared.stderr.trim()}`,
          type: ErrorType.CONNECTION_ACTION_RUN,
        });
      }
    } catch (e) {
      await sandbox.destroy().catch(() => {});
      throw e;
    }
    return sandbox;
  }

  /**
   * Find a sandbox by name without resuming it.
   * @param id - The sandbox's name.
   * @returns The sandbox.
   * @throws {SandboxNotFoundError} If Vercel has no such sandbox.
   */
  async connect(id: string): Promise<Sandbox> {
    try {
      const sdk = await VercelSandbox.get({
        ...sdkOptions(this.creds),
        name: id,
        resume: false,
      });
      return new VercelSandboxImpl(sdk, this.creds.token);
    } catch (e) {
      if (statusOf(e) === 404 || statusOf(e) === 410) {
        throw new SandboxNotFoundError("vercel", id);
      }
      throw vercelError("connect", e, this.creds.token);
    }
  }

  /**
   * The sandboxes in the project's Vercel project that carry our managed
   * tag — filtered by Vercel on that tag (it filters on one), then here on
   * every label asked for.
   * @param labels - Labels every returned sandbox must carry, too.
   * @returns The matching sandboxes.
   */
  async list(labels?: Record<string, string>): Promise<SandboxListing[]> {
    return this.call("list", async () => {
      const pages = await VercelSandbox.list({
        ...sdkOptions(this.creds),
        tags: { [VERCEL_MANAGED_TAG]: config.sandbox.managedTag },
      });
      const out: SandboxListing[] = [];
      for await (const s of pages) {
        const tags = s.tags ?? {};
        if (tags[VERCEL_MANAGED_TAG] !== config.sandbox.managedTag) continue;
        if (
          Object.entries(labels ?? {}).some(
            ([key, value]) => tags[key] !== value,
          )
        ) {
          continue;
        }
        const { [VERCEL_MANAGED_TAG]: _managed, ...rest } = tags;
        out.push({
          id: s.name,
          status: s.status.toLowerCase(),
          createdAt: new Date(s.createdAt),
          labels: rest,
        });
      }
      return out;
    });
  }
}

/**
 * The credentials in a project's connection, checked for shape.
 * @param connection - The decrypted connection.
 * @returns The credentials.
 * @throws {TypedError} When a field is missing.
 */
export function vercelCredentials(
  connection: ProviderConnection,
): VercelCredentials {
  const teamId = connection.config.teamId ?? "";
  const projectId = connection.config.projectId ?? "";
  if (!connection.secret || !teamId || !projectId) {
    throw new TypedError({
      message:
        "The project's Vercel connection needs a token, a team id, and a project id.",
      type: ErrorType.CONNECTION_ACTION_RUN,
    });
  }
  return { token: connection.secret, teamId, projectId };
}
