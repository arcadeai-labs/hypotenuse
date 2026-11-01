/**
 * `hypotenuse pylon` — put a bot on a Pylon support queue:
 *
 * - `pylon setup` — mint the bot's Pylon installation and print what a Pylon
 *   admin creates: the webhook URL (shown once), the token to create with its
 *   own identity, and the four Triggers with the body each sends
 *   (`bot-installation:manifest --type pylon`);
 * - `pylon connect` — connect the API token and the webhook secret, with the
 *   region and the token's name (`bot-installation:connect`); the server asks
 *   Pylon who the token is at once;
 * - `pylon settings` — a project admin's choices: the customer reply policy,
 *   the triggers, the listen filters, the legacy signature
 *   (`pylon:settings-edit`).
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

/** The customer reply policies the server takes. */
const POLICIES = ["never", "approve", "auto-on-low-risk"] as const;

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
 * Read an `on|off` flag.
 * @param flag - The flag's name, for the error.
 * @param raw - Its value, if given.
 * @returns The boolean, or `undefined` when not given.
 * @throws {Error} For anything but on or off.
 */
export function onOff(
  flag: string,
  raw: string | undefined,
): boolean | undefined {
  if (raw === undefined) return undefined;
  if (raw === "on") return true;
  if (raw === "off") return false;
  throw new Error(`${flag} takes on or off; got "${raw}".`);
}

/**
 * Read a comma-separated list flag.
 * @param raw - Its value, if given ("" clears it).
 * @returns The items, or `undefined` when not given.
 */
