/**
 * `hypotenuse integration` — the selected project's trigger integrations
 * (`integration:list`, `integration:view`, `integration:connect`,
 * `integration:disconnect`). Linear is the only type today.
 *
 * Connecting is a browser hop: an admin of the trigger's workspace approves on
 * its consent screen, and it redirects their browser back to the server. The
 * CLI only opens that page and watches the integration until it changes.
 */
import type { Command } from "commander";
import { openBrowser } from "../api/oauth";
import {
  emit,
  pageFooter,
  pageQuery,
  runCommand,
  when,
  withPaging,
} from "../context";
import { logger } from "../output/logger";
import { dim, type GlyphName, glyph, table } from "../output/theme";

/** The trigger types this CLI knows how to describe. */
export const TRIGGER_TYPES = ["linear"] as const;

/** One of {@link TRIGGER_TYPES}. */
export type TriggerType = (typeof TRIGGER_TYPES)[number];

/** How each type is named to a person. */
const TYPE_LABEL: Record<TriggerType, string> = { linear: "Linear" };

/** An integration as `integration:view` serializes it. Never a token. */
export interface Integration {
  id: number;
  projectId: number;
  type: TriggerType;
  externalWorkspaceId: string;
  workspaceName: string;
  workspaceUrlKey: string;
  externalAppUserId: string;
  appUserName: string;
  details: {
    teamIds?: string[];
    canAccessAllPublicTeams?: boolean;
  } & Record<string, unknown>;
  scopes: string[];
  status: "active" | "revoked" | "error";
  accessTokenLastFour: string;
  accessTokenExpiresAt: number | null;
  /** When an admin last completed the install; only the callback moves it. */
  connectedAt: number;
  lastRefreshedAt: number | null;
  refreshError: string | null;
  rateLimit: {
    requestsLimit: number | null;
    requestsRemaining: number | null;
  } | null;
  updatedAt: number;
}

/** `integration:view`'s answer. */
export interface IntegrationResponse {
  integration: Integration | null;
  configured: boolean;
  /** The integration's recent webhook deliveries; absent from older servers. */
  deliveries?: {
    lastReceivedAt: number | null;
    recent: {
      id: number;
      eventType: string;
      action: string;
      outcome: string;
      error: string | null;
      receivedAt: number;
    }[];
  } | null;
}

/** How often `connect` re-reads the integration. */
const POLL_INTERVAL_MS = 2_000;

/** How long `connect` waits by default before giving up. */
const DEFAULT_TIMEOUT_SECONDS = 300;

/** The glyph each integration status is drawn with. */
const STATUS_GLYPH: Record<Integration["status"], GlyphName> = {
  active: "online",
  error: "error",
  revoked: "offline",
};

/**
 * Check a typed `<type>` argument.
 * @param raw - What was typed.
 * @returns The trigger type.
 * @throws {Error} For a type this CLI does not know.
 */
export function parseType(raw: string): TriggerType {
  const type = raw.trim().toLowerCase();
  if (!(TRIGGER_TYPES as readonly string[]).includes(type)) {
    throw new Error(
      `Unknown integration type: ${raw} (known: ${TRIGGER_TYPES.join(", ")})`,
    );
  }
  return type as TriggerType;
}

/**
 * A type's display name.
 * @param type - The trigger type.
 * @returns E.g. `Linear`.
 */
function label(type: TriggerType): string {
  return TYPE_LABEL[type] ?? type;
}

/**
 * Whether a connect that started from `baseline` has finished: the
 * integration is active and an admin completed an install since. Read from the
 * server's `connectedAt`, which only the install callback writes — a token
 * refresh or a rate-limit snapshot moves `updatedAt` but not this — and never
 * from this machine's clock, so clock skew cannot end the wait early or never.
 * @param current - The integration now.
 * @param baseline - Its `connectedAt` when connect started, or null if none.
 * @returns True once the new connection has landed.
 */
