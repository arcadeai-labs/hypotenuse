/**
 * `hypotenuse connection` — the selected project's connections to accounts a
 * sandbox provider runs on (`connection:*`): today, a Vercel team and project.
 * The token is read from stdin, an environment variable, or a hidden prompt,
 * never from a flag's value; the server probes it before saving and never
 * returns it.
 */
import type { Command } from "commander";
import type { ApiClient } from "../api/client";
import { findInPages } from "../api/resolve";
import {
  type CliContext,
  emit,
  type Paginated,
  pageFooter,
  pageQuery,
  runCommand,
  when,
  withPaging,
} from "../context";
import { promptHidden, readAllStdin, readSecret } from "../input";
import { table } from "../output/theme";

/** A connection as the connection actions answer it. The token never is. */
export interface ProjectConnection {
  id: number;
  projectId: number;
  kind: string;
  name: string;
  config: Record<string, string>;
  lastFour: string;
  status: string;
  lastCheckedAt: number | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

/** A kind of connection, as `connection:list` describes it. */
interface ConnectionKind {
  kind: string;
  label: string;
  description: string;
  secretLabel: string;
  fields: { key: string; label: string; description: string }[];
}

/** The options that choose where a token comes from. */
interface TokenOptions {
  tokenStdin?: boolean;
  tokenEnv?: string;
}

/** The flags that fill a connection's `config`. */
export interface ConnectionConfigFlags {
  teamId?: string;
  vercelProjectId?: string;
}

/**
 * The `config` fields a command's flags give, and only those.
 * @param flags - What commander parsed.
 * @returns e.g. `{ teamId, projectId }` for a Vercel connection.
 */
export function connectionConfigFromFlags(
  flags: ConnectionConfigFlags,
): Record<string, string> {
  const config: Record<string, string> = {};
  if (flags.teamId !== undefined) config.teamId = flags.teamId;
  if (flags.vercelProjectId !== undefined) {
    config.projectId = flags.vercelProjectId;
  }
  return config;
}

/**
 * Declare the token and config options on a command.
 * @param command - `connection create` or `connection edit`.
 * @returns The same command.
 */
function withConnectionOptions(command: Command): Command {
  return command
    .option("--token-stdin", "read the account's token from standard input")
    .option(
      "--token-env <name>",
      "read the account's token from this environment variable",
    )
    .option("--team-id <id>", "the Vercel team's id (team_…)")
    .option(
      "--vercel-project-id <id>",
      "the Vercel project sandboxes belong to (prj_…)",
    );
}

/**
 * The token a command was given: from stdin, a named environment variable,
 * or a prompt that does not echo. Never from a flag's value.
 * @param ctx - The context.
 * @param options - The command's token options.
 * @returns The token.
 */
function token(ctx: CliContext, options: TokenOptions): Promise<string> {
  return readSecret({
    label: "token",
    fromStdin: options.tokenStdin,
    fromEnv: options.tokenEnv,
    env: ctx.env,
    isTTY: Boolean(process.stdin.isTTY),
    readStdin: readAllStdin,
    prompt: promptHidden,
    flags: { stdin: "--token-stdin", env: "--token-env" },
  });
}

/**
 * Resolve a connection by id, name, or kind in a project.
 * @param client - A signed-in client.
 * @param projectId - The project.
 * @param selector - An id (all digits), the connection's name, or its kind.
 * @returns The connection's id.
 * @throws {Error} When no connection matches.
 */
async function resolveProjectConnectionId(
  client: ApiClient,
  projectId: number,
  selector: string,
): Promise<number> {
  if (/^\d+$/.test(selector)) return Number(selector);
  const match = await findInPages<ProjectConnection>(
    client,
    `/project/${projectId}/connections`,
    "connections",
    (c) => c.name === selector || c.kind === selector,
  );
  if (!match) {
    throw new Error(
      `No connection named "${selector}". \`hypotenuse connection list\` lists them.`,
    );
  }
  return match.id;
}

/**
 * A connection's status as one word, with its last error when it failed.
 * @param c - The connection.
 * @returns The status line.
 */
export function connectionStatusText(
  c: Pick<ProjectConnection, "status" | "lastError">,
): string {
  return c.status === "error" && c.lastError
    ? `error: ${c.lastError}`
    : c.status;
}

/**
 * Render a connection for a person.
 * @param c - The connection.
 * @returns The lines.
 */
export function connectionDetail(c: ProjectConnection): string {
  return [
    `${c.name} (id ${c.id})`,
    `kind          ${c.kind}`,
    ...Object.entries(c.config).map(
      ([key, value]) => `${key.padEnd(13)} ${value}`,
    ),
    `token         …${c.lastFour}`,
    `status        ${connectionStatusText(c)}`,
    `checked       ${when(c.lastCheckedAt)}`,
    `created       ${when(c.createdAt)}`,
  ].join("\n");
}

/**
 * Register `connection list|view|create|edit|test|delete`.
 * @param program - The root program.
 */
export function registerConnectionCommands(program: Command): void {
  const connection = program
    .command("connection")
    .description(
      "The selected project's connections to the accounts sandbox providers run on (Vercel)",
    );

  withPaging(
    connection
      .command("list")
      .description(
        "List the project's connections, and the kinds that may be added",
      ),
  ).action(async function (this: Command) {
    await runCommand(this, async (ctx) => {
      const projectId = await ctx.projectId();
      const result = await ctx.signedInClient().request<
        Paginated<"connections", ProjectConnection> & {
          kinds: ConnectionKind[];
        }
      >("GET", `/project/${projectId}/connections`, {
        query: pageQuery(this),
      });
      emit(ctx, result, () => {
        const kinds = result.kinds
          .map(
            (k) =>
              `${k.kind} (${k.label}: ${k.fields.map((f) => f.key).join(", ")}, and a token)`,
          )
          .join("; ");
        const rows =
          result.connections.length === 0
            ? "No connections yet."
            : table(
                result.connections.map((c) => ({
                  id: c.id,
                  kind: c.kind,
                  name: c.name,
                  token: `…${c.lastFour}`,
                  status: connectionStatusText(c),
                  checked: when(c.lastCheckedAt),
                })),
                [
                  { key: "id" },
                  { key: "kind" },
                  { key: "name", maxWidth: 30 },
                  { key: "token" },
                  { key: "status", maxWidth: 50 },
                  { key: "checked" },
                ],
              ) + pageFooter(result.pagination);
        return `${rows}\nkinds: ${kinds}`;
      });
    });
  });

  connection
    .command("view")
    .description("Show a connection: its fields, token's last four, status")
    .argument("<connection>", "id, name, or kind")
    .action(async function (this: Command, selector: string) {
      await runCommand(this, async (ctx) => {
        const client = ctx.signedInClient();
        const projectId = await ctx.projectId();
        const id = await resolveProjectConnectionId(
          client,
          projectId,
          selector,
        );
        const result = await client.request<{
          connection: ProjectConnection;
        }>("GET", `/project/${projectId}/connection/${id}`);
        emit(ctx, result, () => connectionDetail(result.connection));
      });
    });

  withConnectionOptions(
    connection
      .command("create")
      .description(
        "Connect the project to a provider account (admin). The server probes it before saving; the token is read from stdin, an environment variable, or a hidden prompt",
      )
      .option("--kind <kind>", "the kind of account", "vercel")
      .option("--name <name>", "a name for the connection (default: the kind)"),
  ).action(async function (this: Command) {
    await runCommand(this, async (ctx) => {
      const o = this.opts() as TokenOptions &
        ConnectionConfigFlags & { kind: string; name?: string };
      const config = connectionConfigFromFlags(o);
      if (o.kind === "vercel" && (!config.teamId || !config.projectId)) {
        throw new Error(
          "A vercel connection needs --team-id <team_…> and --vercel-project-id <prj_…>.",
        );
      }
      const projectId = await ctx.projectId();
      const secret = await token(ctx, o);
      const result = await ctx
        .signedInClient()
        .request<{ connection: ProjectConnection }>(
          "PUT",
          `/project/${projectId}/connection`,
          { body: { kind: o.kind, name: o.name, config, token: secret } },
        );
      const c = result.connection;
      emit(
        ctx,
        result,
        () =>
          `Connected ${c.name} (id ${c.id}, token …${c.lastFour}); it answered. Choose it with \`hypotenuse project settings --sandbox-provider ${c.kind}\`.`,
      );
    });
  });

  withConnectionOptions(
    connection
      .command("edit")
      .description(
        "Rename a connection, change its fields, or replace its token (admin); a new field or token is probed first",
      )
      .argument("<connection>", "id, name, or kind")
      .option("--name <name>", "a new name"),
  ).action(async function (this: Command, selector: string) {
    await runCommand(this, async (ctx) => {
      const o = this.opts() as TokenOptions &
        ConnectionConfigFlags & { name?: string };
      const fields = connectionConfigFromFlags(o);
      const replacing = Boolean(o.tokenStdin || o.tokenEnv);
      if (
        o.name === undefined &&
        Object.keys(fields).length === 0 &&
        !replacing
      ) {
        throw new Error(
          "Nothing to change. Pass --name, --team-id, --vercel-project-id, or a new token with --token-stdin or --token-env.",
        );
      }
      const client = ctx.signedInClient();
      const projectId = await ctx.projectId();
      const id = await resolveProjectConnectionId(client, projectId, selector);
      const body: Record<string, unknown> = {};
      if (o.name !== undefined) body.name = o.name;
      if (Object.keys(fields).length > 0) {
        // The server takes the config whole: keep the fields not given.
        const current = await client.request<{
          connection: ProjectConnection;
        }>("GET", `/project/${projectId}/connection/${id}`);
        body.config = { ...current.connection.config, ...fields };
      }
      if (replacing) body.token = await token(ctx, o);
      const result = await client.request<{ connection: ProjectConnection }>(
        "POST",
        `/project/${projectId}/connection/${id}`,
        { body },
      );
      const c = result.connection;
      emit(
        ctx,
        result,
        () => `Updated ${c.name} (id ${c.id}, token …${c.lastFour})`,
      );
    });
  });

  connection
    .command("test")
    .description(
      "Probe a connection against its service (admin); exits non-zero when it fails",
    )
    .argument("<connection>", "id, name, or kind")
    .action(async function (this: Command, selector: string) {
      await runCommand(this, async (ctx) => {
        const client = ctx.signedInClient();
        const projectId = await ctx.projectId();
        const id = await resolveProjectConnectionId(
          client,
          projectId,
          selector,
        );
        const result = await client.request<{
          connection: ProjectConnection;
          message: string;
        }>("POST", `/project/${projectId}/connection/${id}/test`);
        const c = result.connection;
        emit(ctx, result, () => `${c.name}: ${c.status} — ${result.message}`);
        // The server answers a failed probe as a 200 carrying the failure.
        if (c.status !== "ok") process.exitCode = 1;
      });
    });

  connection
    .command("delete")
    .description(
      "Delete a connection and its token (admin); refused while the project's sandbox provider runs on it",
    )
    .argument("<connection>", "id, name, or kind")
    .action(async function (this: Command, selector: string) {
      await runCommand(this, async (ctx) => {
        const client = ctx.signedInClient();
        const projectId = await ctx.projectId();
        const id = await resolveProjectConnectionId(
          client,
          projectId,
          selector,
        );
        const result = await client.request<{
          connection: ProjectConnection;
        }>("DELETE", `/project/${projectId}/connection/${id}`);
        emit(ctx, result, () => `Deleted ${result.connection.name}`);
      });
    });
}
