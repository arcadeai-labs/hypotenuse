/**
 * Everything a command needs from the global options, resolved once: where the
 * server is, who is signed in to it, which project is selected, and how to
 * print. Commands receive a {@link CliContext} instead of reading `process`.
 */
import type { Command } from "commander";
import { ApiClient, ApiError } from "./api/client";
import {
  type Credentials,
  credentialsPathFor,
  type Login,
  loadCredentials,
  type ServerEntry,
  saveCredentials,
  serverEntry,
} from "./api/credentials";
import { resolveProjectId } from "./api/resolve";
import { type ResolvedUrl, resolveServerUrl } from "./api/url";
import { logger } from "./output/logger";
import { getMode } from "./output/tty";
import { defaultConfigPath } from "./paths";

/** The program-wide options every command accepts. */
export interface GlobalOptions {
  config?: string;
  url?: string;
  project?: string;
  json?: boolean;
  verbose?: boolean;
}

/** One command invocation's resolved context. */
export class CliContext {
  private cachedCredentials?: Credentials;
  private cachedServer?: ResolvedUrl;

  /**
   * @param options - The parsed global options.
   * @param env - Environment variables.
   */
  constructor(
    readonly options: GlobalOptions,
    readonly env: Record<string, string | undefined> = process.env,
  ) {}

  /** Whether output is machine-readable JSON. */
  get json(): boolean {
    return Boolean(this.options.json) || getMode().json;
  }

  /** The credentials file this invocation reads and writes. */
  get credentialsPath(): string {
    return credentialsPathFor(this.env);
  }

  /** The daemon config file path (`-c/--config`, else the default). */
  get configPath(): string {
    return this.options.config ?? defaultConfigPath(this.env);
  }

  /** The parsed credentials file, read once. */
  get credentials(): Credentials {
    this.cachedCredentials ??= loadCredentials(this.credentialsPath);
    return this.cachedCredentials;
  }

  /** The server this invocation talks to, and why. */
  get server(): ResolvedUrl {
    this.cachedServer ??= resolveServerUrl({
      flag: this.options.url,
      env: this.env,
      credentials: this.credentials,
      configPath: this.configPath,
    });
    return this.cachedServer;
  }

  /** This server's entry in the credentials file (created in memory if absent). */
  get entry(): ServerEntry {
    return serverEntry(this.credentials, this.server.origin);
  }

  /** The operator sign-in for this server, if any. */
  get login(): Login | null {
    return this.credentials.servers[this.server.origin]?.login ?? null;
  }

  /** Persist the credentials file. */
  save(): void {
    saveCredentials(this.credentials, this.credentialsPath);
  }

  /**
   * A client for this server, carrying the sign-in when there is one.
   * @returns The client.
   */
  client(): ApiClient {
    return this.clientWith(this.login?.token);
  }

  /**
   * A client for this server carrying a specific token (or none).
   * @param token - The bearer token to send.
   * @returns The client.
   */
  clientWith(token: string | undefined): ApiClient {
    return new ApiClient(this.server.origin, token, (line) =>
      logger.debug(line),
    );
  }

  /**
   * A client that must be signed in.
   * @returns The client.
   * @throws {Error} When this server has no sign-in.
   */
  signedInClient(): ApiClient {
    if (!this.login) {
      throw new Error(
        `Not signed in to ${this.server.origin}. Run \`hypotenuse login\`.`,
      );
    }
    return this.client();
  }

  /**
   * The selected project's id: `--project`, then `HYPOTENUSE_PROJECT`, then
   * the one `hypotenuse project use` saved for this server.
   * @returns The project id.
   * @throws {Error} When no project is selected.
   */
  async projectId(): Promise<number> {
    const selector =
      this.options.project ??
      this.env.HYPOTENUSE_PROJECT ??
      (this.credentials.servers[this.server.origin]?.project != null
        ? String(this.credentials.servers[this.server.origin]?.project)
        : undefined);
    if (!selector) {
      throw new Error(
        "No project selected. Pass --project <id|slug> or run `hypotenuse project use <id|slug>`.",
      );
    }
    return resolveProjectId(this.signedInClient(), selector);
  }
}

/**
 * Build the context for a command from its own and its ancestors' options.
 * @param command - The running commander command.
 * @returns The context.
 */
export function contextFor(command: Command): CliContext {
  const options = command.optsWithGlobals() as GlobalOptions;
  logger.setVerbose(Boolean(options.verbose));
  return new CliContext(options);
}

/**
 * Run a command body: build its context, print any failure to stderr, and set
 * a non-zero exit code. A 401 says how to recover.
 * @param command - The running commander command.
 * @param fn - The body.
 */
export async function runCommand(
  command: Command,
  fn: (ctx: CliContext) => Promise<void>,
): Promise<void> {
  let ctx: CliContext | undefined;
  try {
    ctx = contextFor(command);
    await fn(ctx);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(message);
    if (
      error instanceof ApiError &&
      error.status === 401 &&
      ctx &&
      !/hypotenuse login/.test(message)
    ) {
      logger.error(
        `Run \`hypotenuse login\` to sign in to ${ctx.server.origin}.`,
      );
    }
    process.exitCode = 1;
  }
}

/**
 * Print a result: the JSON value under `--json`, else the human rendering.
 * @param ctx - The context.
 * @param value - What `--json` prints (the action's named object).
 * @param human - What a person sees.
 */
export function emit(
  ctx: CliContext,
  value: unknown,
  human: () => string,
): void {
  if (ctx.json) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    const text = human();
    if (text) console.log(text);
  }
}

/**
 * Format an epoch-ms timestamp for a table: `YYYY-MM-DD HH:MM`, local time.
 * @param ms - Epoch milliseconds, or null.
 * @returns The formatted time, or `-`.
 */
export function when(ms: number | null | undefined): string {
  if (ms == null) return "-";
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Add `--page` / `--limit` to a list command.
 * @param command - The list command.
 * @returns The same command.
 */
export function withPaging(command: Command): Command {
  return command
    .option("--page <n>", "page number, from 1")
    .option("--limit <n>", "rows per page (default 25)");
}

/**
 * The paging query a list command was given.
 * @param command - The list command.
 * @returns `{ page, limit }` with absent values left undefined.
 */
export function pageQuery(command: Command): { page?: number; limit?: number } {
  const o = command.opts() as { page?: string; limit?: string };
  return {
    page: o.page ? Number(o.page) : undefined,
    limit: o.limit ? Number(o.limit) : undefined,
  };
}

/**
 * A line under a list saying which page this is, when there is more than one.
 * @param pagination - The action's pagination envelope.
 * @returns The line, or an empty string.
 */
export function pageFooter(pagination: {
  page: number;
  pages: number;
  total: number;
}): string {
  return pagination.pages > 1
    ? `\npage ${pagination.page} of ${pagination.pages} (${pagination.total} total)`
    : "";
}

/** Re-exported for commands that throw a server refusal. */
export { ApiError };
