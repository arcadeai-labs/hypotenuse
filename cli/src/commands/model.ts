/**
 * `hypotenuse model` — the selected project's model connections
 * (`model-connection:*`: a provider and its key) and model aliases
 * (`model-alias:*`: the names bots use, such as `default` and `fast`).
 */
import type { Command } from "commander";
import { findInPages, resolveConnectionId } from "../api/resolve";
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
import { parseNumber, promptHidden, readAllStdin, readSecret } from "../input";
import { table } from "../output/theme";

/** The provider kinds a connection may be. */
export const PROVIDERS = [
  "anthropic",
  "openai",
  "gateway",
  "openai-compatible",
] as const;

/** What an alias's model is for: words, or memory's vectors. */
export const ALIAS_KINDS = ["language", "embedding"] as const;

/** A model connection as the connection actions answer it. The key never is. */
interface ModelConnection {
  id: number;
  name: string;
  provider: string;
  providerLabel: string;
  baseUrl: string | null;
  defaultBaseUrl: string | null;
  lastFour: string;
  status: "unverified" | "ok" | "error";
  lastCheckedAt: number | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

/** A model alias as the alias actions answer it. */
interface ModelAlias {
  id: number;
  name: string;
  kind: string;
  reserved: boolean;
  connectionId: number;
  connectionName: string;
  provider: string;
  modelId: string;
  options: {
    maxOutputTokens?: number;
    temperature?: number;
    providerOptions?: Record<string, unknown>;
  };
  createdAt: number;
  updatedAt: number;
}

/** The options that choose where an API key comes from. */
interface KeyOptions {
  apiKeyStdin?: boolean;
  apiKeyEnv?: string;
}

/**
 * Declare the API key options on a command.
 * @param command - `connection add` or `connection rotate`.
 * @returns The same command.
 */
function withKeyOptions(command: Command): Command {
  return command
    .option("--api-key-stdin", "read the API key from standard input")
    .option(
      "--api-key-env <name>",
      "read the API key from this environment variable",
    );
}

/**
 * The API key a command was given: from stdin, a named environment variable,
 * or a prompt that does not echo. Never from a flag's value.
 * @param ctx - The context.
 * @param options - The command's key options.
 * @returns The key.
 */
function apiKey(ctx: CliContext, options: KeyOptions): Promise<string> {
  return readSecret({
    label: "API key",
    fromStdin: options.apiKeyStdin,
    fromEnv: options.apiKeyEnv,
    env: ctx.env,
    isTTY: Boolean(process.stdin.isTTY),
    readStdin: readAllStdin,
    prompt: promptHidden,
  });
}

/**
 * A connection's status as one word, with its last error when it failed.
 * @param c - The connection.
 * @returns The status line.
 */
function statusText(c: ModelConnection): string {
  return c.status === "error" && c.lastError
    ? `error: ${c.lastError}`
    : c.status;
}

/**
 * Render a connection for a person.
 * @param c - The connection.
 * @returns The lines.
 */
function connectionDetail(c: ModelConnection): string {
  return [
    `${c.name} (id ${c.id})`,
    `provider      ${c.providerLabel} (${c.provider})`,
    `base URL      ${c.baseUrl ?? `${c.defaultBaseUrl ?? "-"} (default)`}`,
    `key           …${c.lastFour}`,
    `status        ${statusText(c)}`,
    `checked       ${when(c.lastCheckedAt)}`,
    `created       ${when(c.createdAt)}`,
  ].join("\n");
}

/**
 * The line under an alias list naming the required aliases that are missing.
 * @param missing - `missingRequired` from `model-alias:list`.
 * @returns The line, or an empty string.
 */
export function missingRequiredLine(missing: readonly string[]): string {
  if (missing.length === 0) return "";
  return `\nmissing: ${missing.join(", ")} — no bot can run until ${missing.length === 1 ? "it is" : "they are"} set (\`hypotenuse model alias set ${missing[0]} --connection <id> --model <modelId>\`)`;
}

/**
 * Register `model connection …` and `model alias …`.
 * @param program - The root program.
 */
export function registerModelCommands(program: Command): void {
  const model = program
    .command("model")
    .description(
      "The selected project's model connections and the aliases bots use",
    );

  const connection = model
    .command("connection")
    .description(
      "Model providers and their keys: list|view|add|edit|rotate|test|models|remove",
    );

  withPaging(
    connection.command("list").description("List model connections"),
  ).action(async function (this: Command) {
    await runCommand(this, async (ctx) => {
      const projectId = await ctx.projectId();
      const result = await ctx
        .signedInClient()
        .request<Paginated<"modelConnections", ModelConnection>>(
          "GET",
          `/project/${projectId}/model-connections`,
          { query: pageQuery(this) },
        );
      emit(
        ctx,
        result,
        () =>
          table(
            result.modelConnections.map((c) => ({
              id: c.id,
              name: c.name,
              provider: c.provider,
              key: `…${c.lastFour}`,
              status: c.status,
              checked: when(c.lastCheckedAt),
            })),
            [
              { key: "id" },
              { key: "name", maxWidth: 30 },
              { key: "provider" },
              { key: "key" },
              { key: "status" },
              { key: "checked" },
            ],
          ) + pageFooter(result.pagination),
      );
    });
  });

  connection
    .command("view")
    .description("Show a model connection")
    .argument("<connection>", "id or name")
    .action(async function (this: Command, selector: string) {
      await runCommand(this, async (ctx) => {
        const client = ctx.signedInClient();
        const projectId = await ctx.projectId();
        const id = await resolveConnectionId(client, projectId, selector);
        const result = await client.request<{
          modelConnection: ModelConnection;
        }>("GET", `/project/${projectId}/model-connection/${id}`);
        emit(ctx, result, () => connectionDetail(result.modelConnection));
      });
    });

  withKeyOptions(
    connection
      .command("add")
      .description(
        "Connect a model provider (admin). The key is read from stdin, an environment variable, or a hidden prompt",
      )
      .requiredOption("--name <name>", "a name for the connection")
      .requiredOption("--provider <kind>", `one of ${PROVIDERS.join(", ")}`)
      .option(
        "--base-url <url>",
        "the provider's base URL (required for openai-compatible)",
      ),
  ).action(async function (this: Command) {
    await runCommand(this, async (ctx) => {
      const o = this.opts() as KeyOptions & {
        name: string;
        provider: string;
        baseUrl?: string;
      };
      if (!(PROVIDERS as readonly string[]).includes(o.provider)) {
        throw new Error(
          `--provider is one of ${PROVIDERS.join(", ")}; got "${o.provider}".`,
        );
      }
      const projectId = await ctx.projectId();
      const key = await apiKey(ctx, o);
      const result = await ctx
        .signedInClient()
        .request<{ modelConnection: ModelConnection }>(
          "PUT",
          `/project/${projectId}/model-connection`,
          {
            body: {
              name: o.name,
              provider: o.provider,
              baseUrl: o.baseUrl,
              apiKey: key,
            },
          },
        );
      const c = result.modelConnection;
      emit(
        ctx,
        result,
        () =>
          `Added ${c.name} (id ${c.id}, key …${c.lastFour}). Run \`hypotenuse model connection test ${c.id}\` to check it.`,
      );
    });
  });

  connection
    .command("edit")
    .description("Rename a model connection or change its base URL (admin)")
    .argument("<connection>", "id or name")
    .option("--name <name>", "a new name")
    .option("--base-url <url>", "a new base URL")
    .option("--default-base-url", "go back to the provider's default base URL")
    .action(async function (this: Command, selector: string) {
      await runCommand(this, async (ctx) => {
        const o = this.opts() as {
          name?: string;
          baseUrl?: string;
          defaultBaseUrl?: boolean;
        };
        if (o.baseUrl && o.defaultBaseUrl) {
          throw new Error("Pass --base-url or --default-base-url, not both.");
        }
        const body: Record<string, unknown> = {};
        if (o.name !== undefined) body.name = o.name;
        if (o.baseUrl !== undefined) body.baseUrl = o.baseUrl;
        if (o.defaultBaseUrl) body.baseUrl = null;
        if (Object.keys(body).length === 0) {
          throw new Error(
            "Nothing to change. Pass --name, --base-url, or --default-base-url; `rotate` replaces the key.",
          );
        }
        const client = ctx.signedInClient();
        const projectId = await ctx.projectId();
        const id = await resolveConnectionId(client, projectId, selector);
        const result = await client.request<{
          modelConnection: ModelConnection;
        }>("POST", `/project/${projectId}/model-connection/${id}`, { body });
        emit(
          ctx,
          result,
          () => `Updated ${result.modelConnection.name} (id ${id})`,
        );
      });
    });

  withKeyOptions(
    connection
      .command("rotate")
      .description(
        "Replace a model connection's API key (admin); it reads as unverified until tested",
      )
      .argument("<connection>", "id or name"),
  ).action(async function (this: Command, selector: string) {
    await runCommand(this, async (ctx) => {
      const client = ctx.signedInClient();
      const projectId = await ctx.projectId();
      const id = await resolveConnectionId(client, projectId, selector);
      const key = await apiKey(ctx, this.opts() as KeyOptions);
      const result = await client.request<{
        modelConnection: ModelConnection;
      }>("POST", `/project/${projectId}/model-connection/${id}`, {
        body: { apiKey: key },
      });
      const c = result.modelConnection;
      emit(
        ctx,
        result,
        () => `Rotated the key of ${c.name} (id ${c.id}, now …${c.lastFour})`,
      );
    });
  });

  connection
    .command("test")
    .description(
      "Probe a model connection with its key (admin); exits non-zero when the probe fails",
    )
    .argument("<connection>", "id or name")
    .action(async function (this: Command, selector: string) {
      await runCommand(this, async (ctx) => {
        const client = ctx.signedInClient();
        const projectId = await ctx.projectId();
        const id = await resolveConnectionId(client, projectId, selector);
        const result = await client.request<{
          modelConnection: ModelConnection;
        }>("POST", `/project/${projectId}/model-connection/${id}/test`);
        const c = result.modelConnection;
        emit(ctx, result, () => `${c.name}: ${statusText(c)}`);
        // The server answers a failed probe as a 200 carrying the failure.
        if (c.status !== "ok") process.exitCode = 1;
      });
    });

  connection
    .command("models")
    .description(
      "List the models a connection's provider offers (admin), for `alias set --model`",
    )
    .argument("<connection>", "id or name")
    .action(async function (this: Command, selector: string) {
      await runCommand(this, async (ctx) => {
        const client = ctx.signedInClient();
        const projectId = await ctx.projectId();
        const id = await resolveConnectionId(client, projectId, selector);
        const result = await client.request<{
          models: { id: string; name: string | null }[];
        }>("GET", `/project/${projectId}/model-connection/${id}/models`);
        emit(ctx, result, () =>
          table(
            result.models.map((m) => ({ id: m.id, name: m.name ?? "" })),
            [{ key: "id" }, { key: "name", maxWidth: 40 }],
          ),
        );
      });
    });

  connection
    .command("remove")
    .description(
      "Delete a model connection and its key (admin); refused while an alias uses it",
    )
    .argument("<connection>", "id or name")
    .action(async function (this: Command, selector: string) {
      await runCommand(this, async (ctx) => {
        const client = ctx.signedInClient();
        const projectId = await ctx.projectId();
        const id = await resolveConnectionId(client, projectId, selector);
        const result = await client.request<{
          modelConnection: ModelConnection;
        }>("DELETE", `/project/${projectId}/model-connection/${id}`);
        emit(
          ctx,
          result,
          () => `Removed ${result.modelConnection.name} (id ${id})`,
        );
      });
    });

  const alias = model
    .command("alias")
    .description(
      "The model names bots use; default and fast are required: list|set|remove",
    );

  withPaging(
    alias
      .command("list")
      .description("List model aliases, and which required ones are missing"),
  ).action(async function (this: Command) {
    await runCommand(this, async (ctx) => {
      const projectId = await ctx.projectId();
      const result = await ctx.signedInClient().request<
        Paginated<"modelAliases", ModelAlias> & {
          missingRequired: string[];
        }
      >("GET", `/project/${projectId}/model-aliases`, {
        query: pageQuery(this),
      });
      emit(
        ctx,
        result,
        () =>
          table(
            result.modelAliases.map((a) => ({
              id: a.id,
              name: a.name,
              kind: a.kind,
              connection: a.connectionName,
              provider: a.provider,
              model: a.modelId,
              options: Object.entries(a.options)
                .filter(([k]) => k !== "providerOptions")
                .map(([k, v]) => `${k}=${v}`)
                .join(" "),
            })),
            [
              { key: "id" },
              { key: "name" },
              { key: "kind" },
              { key: "connection", maxWidth: 30 },
              { key: "provider" },
              { key: "model", maxWidth: 40 },
              { key: "options", maxWidth: 40 },
            ],
          ) +
          pageFooter(result.pagination) +
          missingRequiredLine(result.missingRequired),
      );
    });
  });

  alias
    .command("set")
    .description("Create a model alias, or change the one of that name (admin)")
    .argument("<name>", "the alias, e.g. default, fast, or reasoning")
    .option(
      "--connection <connection>",
      "the connection's id or name (required to create)",
    )
    .option("--model <modelId>", "the provider's model id (required to create)")
    .option("--max-output-tokens <n>", "the most tokens one call may produce")
    .option("--temperature <t>", "sampling temperature, 0 to 2")
    .option(
      "--kind <kind>",
      `when creating: ${ALIAS_KINDS.join(" or ")} (default language); embedding is only the alias named embedding, which memory embeds with`,
    )
    .action(async function (this: Command, name: string) {
      await runCommand(this, async (ctx) => {
        const o = this.opts() as {
          connection?: string;
          model?: string;
          maxOutputTokens?: string;
          temperature?: string;
          kind?: string;
        };
        if (
          o.kind !== undefined &&
          !(ALIAS_KINDS as readonly string[]).includes(o.kind)
        ) {
          throw new Error(
            `--kind is one of ${ALIAS_KINDS.join(", ")}; got "${o.kind}".`,
          );
        }
        const client = ctx.signedInClient();
        const projectId = await ctx.projectId();
        const options: ModelAlias["options"] = {};
        if (o.maxOutputTokens !== undefined) {
          options.maxOutputTokens = parseNumber(
            o.maxOutputTokens,
            "--max-output-tokens",
          );
        }
        if (o.temperature !== undefined) {
          options.temperature = parseNumber(o.temperature, "--temperature");
        }
        const connectionId =
          o.connection !== undefined
            ? await resolveConnectionId(client, projectId, o.connection)
            : undefined;
        const existing = await findInPages<ModelAlias>(
          client,
          `/project/${projectId}/model-aliases`,
          "modelAliases",
          (a) => a.name === name,
        );

        if (existing) {
          if (o.kind !== undefined && o.kind !== existing.kind) {
            throw new Error(
              `${name} is of kind ${existing.kind}, and an alias's kind cannot change. Remove it and set it again with --kind ${o.kind}.`,
            );
          }
          const body: Record<string, unknown> = {};
          if (connectionId !== undefined) body.connectionId = connectionId;
          if (o.model !== undefined) body.modelId = o.model;
          // An edit replaces the options object, so keep what was not named.
          if (Object.keys(options).length > 0) {
            body.options = { ...existing.options, ...options };
          }
          if (Object.keys(body).length === 0) {
            throw new Error(
              `Nothing to change on ${name}. Pass --connection, --model, --max-output-tokens, or --temperature.`,
            );
          }
          const result = await client.request<{ modelAlias: ModelAlias }>(
            "POST",
            `/project/${projectId}/model-alias/${existing.id}`,
            { body },
          );
          const a = result.modelAlias;
          emit(
            ctx,
            result,
            () => `Updated ${a.name}: ${a.connectionName} / ${a.modelId}`,
          );
          return;
        }

        if (connectionId === undefined || o.model === undefined) {
          throw new Error(
            `There is no alias named ${name} yet; creating it needs --connection and --model.`,
          );
        }
        const result = await client.request<{ modelAlias: ModelAlias }>(
          "PUT",
          `/project/${projectId}/model-alias`,
          {
            body: {
              name,
              kind: o.kind,
              connectionId,
              modelId: o.model,
              options,
            },
          },
        );
        const a = result.modelAlias;
        emit(
          ctx,
          result,
          () =>
            `Created ${a.name} (id ${a.id}): ${a.connectionName} / ${a.modelId}`,
        );
      });
    });

  alias
    .command("remove")
    .description("Delete a model alias (admin); refused while a bot names it")
    .argument("<alias>", "the alias's name or id")
    .action(async function (this: Command, selector: string) {
      await runCommand(this, async (ctx) => {
        const client = ctx.signedInClient();
        const projectId = await ctx.projectId();
        const found = await findInPages<ModelAlias>(
          client,
          `/project/${projectId}/model-aliases`,
          "modelAliases",
          (a) => a.name === selector || String(a.id) === selector,
        );
        if (!found) throw new Error(`No model alias named "${selector}"`);
        const result = await client.request<{ modelAlias: ModelAlias }>(
          "DELETE",
          `/project/${projectId}/model-alias/${found.id}`,
        );
        emit(ctx, result, () => `Removed ${result.modelAlias.name}`);
      });
    });
}