export function connectFinished(
  current: Integration | null,
  baseline: number | null,
): boolean {
  return current?.status === "active" && current.connectedAt !== baseline;
}

/**
 * The human rendering of one of a project's integrations.
 * @param type - The trigger type asked about.
 * @param response - `integration:view`'s answer.
 * @returns Lines for stdout.
 */
export function describeIntegration(
  type: TriggerType,
  response: IntegrationResponse,
): string {
  const i = response.integration;
  if (!i || i.status === "revoked") {
    const lines = [
      `${glyph("offline")} Not connected to ${label(type)}. Run \`hypotenuse integration connect ${type}\` (admin).`,
    ];
    if (!response.configured) {
      lines.push(dim(`This server has no ${label(type)} app configured.`));
    }
    return lines.join("\n");
  }
  const limit = i.rateLimit;
  const lines = [
    `${glyph(STATUS_GLYPH[i.status])} ${label(i.type)}: ${i.workspaceName} (${i.workspaceUrlKey})  ${i.status}`,
    `app user   ${i.appUserName} (${i.externalAppUserId})`,
    `scopes     ${i.scopes.join(", ")}`,
  ];
  if (Array.isArray(i.details?.teamIds)) {
    lines.push(`teams      ${i.details.teamIds.length}`);
  }
  lines.push(
    `token      …${i.accessTokenLastFour || "----"}, expires ${when(i.accessTokenExpiresAt)}`,
    `refreshed  ${when(i.lastRefreshedAt)}`,
  );
  if (limit?.requestsRemaining != null) {
    lines.push(
      `rate limit ${limit.requestsRemaining}${limit.requestsLimit != null ? `/${limit.requestsLimit}` : ""} requests left`,
    );
  }
  if (i.refreshError) lines.push(`error      ${i.refreshError}`);
  const deliveries = response.deliveries;
  if (deliveries) {
    lines.push(`webhook    last received ${when(deliveries.lastReceivedAt)}`);
    if (deliveries.recent.length > 0) {
      lines.push(
        "",
        table(
          deliveries.recent.map((d) => ({
            received: when(d.receivedAt),
            event: `${d.eventType} ${d.action}`,
            outcome: d.outcome,
            error: d.error ?? "",
          })),
          [
            { key: "received" },
            { key: "event", maxWidth: 40 },
            { key: "outcome" },
            { key: "error", maxWidth: 50 },
          ],
        ),
      );
    }
  }
  return lines.join("\n");
}

/**
 * Ask a yes/no question on the terminal.
 * @param question - The question, without the `[y/N]`.
 * @returns Whether the person answered yes.
 */
async function confirm(question: string): Promise<boolean> {
  process.stderr.write(`${question} [y/N] `);
  for await (const line of console) {
    return /^y(es)?$/i.test(line.trim());
  }
  return false;
}

/**
 * Register `integration list|view|connect|disconnect`.
 * @param program - The root program.
 */
