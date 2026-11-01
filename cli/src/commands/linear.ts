/**
 * `hypotenuse linear` — give a bot its own Linear app and install it:
 *
 * - `linear link` — mint the bot's Linear installation and print the
 *   pre-filled link a workspace admin opens to create the app in Linear
 *   (`bot-installation:manifest --type linear`); the webhook URL inside is
 *   shown once;
 * - `linear connect` — connect the app's client id, client secret, and
 *   webhook signing secret (`bot-installation:connect`);
 * - `linear install` — print the link a person opens to install the app into
 *   the workspace with `actor=app` (`bot-installation:oauth-start`).
 *
 * Secrets are read from an environment variable or a hidden prompt — never
 * from a flag's value — and the server never returns them. Testing, viewing,
 * and disconnecting are `installation test|view|disconnect`.
 */
import type { Command } from "commander";
import { resolveBotId } from "../api/resolve";
import { type CliContext, emit, runCommand } from "../context";
import { promptHidden, readAllStdin, readSecret } from "../input";
import { logger } from "../output/logger";
import { color } from "../output/theme";
import { type Installation, installationStatus } from "./installation";

/**
 * Read one secret from a named environment variable, or a hidden prompt.
 * @param ctx - The context.
 * @param label - What it is, for the prompt and errors.
 * @param envFlag - The `--…-env` flag's name.
 * @param fromEnv - The environment variable it named.
 * @returns The secret.
 */
function secretFrom(
  ctx: CliContext,
  label: string,
  envFlag: string,
  fromEnv: string | undefined,
): Promise<string> {
  return readSecret({
    label,
    fromEnv,
    env: ctx.env,
    isTTY: Boolean(process.stdin.isTTY),
    readStdin: readAllStdin,
    prompt: promptHidden,
    flags: { stdin: envFlag, env: envFlag },
  });
}

/**
 * Parse an installation id argument.
 * @param raw - The argument.
 * @returns The id.
 * @throws {Error} When it is not a positive integer.
 */
function installationId(raw: string): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(
      `An installation is named by its id (a number, from \`installation list\`); got "${raw}".`,
    );
  }
  return id;
}

/**
 * Register `linear link|connect|install`.
 * @param program - The root program.
 */
export function registerLinearCommands(program: Command): void {
  const linear = program
    .command("linear")
    .description("A bot's own Linear app: link|connect|install");

  linear
    .command("link")
    .description(
      "Print the pre-filled link that creates the bot's Linear app (its webhook URL is shown once)",
    )
    .requiredOption("--bot <bot>", "the bot: id or slug")
    .action(async function (this: Command) {
      await runCommand(this, async (ctx) => {
        const o = this.opts() as { bot: string };
        const client = ctx.signedInClient();
        const projectId = await ctx.projectId();
        const botId = await resolveBotId(client, projectId, o.bot);
        const result = await client.request<{
          installation: Installation;
          urls: { events: string };
          instructions: string;
          link?: string;
          manifest: unknown;
        }>(
          "POST",
          `/project/${projectId}/bot/${botId}/installation/linear/manifest`,
          { body: {} },
        );
        const i = result.installation;
        emit(ctx, result, () =>
          [
            "A Linear workspace admin opens this link and creates the app:",
            "",
            `  ${color("accent", result.link ?? "")}`,
            "",
            `installation  ${i.id} (linear) — ${i.status}`,
            `webhook URL   ${result.urls.events}`,
            "",
            result.instructions,
          ].join("\n"),
        );
        logger.tell(
          "The webhook URL is shown once. Asking for a new link mints a new one, and the old URL stops working.",
        );
        logger.info(
          `Then connect it: hypotenuse linear connect --bot ${o.bot} --client-id <id> --client-secret-env <NAME> --webhook-secret-env <NAME>`,
        );
      });
    });

  linear
    .command("connect")
    .description(
      "Connect the bot's Linear app: its client id, client secret, and webhook signing secret",
    )
    .requiredOption("--bot <bot>", "the bot: id or slug")
    .requiredOption("--client-id <id>", "the app's Client ID")
    .option(
      "--client-secret-env <name>",
      "read the Client Secret from this environment variable",
    )
    .option(
      "--webhook-secret-env <name>",
      "read the webhook signing secret from this environment variable",
    )
    .action(async function (this: Command) {
      await runCommand(this, async (ctx) => {
        const o = this.opts() as {
          bot: string;
          clientId: string;
          clientSecretEnv?: string;
          webhookSecretEnv?: string;
        };
        const client = ctx.signedInClient();
        const projectId = await ctx.projectId();
        const botId = await resolveBotId(client, projectId, o.bot);
        const clientSecret = await secretFrom(
          ctx,
          "client secret",
          "--client-secret-env",
          o.clientSecretEnv,
        );
        const webhookSecret = await secretFrom(
          ctx,
          "webhook signing secret",
          "--webhook-secret-env",
          o.webhookSecretEnv,
        );
        const result = await client.request<{ installation: Installation }>(
          "PUT",
          `/project/${projectId}/bot/${botId}/installation`,
          {
            body: {
              type: "linear",
              config: { clientId: o.clientId },
              credentials: { clientSecret, webhookSecret },
            },
          },
        );
        const i = result.installation;
        emit(
          ctx,
          result,
          () =>
            `Connected Linear installation ${i.id}: ${installationStatus(i)}`,
        );
        if (i.status === "pending") {
          logger.info(
            `Install it into the workspace: hypotenuse linear install ${i.id}`,
          );
        }
      });
    });

  linear
    .command("install")
    .description(
      "Print the link that installs a bot's Linear app into the workspace (valid ten minutes, once)",
    )
    .argument("<installation>", "the installation's id")
    .action(async function (this: Command, raw: string) {
      await runCommand(this, async (ctx) => {
        const id = installationId(raw);
        const client = ctx.signedInClient();
        const projectId = await ctx.projectId();
        const result = await client.request<{ url: string }>(
          "GET",
          `/project/${projectId}/bot-installation/${id}/oauth?format=json`,
        );
        emit(ctx, result, () =>
          [
            "A Linear workspace admin opens this link to install the app:",
            "",
            `  ${color("accent", result.url)}`,
          ].join("\n"),
        );
        logger.tell(
          `The link works once, for ten minutes. Afterwards, check it: hypotenuse installation test ${id}`,
        );
      });
    });
}