export function list(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  return [
    ...new Set(
      raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
}

/**
 * Register `pylon setup|connect|settings`.
 * @param program - The root program.
 */
export function registerPylonCommands(program: Command): void {
  const pylon = program
    .command("pylon")
    .description("A bot on a Pylon support queue: setup|connect|settings");

  pylon
    .command("setup")
    .description(
      "Print what a Pylon admin creates for the bot: a token, a webhook (its URL is shown once), and four Triggers",
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
          manifest: {
            triggers: { kickoff: string; action: string; body: string }[];
          };
        }>(
          "POST",
          `/project/${projectId}/bot/${botId}/installation/pylon/manifest`,
          { body: {} },
        );
        const i = result.installation;
        emit(ctx, result, () =>
          [
            `installation  ${i.id} (pylon) — ${i.status}`,
            `webhook URL   ${color("accent", result.urls.events)}`,
            "",
            result.instructions,
            "",
            ...result.manifest.triggers.flatMap((t, n) => [
              `${n + 1}. Trigger "${t.kickoff}" → ${t.action}, with the body:`,
              ...t.body.split("\n").map((l) => `     ${l}`),
            ]),
          ].join("\n"),
        );
        logger.tell(
          "The webhook URL is shown once. Running setup again mints a new one, and the old URL stops working.",
        );
        logger.info(
          `Then connect it: hypotenuse pylon connect --bot ${o.bot} --region us --name "<token's name>" --token-env <NAME> --webhook-secret-env <NAME>`,
        );
      });
    });

  pylon
    .command("connect")
    .description(
      "Connect the bot's Pylon API token and webhook secret; the token is checked at once",
    )
    .requiredOption("--bot <bot>", "the bot: id or slug")
    .option("--region <region>", "us or eu", "us")
    .option(
      "--name <name>",
      "the token's name in Pylon, which teammates mention the bot by",
    )
    .option(
      "--token-env <name>",
      "read the API token from this environment variable",
    )
    .option(
      "--webhook-secret-env <name>",
      "read the webhook secret from this environment variable",
    )
    .action(async function (this: Command) {
      await runCommand(this, async (ctx) => {
        const o = this.opts() as {
          bot: string;
          region: string;
          name?: string;
          tokenEnv?: string;
          webhookSecretEnv?: string;
        };
        if (o.region !== "us" && o.region !== "eu") {
          throw new Error(`--region takes us or eu; got "${o.region}".`);
        }
        const client = ctx.signedInClient();
        const projectId = await ctx.projectId();
        const botId = await resolveBotId(client, projectId, o.bot);
        const apiToken = await secretFrom(
          ctx,
          "Pylon API token",
          "--token-env",
          o.tokenEnv,
        );
        const webhookSecret = await secretFrom(
          ctx,
          "webhook secret",
          "--webhook-secret-env",
          o.webhookSecretEnv,
        );
        const result = await client.request<{ installation: Installation }>(
          "PUT",
          `/project/${projectId}/bot/${botId}/installation`,
          {
            body: {
              type: "pylon",
              config: {
                region: o.region,
                ...(o.name ? { selfName: o.name } : {}),
              },
              credentials: { apiToken, webhookSecret },
            },
          },
        );
        const i = result.installation;
        emit(
          ctx,
          result,
          () =>
            `Connected Pylon installation ${i.id}: ${installationStatus(i)}`,
        );
        if (i.status === "active") {
          logger.info(
            "It writes internal notes only. A project admin chooses whether it may reply to customers: hypotenuse pylon settings --bot <bot> --policy approve",
          );
        }
      });
    });

  pylon
    .command("settings")
    .description(
      "Change how the bot works the queue (project admins): reply policy, triggers, listen filters",
    )
    .requiredOption("--bot <bot>", "the bot: id or slug")
    .option(
      "--policy <policy>",
      "customer replies: never (notes only), approve (a person approves each), auto-on-low-risk",
    )
    .option("--auto-triage <on|off>", "start working every new issue")
    .option("--mention <on|off>", "answer notes that mention the bot")
    .option("--assignment <on|off>", "start working issues assigned to the bot")
    .option(
      "--tags <a,b>",
      'only new issues with one of these tags ("" for any)',
    )
    .option(
      "--teams <a,b>",
      'only new issues in one of these team ids ("" for any)',
    )
    .option("--name <name>", "the token's name in Pylon")
    .option(
      "--legacy-signature <on|off>",
      "also accept the legacy signature, which has no timestamp",
    )
    .action(async function (this: Command) {
      await runCommand(this, async (ctx) => {
        const o = this.opts() as {
          bot: string;
          policy?: string;
          autoTriage?: string;
          mention?: string;
          assignment?: string;
          tags?: string;
          teams?: string;
          name?: string;
          legacySignature?: string;
        };
        if (
          o.policy !== undefined &&
          !(POLICIES as readonly string[]).includes(o.policy)
        ) {
          throw new Error(
            `--policy takes ${POLICIES.join(", ")}; got "${o.policy}".`,
          );
        }
        const triggers = Object.fromEntries(
          [
            ["autoTriage", onOff("--auto-triage", o.autoTriage)],
            ["mention", onOff("--mention", o.mention)],
            ["assignment", onOff("--assignment", o.assignment)],
          ].filter(([, v]) => v !== undefined),
        );
        const listen = Object.fromEntries(
          [
            ["tags", list(o.tags)],
            ["teamIds", list(o.teams)],
          ].filter(([, v]) => v !== undefined),
        );
        const legacy = onOff("--legacy-signature", o.legacySignature);
        const body = {
          ...(o.policy ? { customerReplyPolicy: o.policy } : {}),
          ...(Object.keys(triggers).length > 0 ? { triggers } : {}),
          ...(Object.keys(listen).length > 0 ? { listen } : {}),
          ...(o.name !== undefined ? { selfName: o.name } : {}),
          ...(legacy !== undefined ? { legacySignature: legacy } : {}),
        };
        if (Object.keys(body).length === 0) {
          throw new Error(
            "Name something to change: --policy, --auto-triage, --mention, --assignment, --tags, --teams, --name, or --legacy-signature.",
          );
        }
        const client = ctx.signedInClient();
        const projectId = await ctx.projectId();
        const botId = await resolveBotId(client, projectId, o.bot);
        const result = await client.request<{
          installation: Installation & { config: Record<string, unknown> };
        }>("POST", `/project/${projectId}/bot/${botId}/pylon/settings`, {
          body,
        });
        const c = result.installation.config;
        const t = (c.triggers ?? {}) as Record<string, boolean>;
        const l = (c.listen ?? {}) as { tags?: string[]; teamIds?: string[] };
        emit(ctx, result, () =>
          [
            `customer replies  ${String(c.customerReplyPolicy)}`,
            `triggers          auto-triage ${t.autoTriage ? "on" : "off"}, mention ${t.mention ? "on" : "off"}, assignment ${t.assignment ? "on" : "off"}`,
            `listens to        tags: ${l.tags?.length ? l.tags.join(", ") : "any"}; teams: ${l.teamIds?.length ? l.teamIds.join(", ") : "any"}`,
          ].join("\n"),
        );
      });
    });
}
