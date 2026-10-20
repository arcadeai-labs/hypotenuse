/**
 * `hypotenuse linear` — the selected project's Linear connection
 * (`linear:installation`, `linear:connect`, `linear:disconnect`).
 *
 * Connecting is a browser hop: a Linear workspace admin approves on Linear's
 * consent screen, and Linear redirects their browser back to the server. The
 * CLI only opens that page and watches the installation until it changes.
 */
import type { Command } from "commander";
import { openBrowser } from "../api/oauth";
import { emit, runCommand, when } from "../context";
import { logger } from "../output/logger";
import { dim, type GlyphName, glyph } from "../output/theme";

/** An installation as `linear:installation` serializes it. Never a token. */
export interface LinearInstallation {
  id: number;
  projectId: number;
  organizationId: string;
  organizationName: string;
  urlKey: string;
  appUserId: string;
  appUserName: string;
  scopes: string[];
  status: "active" | "revoked" | "error";
  accessTokenLastFour: string;
  accessTokenExpiresAt: number | null;
  /** When an admin last completed the install; only the callback moves it. */
  connectedAt: number;
  lastRefreshedAt: number | null;
  refreshError: string | null;
  teamIds: string[];
  rateLimit: {
    requestsLimit: number | null;
    requestsRemaining: number | null;
  } | null;
  updatedAt: number;
}

/** `linear:installation`'s answer. */
export interface InstallationResponse {
  installation: LinearInstallation | null;
  configured: boolean;
}

/** How often `connect` re-reads the installation. */
const POLL_INTERVAL_MS = 2_000;

/** How long `connect` waits by default before giving up. */
const DEFAULT_TIMEOUT_SECONDS = 300;

/** The glyph each installation status is drawn with. */
const STATUS_GLYPH: Record<LinearInstallation["status"], GlyphName> = {
  active: "online",
  error: "error",
  revoked: "offline",
};

/**
 * Whether a connect that started from `baseline` has finished: the
 * installation is active and an admin completed an install since. Read from the
 * server's `connectedAt`, which only the install callback writes — a token
 * refresh or a rate-limit snapshot moves `updatedAt` but not this — and never
 * from this machine's clock, so clock skew cannot end the wait early or never.
 * @param current - The installation now.
 * @param baseline - Its `connectedAt` when connect started, or null if none.
 * @returns True once the new connection has landed.
 */
export function connectFinished(
  current: LinearInstallation | null,
  baseline: number | null,
): boolean {
  return current?.status === "active" && current.connectedAt !== baseline;
}

/**
 * The human rendering of a project's Linear connection.
 * @param response - `linear:installation`'s answer.
 * @returns Lines for stdout.
 */
export function describeInstallation(response: InstallationResponse): string {
  const i = response.installation;
  if (!i || i.status === "revoked") {
    const lines = [
      `${glyph("offline")} Not connected to Linear. Run \`hypotenuse linear connect\` (admin).`,
    ];
    if (!response.configured) {
      lines.push(dim("This server has no Linear app configured."));
    }
    return lines.join("\n");
  }
  const limit = i.rateLimit;
  const lines = [
    `${glyph(STATUS_GLYPH[i.status])} ${i.organizationName} (${i.urlKey})  ${i.status}`,
    `app user   ${i.appUserName} (${i.appUserId})`,
    `scopes     ${i.scopes.join(", ")}`,
    `teams      ${i.teamIds.length}`,
    `token      …${i.accessTokenLastFour || "----"}, expires ${when(i.accessTokenExpiresAt)}`,
    `refreshed  ${when(i.lastRefreshedAt)}`,
  ];
  if (limit?.requestsRemaining != null) {
    lines.push(
      `rate limit ${limit.requestsRemaining}${limit.requestsLimit != null ? `/${limit.requestsLimit}` : ""} requests left`,
    );
  }
  if (i.refreshError) lines.push(`error      ${i.refreshError}`);
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
 * Register `linear status|connect|disconnect`.
 * @param program - The root program.
 */
export function registerLinearCommands(program: Command): void {
  const linear = program
    .command("linear")
    .description("The selected project's Linear workspace connection");

  linear
    .command("status")
    .description("Show which Linear workspace the project is connected to")
    .action(async function (this: Command) {
      await runCommand(this, async (ctx) => {
        const projectId = await ctx.projectId();
        const result = await ctx
          .signedInClient()
          .request<InstallationResponse>("GET", "/linear/installation", {
            query: { projectId },
          });
        emit(ctx, result, () => describeInstallation(result));
      });
    });

  linear
    .command("connect")
    .description(
      "Connect the project to a Linear workspace (admin; a Linear admin approves in a browser)",
    )
    .option("--no-browser", "print the consent URL instead of opening it")
    .option(
      "--timeout <seconds>",
      "how long to wait for the approval",
      String(DEFAULT_TIMEOUT_SECONDS),
    )
    .action(async function (this: Command) {
      await runCommand(this, async (ctx) => {
        const { browser, timeout } = this.opts() as {
          browser: boolean;
          timeout: string;
        };
        const client = ctx.signedInClient();
        const projectId = await ctx.projectId();
        const read = () =>
          client.request<InstallationResponse>("GET", "/linear/installation", {
            query: { projectId },
          });

        const baseline = (await read()).installation?.connectedAt ?? null;
        const { authorizeUrl } = await client.request<{
          authorizeUrl: string;
        }>("GET", "/linear/connect", { query: { projectId } });

        logger.tell("Approve Hypotenuse on Linear's consent screen:");
        logger.tell(authorizeUrl);
        if (browser) openBrowser(authorizeUrl);

        const spinner = logger.spinner("Waiting for a Linear admin to approve");
        const deadline = Date.now() + Number(timeout) * 1000;
        try {
          for (;;) {
            const now = await read();
            if (connectFinished(now.installation, baseline)) {
              spinner.success(
                `Connected to ${now.installation!.organizationName}`,
              );
              emit(ctx, now, () => describeInstallation(now));
              return;
            }
            if (Date.now() >= deadline) {
              throw new Error(
                "Timed out waiting for the approval. If Linear redirected to the dashboard with an error, it says why there.",
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

  linear
    .command("disconnect")
    .description(
      "Revoke the project's Linear tokens and disconnect the workspace (admin)",
    )
    .option("--yes", "do not ask for confirmation")
    .action(async function (this: Command) {
      await runCommand(this, async (ctx) => {
        const { yes } = this.opts() as { yes?: boolean };
        const client = ctx.signedInClient();
        const projectId = await ctx.projectId();
        if (!yes) {
          if (!process.stdin.isTTY || ctx.json) {
            throw new Error(
              "Disconnecting stops @hypotenuse in Linear at once. Re-run with --yes to disconnect.",
            );
          }
          if (
            !(await confirm(
              "Disconnect Linear? @hypotenuse stops answering in that workspace at once.",
            ))
          ) {
            throw new Error("Not disconnected.");
          }
        }
        const result = await client.request<{
          installation: LinearInstallation;
        }>("DELETE", "/linear/installation", { body: { projectId } });
        emit(
          ctx,
          result,
          () => `Disconnected ${result.installation.organizationName}`,
        );
      });
    });
}
