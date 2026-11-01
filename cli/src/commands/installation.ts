/**
 * `hypotenuse installation` — a bot's platform apps (`bot-installation:*`):
 * get the manifest and the events URL the platform delivers to, connect the
 * credentials the platform showed, test that it works, and disconnect it.
 * Credentials are read from standard input, an environment variable, or a
 * hidden prompt — never from a flag's value — and the server never returns them.
 */
import type { Command } from "commander";
import { resolveBotId } from "../api/resolve";
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
import { promptHidden, readAllStdin, readSecret } from "../input";
import { logger } from "../output/logger";
import { color, table } from "../output/theme";

/** The platform `--type` defaults to: the only one there is today. */
export const DEFAULT_PLATFORM = "webhook";

/** An installation as the installation actions answer it. Never its credentials. */
export interface Installation {
  id: number;
  projectId: number;
  botId: number;
  type: string;
  externalWorkspaceId: string;
  externalAppId: string | null;
  externalBotUserId: string | null;
  config: Record<string, unknown>;
  hasCredentials: boolean;
  credentialVersion: number;
  status: "pending" | "active" | "error" | "uninstalled";
  lastError: string | null;
  installedByUserId: number | null;
  createdAt: number;
  updatedAt: number;
}

/** What `bot-installation:manifest` answers. */
interface ManifestResult {
  installation: Installation;
  urls: { events: string; oauthRedirect: string };
  instructions: string;
  manifest: unknown;
  /** The platform's own form, pre-filled (Linear's app-creation link). */
  link?: string;
}

/** What `bot-installation:view` answers. */
interface ViewResult {
  installation: Installation;
  platform: {
    type: string;
    label: string;
    capabilities: Record<string, unknown>;
  } | null;
}

/**
 * Parse an installation id a person typed.
 * @param raw - What they typed.
 * @returns The id.
 * @throws {Error} When it is not a positive whole number.
 */
function installationId(raw: string): number {
  if (!/^\d+$/.test(raw) || Number(raw) < 1) {
    throw new Error(
      `An installation is named by its id (a number, from \`installation list\`); got "${raw}".`,
    );
  }
  return Number(raw);
}

/**
 * An installation's status as one phrase, with its last error when it failed.
 * @param i - The installation.
 * @returns The status.
 */
export function installationStatus(
  i: Pick<Installation, "status" | "lastError">,
): string {
  return i.status === "error" && i.lastError
    ? `error: ${i.lastError}`
    : i.status;
}

/**
 * Render an installation for a person.
 * @param i - The installation.
 * @param platform - Its platform's label and capabilities, when known.
 * @returns The lines.
 */
function installationDetail(
  i: Installation,
  platform?: ViewResult["platform"],
): string {
  const lines = [
    `installation ${i.id} — ${installationStatus(i)}`,
    `platform      ${platform?.label ?? i.type} (${i.type})`,
    `workspace     ${i.externalWorkspaceId}`,
    `bot user id   ${i.externalBotUserId ?? "-"}`,
    `credentials   ${i.hasCredentials ? `set (version ${i.credentialVersion})` : "not yet"}`,
  ];
  for (const [key, value] of Object.entries(i.config ?? {})) {
    lines.push(`${key.padEnd(13)} ${String(value)}`);
  }
  lines.push(`created       ${when(i.createdAt)}`);
  if (platform) {
    const can = Object.entries(platform.capabilities)
      .filter(([, v]) => v === true)
      .map(([k]) => k);
    lines.push(`can show      ${can.length ? can.join(", ") : "-"}`);
  }
  return lines.join("\n");
}

/** The flags `installation connect` reads its secret from. */
interface SecretFlags {
  signingSecretStdin?: boolean;
  signingSecretEnv?: string;
}

/**
 * The signing secret a command was given: from stdin, a named environment
 * variable, or a hidden prompt. Never from a flag's value.
 * @param ctx - The context.
 * @param flags - The command's secret flags.
 * @returns The secret.
 */
