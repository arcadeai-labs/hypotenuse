/**
 * `hypotenuse slack` — give a bot its own Slack app and install it:
 *
 * - `slack create` — Hypotenuse creates the app from the bot's manifest with
 *   an app configuration token (`slack:app-create`), used once and never stored;
 * - `slack connect` — the manual path: after creating the app in Slack from
 *   `installation manifest --type slack`, connect its client id and secrets
 *   (`bot-installation:connect`), or a bot token if it was installed in Slack;
 * - `slack install` — print the link a person opens to install the app into
 *   the workspace (`bot-installation:oauth-start`).
 *
 * Secrets are read from standard input, an environment variable, or a hidden
 * prompt — never from a flag's value — and the server never returns them.
 * Testing, viewing, and disconnecting are `installation test|view|disconnect`.
 */
import type { Command } from "commander";
import { resolveBotId } from "../api/resolve";
import { type CliContext, emit, runCommand } from "../context";
import { promptHidden, readAllStdin, readSecret } from "../input";
import { logger } from "../output/logger";
import { color } from "../output/theme";
import { type Installation, installationStatus } from "./installation";

/**
 * Read one secret from a named environment variable, standard input, or a
 * hidden prompt.
 * @param ctx - The context.
 * @param label - What it is, for the prompt and errors.
 * @param envFlag - The `--…-env` flag's name.
 * @param fromEnv - The environment variable it named.
 * @param stdinFlag - The `--…-stdin` flag's name, when standard input may carry it.
 * @param fromStdin - Whether that flag was given.
 * @returns The secret.
 */
function secretFrom(
  ctx: CliContext,
  label: string,
  envFlag: string,
  fromEnv: string | undefined,
  stdinFlag: string,
  fromStdin?: boolean,
): Promise<string> {
  return readSecret({
    label,
    fromStdin,
    fromEnv,
    env: ctx.env,
    isTTY: Boolean(process.stdin.isTTY),
    readStdin: readAllStdin,
    prompt: promptHidden,
    flags: { stdin: stdinFlag, env: envFlag },
  });
}

/**
 * Register `slack create|connect|install`.
 * @param program - The root program.
 */
export function registerSlackCommands(program: Command): void {
  const slack = program
    .command("slack")
    .description("A bot's own Slack app: create|connect|install");

  slack
    .command("create")
    .description(
      "Create the bot's Slack app from its manifest with an app configuration token (used once, never stored)",
    )
    .requiredOption("--bot <bot>", "the bot: id or slug")
    .option(
      "--config-token-stdin",
      "read the app configuration token (xoxe…) from standard input",
    )
    .option(
      "--config-token-env <name>",
      "read the app configuration token from this environment variable",
    )
    .option(
      "--workspace <id>",
      'a name for the workspace until the install sets it (default "default")',
    )
    .action(async function (this: Command) {
      await runCommand(this, async (ctx) => {
        const o = this.opts() as {
          bot: string;
          configTokenStdin?: boolean;
          configTokenEnv?: string;
          workspace?: string;
        };
        const client = ctx.signedInClient();
        const projectId = await ctx.projectId();
        const botId = await resolveBotId(client, projectId, o.bot);
        const configToken = await secretFrom(
          ctx,
          "app configuration token",
          "--config-token-env",
          o.configTokenEnv,
          "--config-token-stdin",
          o.configTokenStdin,
        );
        const result = await client.request<{
          installation: Installation;
          appId: string;
        }>("PUT", `/project/${projectId}/bot/${botId}/slack/app`, {
          body: { configToken, externalWorkspaceId: o.workspace },
        });
        const i = result.installation;
        emit(
          ctx,
          result,
          () =>
            `Created Slack app ${result.appId} — installation ${i.id}: ${installationStatus(i)}`,
        );
        logger.info(
          `Install it into the workspace: hypotenuse slack install ${i.id}`,
        );
      });
    });

  slack
    .command("connect")
    .description(
      "Connect a Slack app created from the manifest: its client id, client and signing secrets, and optionally a bot token",
    )
    .requiredOption("--bot <bot>", "the bot: id or slug")
    .requiredOption("--client-id <id>", "the app's Client ID (1234.5678)")
    .option("--app-id <id>", "the app's App ID (A…)")
    .option(
      "--workspace <id>",
      'the workspace the manifest was minted for (default "default")',
    )
    .option(
      "--client-secret-env <name>",
      "read the Client Secret from this environment variable",
    )
    .option(
      "--signing-secret-env <name>",
      "read the Signing Secret from this environment variable",
    )
    .option(
      "--bot-token-env <name>",
      "read a Bot User OAuth Token (xoxb-…) from this environment variable, when the app was installed in Slack",
    )
    .action(async function (this: Command) {
      await runCommand(this, async (ctx) => {
        const o = this.opts() as {
          bot: string;
          clientId: string;
          appId?: string;
          workspace?: string;
          clientSecretEnv?: string;
          signingSecretEnv?: string;
          botTokenEnv?: string;
        };
        const client = ctx.signedInClient();
        const projectId = await ctx.projectId();
        const botId = await resolveBotId(client, projectId, o.bot);
        const clientSecret = await secretFrom(
          ctx,
          "client secret",
          "--client-secret-env",
          o.clientSecretEnv,
          "--client-secret-env",
        );
        const signingSecret = await secretFrom(
          ctx,
          "signing secret",
          "--signing-secret-env",
          o.signingSecretEnv,
          "--signing-secret-env",
        );
        const botToken = o.botTokenEnv
          ? await secretFrom(
              ctx,
              "bot token",
              "--bot-token-env",
              o.botTokenEnv,
              "--bot-token-env",
            )
          : undefined;
        const result = await client.request<{ installation: Installation }>(
          "PUT",
          `/project/${projectId}/bot/${botId}/installation`,
          {
            body: {
              type: "slack",
              externalWorkspaceId: o.workspace,
              config: {
                clientId: o.clientId,
                ...(o.appId ? { appId: o.appId } : {}),
              },
              credentials: {
                clientSecret,
                signingSecret,
                ...(botToken ? { botToken } : {}),
              },
            },
          },
        );
        const i = result.installation;
        emit(
          ctx,
          result,
          () =>
            `Connected Slack installation ${i.id}: ${installationStatus(i)}`,
        );
        if (i.status === "pending") {
          logger.info(
            `Install it into the workspace: hypotenuse slack install ${i.id}`,
          );
        }
      });
    });

  slack
    .command("install")
    .description(
      "Print the link that installs a bot's Slack app into the workspace (valid ten minutes, once)",
    )
    .argument("<installation>", "the installation's id")
    .action(async function (this: Command, raw: string) {
      await runCommand(this, async (ctx) => {
        const id = Number(raw);
        if (!Number.isInteger(id) || id <= 0) {
          throw new Error(
            `An installation is named by its id (a number, from \`installation list\`); got "${raw}".`,
          );
        }
        const client = ctx.signedInClient();
        const projectId = await ctx.projectId();
        const result = await client.request<{ url: string }>(
          "GET",
          `/project/${projectId}/bot-installation/${id}/oauth?format=json`,
        );
        emit(ctx, result, () =>
          [
            "Open this link to install the app into the workspace:",
            "",
            `  ${color("accent", result.url)}`,
          ].join("\n"),
        );
        logger.tell(
          "The link works once, for ten minutes. Afterwards, check it: hypotenuse installation test " +
            String(id),
        );
      });
    });
}
