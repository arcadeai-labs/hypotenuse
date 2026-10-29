/**
 * Everything a command needs from the global options, resolved once: where the
 * server is, who is signed in to it, which organization and project are
 * selected, and how to print. Commands receive a {@link CliContext} instead of reading `process`.
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
import {
  type OrganizationSummary,
  onlyOne,
  type ProjectSummary,
  resolveOrganizationId,
  resolveProjectId,
} from "./api/resolve";
import { type ResolvedUrl, resolveServerUrl } from "./api/url";
import { logger } from "./output/logger";
import { getMode } from "./output/tty";
import { ExitError } from "./shutdown";

/** The program-wide options every command accepts. */
export interface GlobalOptions {
  url?: string;
  org?: string;
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
   * The selected organization's id: `--org`, then `HYPOTENUSE_ORG`, then the
   * one `hypotenuse org use` saved for this server, then — when the person is
   * in exactly one organization — that one.
   * @returns The organization id.
   * @throws {Error} When none is selected and there is none or a choice.
   */
  async organizationId(): Promise<number> {
    const saved = this.credentials.servers[this.server.origin]?.organization;
    const selector =
      this.options.org ??
      this.env.HYPOTENUSE_ORG ??
      (saved != null ? String(saved) : undefined);
    if (selector) return resolveOrganizationId(this.signedInClient(), selector);

    const { only, total } = await onlyOne<OrganizationSummary>(
      this.signedInClient(),
      "/organizations",
      "organizations",
    );
    if (only) {
      logger.info(`Using organization ${only.slug}, the only one you are in.`);
      return only.id;
    }
    throw new Error(
      total === 0
        ? "You are not in any organization yet. Create one with `hypotenuse org create`, or accept an invite."
        : "No organization selected, and you are in several. Pass --org <id|slug> or run `hypotenuse org use <id|slug>`.",
    );
  }

  /**
   * The selected project's id: `--project`, then `HYPOTENUSE_PROJECT`, then
   * the one `hypotenuse project use` saved for this server, then — when the
   * person is in exactly one project — that one.
   * @returns The project id.
   * @throws {Error} When no project is selected and there is none or a choice.
   */
  async projectId(): Promise<number> {
    const saved = this.credentials.servers[this.server.origin]?.project;
    const selector =
      this.options.project ??
      this.env.HYPOTENUSE_PROJECT ??
      (saved != null ? String(saved) : undefined);
    if (selector) return resolveProjectId(this.signedInClient(), selector);

    const { only, total } = await onlyOne<ProjectSummary>(
      this.signedInClient(),
      "/projects",
      "projects",
    );
    if (only) {
      logger.info(`Using project ${only.slug}, the only one you are in.`);
      return only.id;
    }
    throw new Error(
      total === 0
        ? "You are not in any project yet. Create one with `hypotenuse project create`, or accept an invite."
        : "No project selected, and you are in several. Pass --project <id|slug> or run `hypotenuse project use <id|slug>`.",
    );
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
    if (error instanceof ExitError) {
      if (error.message) logger.error(error.message);
      process.exitCode = error.code;
      return;
    }
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

/** The pagination envelope every list action answers. */
export interface Pagination {
  page: number;
  limit: number;
  total: number;
  pages: number;
}

/** A list action's answer: its named collection and the pagination envelope. */
export type Paginated<K extends string, T> = Record<K, T[]> & {
  pagination: Pagination;
};

/**
 * Refuse a destructive command that was not given `--yes`.
 * @param command - The running command, which declares `--yes`.
 * @param message - What to say, including how to confirm.
 * @throws {Error} Without `--yes`.
 */
export function requireYes(command: Command, message: string): void {
  if (!(command.opts() as { yes?: boolean }).yes) throw new Error(message);
}
