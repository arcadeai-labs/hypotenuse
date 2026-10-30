/**
 * `hypotenuse mcp-server` — the selected project's shared MCP servers
 * (`mcp-server:*`): where each is, how it authenticates, whether it answers,
 * and the tools it offers. Credentials go in through stdin, an environment
 * variable, or a hidden prompt and never come back out: the server answers
 * only header names, a bearer token's last four, and whether an OAuth server
 * is signed in.
 */
import type { Command } from "commander";
import type { ApiClient } from "../api/client";
import { resolveMcpServerId } from "../api/resolve";
import {
  type CliContext,
  emit,
  type Paginated,
  pageFooter,
  pageQuery,
  requireYes,
  runCommand,
  when,
  withPaging,
} from "../context";
import {
  collect,
  parseHeaders,
  parseNumber,
  promptHidden,
  readAllStdin,
  readSecret,
} from "../input";
import { logger } from "../output/logger";
import { table } from "../output/theme";

/** How a server authenticates. */
export const AUTH_MODES = ["none", "headers", "bearer", "oauth"] as const;

/** An MCP server as the server actions answer it. No credential ever is. */
export interface McpServer {
  id: number;
  name: string;
  url: string;
  authMode: (typeof AUTH_MODES)[number];
  headerNames: string[];
  lastFour: string | null;
  signedIn: boolean | null;
  enabled: boolean;
  timeoutMs: number | null;
  status: string;
  lastError: string | null;
  toolCount: number;
  toolsRefreshedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

/** One tool of a server's catalog, as `mcp-server:view` answers it. */
interface CatalogTool {
  name: string;
  tool: string;
  title: string | null;
  description: string | null;
  annotations: { readOnlyHint?: boolean; destructiveHint?: boolean };
}

/** What `mcp-server:test` and `mcp-server:refresh-tools` answer. */
interface ProbeResult {
  mcpServer: McpServer;
  ok: boolean;
  toolCount: number;
  error: string | null;
}

/** The credential and connection flags `add` and `edit` share. */
interface ServerFlags {
  endpoint?: string;
  auth?: string;
  header?: string[];
  headersStdin?: boolean;
  bearerStdin?: boolean;
  bearerEnv?: string;
  oauth?: boolean;
  clientId?: string;
  clientSecretStdin?: boolean;
  clientSecretEnv?: string;
  timeoutMs?: string;
}

/**
 * Declare the flags `add` and `edit` share.
 * @param command - The command.
 * @returns The same command.
 */
function withServerFlags(command: Command): Command {
  return command
    .option(
      "--auth <mode>",
      `${AUTH_MODES.join(", ")} (default: from the credential flags given)`,
    )
    .option(
      "--header <header>",
      '"Name: value", sent with every request (repeatable); put secret values through --headers-stdin',
      collect,
    )
    .option("--headers-stdin", 'read "Name: value" lines from standard input')
    .option("--bearer-stdin", "read a bearer token from standard input")
    .option(
      "--bearer-env <name>",
      "read a bearer token from this environment variable",
    )
    .option("--oauth", "sign in with OAuth (the URL to open is printed)")
    .option(
      "--client-id <id>",
      "an OAuth client registered with the server (default: registered for you)",
    )
    .option(
      "--client-secret-stdin",
      "read that OAuth client's secret from standard input",
    )
    .option(
      "--client-secret-env <name>",
      "read that OAuth client's secret from this environment variable",
    )
    .option(
      "--timeout-ms <ms>",
      "how long one tool call may take (1000-600000, default 60000)",
    );
}

/**
 * The auth mode the flags name: `--auth`, else the credential flags given.
 * @param flags - What commander parsed.
 * @returns The mode, or undefined when none is named.
 * @throws {Error} For an unknown mode or flags naming two modes.
 */
export function authModeOf(
  flags: ServerFlags,
): McpServer["authMode"] | undefined {
  const implied = new Set<McpServer["authMode"]>();
  if ((flags.header?.length ?? 0) > 0 || flags.headersStdin) {
    implied.add("headers");
  }
  if (flags.bearerStdin || flags.bearerEnv) implied.add("bearer");
  if (
    flags.oauth ||
    flags.clientId ||
    flags.clientSecretStdin ||
    flags.clientSecretEnv
  ) {
    implied.add("oauth");
  }
  if (flags.auth !== undefined) {
    if (!(AUTH_MODES as readonly string[]).includes(flags.auth)) {
      throw new Error(
        `--auth is one of ${AUTH_MODES.join(", ")}; got "${flags.auth}".`,
      );
    }
    const mode = flags.auth as McpServer["authMode"];
    const other = [...implied].find((m) => m !== mode);
    if (other) {
      throw new Error(
        `--auth ${mode} does not go with the ${other} credential flags.`,
      );
    }
    return mode;
  }
  if (implied.size > 1) {
    throw new Error(
      `Those flags name more than one way to authenticate (${[...implied].join(", ")}); a server uses one.`,
    );
  }
  return [...implied][0];
}

/**
 * Turn the shared flags into an action body, reading any secret. Only one
 * flag may read standard input.
 * @param ctx - The context.
 * @param flags - What commander parsed.
 * @returns The body's fields, with `authMode` when one was named.
 * @throws {Error} For contradictory flags, a bad number, or a missing secret.
 */
async function serverBody(
  ctx: CliContext,
  flags: ServerFlags,
): Promise<Record<string, unknown>> {
  const stdinReaders = [
    flags.headersStdin && "--headers-stdin",
    flags.bearerStdin && "--bearer-stdin",
    flags.clientSecretStdin && "--client-secret-stdin",
  ].filter(Boolean);
  if (stdinReaders.length > 1) {
    throw new Error(
      `Only one flag may read standard input; got ${stdinReaders.join(" and ")}.`,
    );
  }
  const authMode = authModeOf(flags);
  const body: Record<string, unknown> = {};
  if (authMode) body.authMode = authMode;
  if (flags.endpoint !== undefined) body.url = flags.endpoint;
  if (flags.timeoutMs !== undefined) {
    body.timeoutMs = parseNumber(flags.timeoutMs, "--timeout-ms");
  }
  const secretSources = {
    env: ctx.env,
    isTTY: Boolean(process.stdin.isTTY),
    readStdin: readAllStdin,
    prompt: promptHidden,
  };
  if (authMode === "headers") {
    const lines = [...(flags.header ?? [])];
    if (flags.headersStdin) lines.push(...(await readAllStdin()).split("\n"));
    const headers = parseHeaders(
      lines,
      flags.headersStdin ? "--headers-stdin" : "--header",
    );
    if (Object.keys(headers).length === 0) {
      throw new Error(
        'A headers server needs at least one header: --header "Name: value" or --headers-stdin.',
      );
    }
    body.headers = headers;
  }
  if (authMode === "bearer") {
    body.bearerToken = await readSecret({
      ...secretSources,
      label: "bearer token",
      fromStdin: flags.bearerStdin,
      fromEnv: flags.bearerEnv,
      flags: { stdin: "--bearer-stdin", env: "--bearer-env" },
    });
  }
  if (flags.clientId !== undefined) body.clientId = flags.clientId;
  if (flags.clientSecretStdin || flags.clientSecretEnv) {
    if (flags.clientId === undefined) {
      throw new Error("A client secret goes with --client-id.");
    }
    body.clientSecret = await readSecret({
      ...secretSources,
      label: "client secret",
      fromStdin: flags.clientSecretStdin,
      fromEnv: flags.clientSecretEnv,
      flags: { stdin: "--client-secret-stdin", env: "--client-secret-env" },
    });
  }
  return body;
}

/**
 * How a server authenticates, as a person reads it — never a credential.
 * @param s - The server.
 * @returns The rendering.
 */
export function authText(s: McpServer): string {
  switch (s.authMode) {
    case "headers":
      return `headers (${s.headerNames.join(", ")})`;
    case "bearer":
      return `bearer …${s.lastFour ?? ""}`;
    case "oauth":
      return `oauth (${s.signedIn ? "signed in" : "not signed in"})`;
    default:
      return "none";
  }
}

/**
 * A server's status as one phrase, with its last error when it failed.
 * @param s - The server.
 * @returns The status.
 */
function statusText(s: McpServer): string {
  if (!s.enabled) return "disabled";
  return s.status === "error" && s.lastError
    ? `error: ${s.lastError}`
    : s.status;
}

/**
 * Render a server for a person.
 * @param s - The server.
 * @param tools - Its catalog.
 * @returns The lines.
 */
function serverDetail(s: McpServer, tools: CatalogTool[]): string {
  const lines = [
    `${s.name} (id ${s.id})`,
    `url           ${s.url}`,
    `auth          ${authText(s)}`,
    `status        ${statusText(s)}`,
    `timeout       ${s.timeoutMs ?? 60_000} ms`,
    `tools         ${s.toolCount}, listed ${when(s.toolsRefreshedAt)}`,
    `created       ${when(s.createdAt)}`,
  ];
  if (tools.length === 0) return lines.join("\n");
  return `${lines.join("\n")}\n\n${table(
    tools.map((t) => ({
      tool: t.name,
      hints: [
        t.annotations.readOnlyHint ? "read-only" : "",
        t.annotations.destructiveHint ? "destructive" : "",
      ]
        .filter(Boolean)
        .join(" "),
      description: t.description ?? t.title ?? "",
    })),
    [{ key: "tool" }, { key: "hints" }, { key: "description", maxWidth: 60 }],
  )}`;
}

/**
 * Ask the server where an admin signs a project in to an OAuth server.
 * @param client - A signed-in client.
 * @param projectId - The project.
 * @param id - The server.
 * @returns The authorization URL.
 */
async function authorizationUrl(
  client: ApiClient,
  projectId: number,
  id: number,
): Promise<string> {
  const result = await client.request<{ authorizationUrl: string }>(
    "GET",
    `/project/${projectId}/mcp-server/${id}/oauth`,
    { query: { format: "json" } },
  );
  return result.authorizationUrl;
}

/**
 * Print a probe's outcome and exit non-zero when the server did not answer.
 * @param ctx - The context.
 * @param result - What the probe answered.
 */
function emitProbe(ctx: CliContext, result: ProbeResult): void {
  const s = result.mcpServer;
  emit(ctx, result, () =>
    result.ok
      ? `${s.name}: ok, ${result.toolCount} tools`
      : `${s.name}: ${s.status}${result.error ? ` — ${result.error}` : ""}`,
  );
  // A failed probe is a 200 carrying the failure.
  if (!result.ok) process.exitCode = 1;
}

/**
 * Register `mcp-server list|view|add|edit|test|refresh|match|sign-in|remove`.
 * @param program - The root program.
 */
export function registerMcpServerCommands(program: Command): void {
  const mcp = program
    .command("mcp-server")
    .description(
      "The selected project's shared MCP servers: list|view|add|edit|test|refresh|match|sign-in|remove",
    );

  withPaging(mcp.command("list").description("List MCP servers")).action(
    async function (this: Command) {
      await runCommand(this, async (ctx) => {
        const projectId = await ctx.projectId();
        const result = await ctx
          .signedInClient()
          .request<Paginated<"mcpServers", McpServer>>(
            "GET",
            `/project/${projectId}/mcp-servers`,
            { query: pageQuery(this) },
          );
        emit(
          ctx,
          result,
          () =>
            table(
              result.mcpServers.map((s) => ({
                id: s.id,
                name: s.name,
                url: s.url,
                auth: authText(s),
                status: s.enabled ? s.status : "disabled",
                tools: s.toolCount,
              })),
              [
                { key: "id" },
                { key: "name", maxWidth: 30 },
                { key: "url", maxWidth: 50 },
                { key: "auth", maxWidth: 30 },
                { key: "status" },
                { key: "tools" },
              ],
            ) + pageFooter(result.pagination),
        );
      });
    },
  );

  mcp
    .command("view")
    .description("Show an MCP server and the tools it offers")
    .argument("<server>", "id or name")
    .action(async function (this: Command, selector: string) {
      await runCommand(this, async (ctx) => {
        const client = ctx.signedInClient();
        const projectId = await ctx.projectId();
        const id = await resolveMcpServerId(client, projectId, selector);
        const result = await client.request<{
          mcpServer: McpServer;
          tools: CatalogTool[];
        }>("GET", `/project/${projectId}/mcp-server/${id}`);
        emit(ctx, result, () => serverDetail(result.mcpServer, result.tools));
      });
    });

  withServerFlags(
    mcp
      .command("add")
      .description(
        "Connect an MCP server (admin). Secrets are read from stdin, an environment variable, or a hidden prompt",
      )
      .argument("<name>", "lowercase letters, digits, and dashes")
      // Not --url: that global option names the Hypotenuse server itself.
      .requiredOption("--endpoint <url>", "its Streamable HTTP endpoint"),
  ).action(async function (this: Command, name: string) {
    await runCommand(this, async (ctx) => {
      const flags = this.opts() as ServerFlags;
      const projectId = await ctx.projectId();
      const body = await serverBody(ctx, flags);
      body.name = name;
      body.authMode ??= "none";
      const client = ctx.signedInClient();
      const created = await client.request<{ mcpServer: McpServer }>(
        "PUT",
        `/project/${projectId}/mcp-server`,
        { body },
      );
      const s = created.mcpServer;
      if (s.authMode === "oauth") {
        const url = await authorizationUrl(client, projectId, s.id);
        emit(ctx, { ...created, authorizationUrl: url }, () => url);
        logger.tell(
          `Added ${s.name} (id ${s.id}). Open the URL above in a browser to sign the project in; it then lists its tools.`,
        );
        return;
      }
      emit(ctx, created, () =>
        s.status === "ok"
          ? `Added ${s.name} (id ${s.id}): ${s.toolCount} tools`
          : `Added ${s.name} (id ${s.id}), but it did not answer: ${statusText(s)}`,
      );
    });
  });

  withServerFlags(
    mcp
      .command("edit")
      .description(
        "Change an MCP server (admin); only the flags given change, and new credentials reconnect it",
      )
      .argument("<server>", "id or name")
      .option("--name <name>", "a new name")
      .option("--endpoint <url>", "a new Streamable HTTP endpoint")
      .option("--default-timeout", "go back to the default timeout")
      .option("--enable", "let bots use it")
      .option("--disable", "hide it from every bot"),
  ).action(async function (this: Command, selector: string) {
    await runCommand(this, async (ctx) => {
      const flags = this.opts() as ServerFlags & {
        name?: string;
        defaultTimeout?: boolean;
        enable?: boolean;
        disable?: boolean;
      };
      if (flags.enable && flags.disable) {
        throw new Error("Pass --enable or --disable, not both.");
      }
      if (flags.timeoutMs !== undefined && flags.defaultTimeout) {
        throw new Error("Pass --timeout-ms or --default-timeout, not both.");
      }
      const body = await serverBody(ctx, flags);
      if (flags.name !== undefined) body.name = flags.name;
      if (flags.defaultTimeout) body.timeoutMs = null;
      if (flags.enable) body.enabled = true;
      if (flags.disable) body.enabled = false;
      if (Object.keys(body).length === 0) {
        throw new Error(
          "Nothing to change. `hypotenuse mcp-server edit --help` lists the flags.",
        );
      }
      const client = ctx.signedInClient();
      const projectId = await ctx.projectId();
      const id = await resolveMcpServerId(client, projectId, selector);
      const result = await client.request<{ mcpServer: McpServer }>(
        "POST",
        `/project/${projectId}/mcp-server/${id}`,
        { body },
      );
      const s = result.mcpServer;
      emit(
        ctx,
        result,
        () => `Updated ${s.name} (id ${s.id}): ${statusText(s)}`,
      );
      if (s.authMode === "oauth" && !s.signedIn) {
        logger.tell(
          `${s.name} needs a sign-in: run \`hypotenuse mcp-server sign-in ${s.name}\`.`,
        );
      }
    });
  });

  mcp
    .command("test")
    .description(
      "Connect to an MCP server now and list its tools (admin); exits non-zero when it does not answer",
    )
    .argument("<server>", "id or name")
    .action(async function (this: Command, selector: string) {
      await runCommand(this, async (ctx) => {
        const client = ctx.signedInClient();
        const projectId = await ctx.projectId();
        const id = await resolveMcpServerId(client, projectId, selector);
        emitProbe(
          ctx,
          await client.request<ProbeResult>(
            "POST",
            `/project/${projectId}/mcp-server/${id}/test`,
          ),
        );
      });
    });

  mcp
    .command("refresh")
    .description(
      "Re-list an MCP server's tools now rather than at the hourly refresh (admin)",
    )
    .argument("<server>", "id or name")
    .action(async function (this: Command, selector: string) {
      await runCommand(this, async (ctx) => {
        const client = ctx.signedInClient();
        const projectId = await ctx.projectId();
        const id = await resolveMcpServerId(client, projectId, selector);
        emitProbe(
          ctx,
          await client.request<ProbeResult>(
            "POST",
            `/project/${projectId}/mcp-server/${id}/refresh`,
          ),
        );
      });
    });

  mcp
    .command("match")
    .description(
      "Try allowlist patterns against an MCP server's tools: what each matches, and what would still ask",
    )
    .argument("<server>", "id or name")
    .requiredOption(
      "--pattern <pattern>",
      "server/tool, server/*, */tool, a tool name, or /regex/ (repeatable)",
      collect,
    )
    .action(async function (this: Command, selector: string) {
      await runCommand(this, async (ctx) => {
        const { pattern } = this.opts() as { pattern: string[] };
        const client = ctx.signedInClient();
        const projectId = await ctx.projectId();
        const id = await resolveMcpServerId(client, projectId, selector);
        const result = await client.request<{
          matches: { pattern: string; tools: string[] }[];
          gated: string[];
        }>("GET", `/project/${projectId}/mcp-server/${id}/match`, {
          query: { patterns: pattern.join("\n") },
        });
        emit(ctx, result, () =>
          [
            ...result.matches.map(
              (m) =>
                `${m.pattern}  →  ${m.tools.length ? m.tools.join(", ") : "(nothing)"}`,
            ),
            `asks          ${result.gated.length ? result.gated.join(", ") : "(nothing)"}`,
          ].join("\n"),
        );
      });
    });

  mcp
    .command("sign-in")
    .description(
      "Print the URL that signs the project in to an OAuth MCP server (admin); open it in a browser",
    )
    .argument("<server>", "id or name")
    .action(async function (this: Command, selector: string) {
      await runCommand(this, async (ctx) => {
        const client = ctx.signedInClient();
        const projectId = await ctx.projectId();
        const id = await resolveMcpServerId(client, projectId, selector);
        const url = await authorizationUrl(client, projectId, id);
        emit(ctx, { authorizationUrl: url }, () => url);
        logger.tell(
          "Open the URL above in a browser to sign the project in; the server then lists its tools.",
        );
      });
    });

  mcp
    .command("remove")
    .description(
      "Disconnect an MCP server from the project and every bot using it, deleting its credentials (admin)",
    )
    .argument("<server>", "id or name")
    .option("--yes", "confirm; required, because this cannot be undone")
    .action(async function (this: Command, selector: string) {
      await runCommand(this, async (ctx) => {
        requireYes(
          this,
          `Removing an MCP server takes it from every bot and deletes its credentials. Re-run with --yes to remove ${selector}.`,
        );
        const client = ctx.signedInClient();
        const projectId = await ctx.projectId();
        const id = await resolveMcpServerId(client, projectId, selector);
        const result = await client.request<{ mcpServer: McpServer }>(
          "DELETE",
          `/project/${projectId}/mcp-server/${id}`,
        );
        emit(ctx, result, () => `Removed ${result.mcpServer.name}`);
      });
    });
}