export function registerIntegrationCommands(program: Command): void {
  const integration = program
    .command("integration")
    .description("The selected project's trigger integrations (Linear today)");

  withPaging(
    integration
      .command("list")
      .description(
        "List the project's integrations, and which types this server supports",
      ),
  ).action(async function (this: Command) {
    await runCommand(this, async (ctx) => {
      const projectId = await ctx.projectId();
      const result = await ctx.signedInClient().request<{
        integrations: Integration[];
        pagination: { page: number; pages: number; total: number };
        types: { type: TriggerType; configured: boolean }[];
      }>("GET", "/integrations", {
        query: { projectId, ...pageQuery(this) },
      });
      emit(ctx, result, () => {
        const rows = result.types.map((t) => {
          const i = result.integrations.find((x) => x.type === t.type);
          return {
            type: t.type,
            status:
              i?.status ?? (t.configured ? "not connected" : "not configured"),
            workspace: i ? `${i.workspaceName} (${i.workspaceUrlKey})` : "-",
            connected: i ? when(i.connectedAt) : "-",
          };
        });
        return (
          table(rows, [
            { key: "type" },
            { key: "status" },
            { key: "workspace", maxWidth: 40 },
            { key: "connected" },
          ]) + pageFooter(result.pagination)
        );
      });
    });
  });

  integration
    .command("view <type>")
    .description(
      "Show one integration: the workspace, the app user, token health",
    )
    .action(async function (this: Command, rawType: string) {
      await runCommand(this, async (ctx) => {
        const type = parseType(rawType);
        const projectId = await ctx.projectId();
        const result = await ctx
          .signedInClient()
          .request<IntegrationResponse>("GET", "/integration", {
            query: { projectId, type },
          });
        emit(ctx, result, () => describeIntegration(type, result));
      });
    });

  integration
    .command("connect <type>")
    .description(
      "Connect the project to a workspace (admin; a workspace admin approves in a browser)",
    )
    .option("--no-browser", "print the consent URL instead of opening it")
    .option(
      "--timeout <seconds>",
      "how long to wait for the approval",
      String(DEFAULT_TIMEOUT_SECONDS),
    )
    .action(async function (this: Command, rawType: string) {
      await runCommand(this, async (ctx) => {
        const type = parseType(rawType);
        const { browser, timeout } = this.opts() as {
          browser: boolean;
          timeout: string;
        };
        const client = ctx.signedInClient();
        const projectId = await ctx.projectId();
        const read = () =>
          client.request<IntegrationResponse>("GET", "/integration", {
            query: { projectId, type },
          });

        const baseline = (await read()).integration?.connectedAt ?? null;
        const { authorizeUrl } = await client.request<{
          authorizeUrl: string;
        }>("GET", "/integration/connect", { query: { projectId, type } });

        logger.tell(`Approve Hypotenuse on ${label(type)}'s consent screen:`);
        logger.tell(authorizeUrl);
        if (browser) openBrowser(authorizeUrl);

        const spinner = logger.spinner(
          `Waiting for a ${label(type)} admin to approve`,
        );
        const deadline = Date.now() + Number(timeout) * 1000;
        try {
          for (;;) {
            const now = await read();
            if (connectFinished(now.integration, baseline)) {
              spinner.success(`Connected to ${now.integration!.workspaceName}`);
              emit(ctx, now, () => describeIntegration(type, now));
              return;
            }
            if (Date.now() >= deadline) {
              throw new Error(
                "Timed out waiting for the approval. If the browser was sent back to the dashboard with an error, it says why there.",
              );
            }
            await Bun.sleep(POLL_INTERVAL_MS);
          }
        } catch (error) {
          spinner.stop();
          throw error;
        }
      });
    });

  integration
    .command("disconnect <type>")
    .description(
      "Revoke the project's tokens for this integration and disconnect the workspace (admin)",
    )
    .option("--yes", "do not ask for confirmation")
    .action(async function (this: Command, rawType: string) {
      await runCommand(this, async (ctx) => {
        const type = parseType(rawType);
        const { yes } = this.opts() as { yes?: boolean };
        const client = ctx.signedInClient();
        const projectId = await ctx.projectId();
        if (!yes) {
          if (!process.stdin.isTTY || ctx.json) {
            throw new Error(
              `Disconnecting stops @hypotenuse in ${label(type)} at once. Re-run with --yes to disconnect.`,
            );
          }
          if (
            !(await confirm(
              `Disconnect ${label(type)}? @hypotenuse stops answering in that workspace at once.`,
            ))
          ) {
            throw new Error("Not disconnected.");
          }
        }
        const result = await client.request<{ integration: Integration }>(
          "DELETE",
          "/integration",
          { body: { projectId, type } },
        );
        emit(
          ctx,
          result,
          () => `Disconnected ${result.integration.workspaceName}`,
        );
      });
    });
}