function signingSecret(ctx: CliContext, flags: SecretFlags): Promise<string> {
  return readSecret({
    label: "signing secret",
    fromStdin: flags.signingSecretStdin,
    fromEnv: flags.signingSecretEnv,
    env: ctx.env,
    isTTY: Boolean(process.stdin.isTTY),
    readStdin: readAllStdin,
    prompt: promptHidden,
    flags: { stdin: "--signing-secret-stdin", env: "--signing-secret-env" },
  });
}

/**
 * Register `installation manifest|connect|test|list|view|disconnect`.
 * @param program - The root program.
 */
export function registerInstallationCommands(program: Command): void {
  const installation = program
    .command("installation")
    .description(
      "A bot's platform apps: manifest|connect|test|list|view|disconnect",
    );

  installation
    .command("manifest")
    .description(
      "Create a pending installation and print its manifest and the events URL the platform delivers to (shown once)",
    )
    .requiredOption("--bot <bot>", "the bot: id or slug")
    .option("--type <platform>", `the platform (default ${DEFAULT_PLATFORM})`)
    .option(
      "--workspace <id>",
      'the platform workspace this app is for (default "default")',
    )
    .action(async function (this: Command) {
      await runCommand(this, async (ctx) => {
        const o = this.opts() as {
          bot: string;
          type?: string;
          workspace?: string;
        };
        const type = o.type ?? DEFAULT_PLATFORM;
        const client = ctx.signedInClient();
        const projectId = await ctx.projectId();
        const botId = await resolveBotId(client, projectId, o.bot);
        const result = await client.request<ManifestResult>(
          "POST",
          `/project/${projectId}/bot/${botId}/installation/${encodeURIComponent(type)}/manifest`,
          { body: { externalWorkspaceId: o.workspace } },
        );
        const i = result.installation;
        emit(ctx, result, () =>
          [
            "Events URL — the platform delivers here:",
            "",
            `  ${color("accent", result.urls.events)}`,
            "",
            `installation  ${i.id} (${i.type}, workspace ${i.externalWorkspaceId}) — ${i.status}`,
            "",
            result.instructions,
            ...(result.link
              ? [
                  "",
                  "Create the app here:",
                  "",
                  `  ${color("accent", result.link)}`,
                ]
              : []),
            "",
            "manifest:",
            JSON.stringify(result.manifest, null, 2),
          ].join("\n"),
        );
        logger.tell(
          "The events URL is shown once: copy it now. Asking for the manifest again mints a new one, and the old URL stops working.",
        );
        logger.info(
          `Then connect it: hypotenuse installation connect --bot ${o.bot} --type ${type} --delivery-url <url> --signing-secret-stdin`,
        );
      });
    });

  installation
    .command("connect")
    .description(
      "Give a pending installation its credentials and settings, making it active",
    )
    .requiredOption("--bot <bot>", "the bot: id or slug")
    .option("--type <platform>", `the platform (default ${DEFAULT_PLATFORM})`)
    .option(
      "--workspace <id>",
      'the workspace the manifest was minted for (default "default")',
    )
    .requiredOption(
      "--delivery-url <url>",
      "where the bot's messages are POSTed, signed with the signing secret",
    )
    .option(
      "--signing-secret-stdin",
      "read the signing secret both sides share from standard input",
    )
    .option(
      "--signing-secret-env <name>",
      "read the signing secret from this environment variable",
    )
    .option(
      "--bot-user-id <id>",
      "the bot's own user id on the platform, so it never answers itself",
    )
    .action(async function (this: Command) {
      await runCommand(this, async (ctx) => {
        const o = this.opts() as {
          bot: string;
          type?: string;
          workspace?: string;
          deliveryUrl: string;
          botUserId?: string;
        } & SecretFlags;
        const client = ctx.signedInClient();
        const projectId = await ctx.projectId();
        const botId = await resolveBotId(client, projectId, o.bot);
        const secret = await signingSecret(ctx, o);
        const result = await client.request<{ installation: Installation }>(
          "PUT",
          `/project/${projectId}/bot/${botId}/installation`,
          {
            body: {
              type: o.type ?? DEFAULT_PLATFORM,
              externalWorkspaceId: o.workspace,
              config: { deliveryUrl: o.deliveryUrl },
              credentials: { signingSecret: secret },
              botUserId: o.botUserId,
            },
          },
        );
        const i = result.installation;
        emit(
          ctx,
          result,
          () =>
            `Connected installation ${i.id} (${i.type}, workspace ${i.externalWorkspaceId}): ${installationStatus(i)}`,
        );
        logger.info(`Check it: hypotenuse installation test ${i.id}`);
      });
    });

  installation
    .command("test")
    .description(
      "Probe the platform with the installation's credentials; exits 1 when it does not work",
    )
    .argument("<installation>", "the installation's id")
    .action(async function (this: Command, raw: string) {
      await runCommand(this, async (ctx) => {
        const projectId = await ctx.projectId();
        const result = await ctx.signedInClient().request<{
          installation: Installation;
          ok: boolean;
          error: string | null;
        }>(
          "POST",
          `/project/${projectId}/bot-installation/${installationId(raw)}/test`,
        );
        const i = result.installation;
        emit(ctx, result, () =>
          result.ok
            ? `Installation ${i.id} works; the bot is ${i.externalBotUserId ?? "-"} there`
            : `Installation ${i.id} does not work: ${result.error ?? "unknown error"}`,
        );
        if (!result.ok) process.exitCode = 1;
      });
    });

  withPaging(
    installation
      .command("list")
      .description("List a bot's platform apps")
      .requiredOption("--bot <bot>", "the bot: id or slug"),
  ).action(async function (this: Command) {
    await runCommand(this, async (ctx) => {
      const o = this.opts() as { bot: string };
      const client = ctx.signedInClient();
      const projectId = await ctx.projectId();
      const botId = await resolveBotId(client, projectId, o.bot);
      const result = await client.request<
        Paginated<"installations", Installation>
      >("GET", `/project/${projectId}/bot/${botId}/installations`, {
        query: pageQuery(this),
      });
      emit(
        ctx,
        result,
        () =>
          table(
            result.installations.map((i) => ({
              id: i.id,
              platform: i.type,
              workspace: i.externalWorkspaceId,
              status: installationStatus(i),
              "bot user": i.externalBotUserId ?? "-",
              created: when(i.createdAt),
            })),
            [
              { key: "id" },
              { key: "platform" },
              { key: "workspace", maxWidth: 24 },
              { key: "status", maxWidth: 50 },
              { key: "bot user", maxWidth: 24 },
              { key: "created" },
            ],
          ) + pageFooter(result.pagination),
      );
    });
  });

  installation
    .command("view")
    .description(
      "Show an installation: platform, workspace, status, and what the platform can show",
    )
    .argument("<installation>", "the installation's id")
    .action(async function (this: Command, raw: string) {
      await runCommand(this, async (ctx) => {
        const projectId = await ctx.projectId();
        const result = await ctx
          .signedInClient()
          .request<ViewResult>(
            "GET",
            `/project/${projectId}/bot-installation/${installationId(raw)}`,
          );
        emit(ctx, result, () =>
          installationDetail(result.installation, result.platform),
        );
      });
    });

  installation
    .command("disconnect")
    .description(
      "Forget an installation's credentials and stop accepting its webhooks; its channels and conversations stay",
    )
    .argument("<installation>", "the installation's id")
    .option("--yes", "confirm; the platform's deliveries stop at once")
    .action(async function (this: Command, raw: string) {
      await runCommand(this, async (ctx) => {
        const id = installationId(raw);
        requireYes(
          this,
          `Disconnecting installation ${id} stops the platform's deliveries at once. Re-run with --yes.`,
        );
        const projectId = await ctx.projectId();
        const result = await ctx
          .signedInClient()
          .request<{ installation: Installation }>(
            "DELETE",
            `/project/${projectId}/bot-installation/${id}`,
          );
        emit(
          ctx,
          result,
          () =>
            `Disconnected installation ${id}. Remove the app on the platform too.`,
        );
      });
    });
}
