/**
 * `login`, `logout`, `whoami` — signing this machine's CLI in to a server
 * through the dashboard, and out again.
 */
import { hostname } from "node:os";
import type { Command } from "commander";
import { ApiError } from "../api/client";
import { deviceSignIn, loopbackSignIn } from "../api/oauth";
import { emit, runCommand } from "../context";
import { logger } from "../output/logger";

/** A user as `me:view` answers. */
interface Me {
  id: number;
  name: string;
  email: string;
}

/**
 * Register `login`, `logout`, and `whoami`.
 * @param program - The root program.
 */
export function registerAuthCommands(program: Command): void {
  program
    .command("login")
    .description("Sign this CLI in through the dashboard in your browser")
    .option(
      "--no-browser",
      "sign in with a code typed on any device (for SSH and headless machines)",
    )
    .option("--device <name>", "the name this machine shows in the dashboard")
    .action(async function (this: Command) {
      await runCommand(this, async (ctx) => {
        const opts = this.opts() as { browser: boolean; device?: string };
        const anonymous = ctx.clientWith(undefined);
        const device = opts.device ?? hostname();
        logger.info(`Signing in to ${ctx.server.origin} as ${device}`);

        let signedIn: Awaited<ReturnType<typeof deviceSignIn>>;
        if (opts.browser) {
          const status = await anonymous.request<{ dashboardUrl?: string }>(
            "GET",
            "/status",
            { anonymous: true },
          );
          if (!status.dashboardUrl) {
            throw new Error(
              `${ctx.server.origin} did not say where its dashboard is; try \`hypotenuse login --no-browser\`.`,
            );
          }
          const spinner = logger.spinner("Waiting for approval in the browser");
          try {
            signedIn = await loopbackSignIn({
              client: anonymous,
              dashboardUrl: status.dashboardUrl,
              device,
              tell: (line) => logger.tell(line),
            });
          } finally {
            spinner.stop();
          }
        } else {
          signedIn = await deviceSignIn({
            client: anonymous,
            device,
            tell: (line) => logger.tell(line),
          });
        }

        // A sign-in replaced on this machine is revoked on the server, best
        // effort, so the Account page does not fill with dead entries.
        const previous = ctx.login;
        if (previous && previous.token !== signedIn.token) {
          await ctx
            .clientWith(previous.token)
            .request("DELETE", "/cli-token", { body: {} })
            .catch(() => {});
        }

        const { user } = await ctx
          .clientWith(signedIn.token)
          .request<{ user: Me }>("GET", "/me");

        ctx.entry.login = {
          token: signedIn.token,
          cliTokenId: signedIn.cliToken.id,
          device: signedIn.cliToken.device,
          email: user.email,
          expiresAt: signedIn.cliToken.expiresAt,
        };
        ctx.credentials.current = ctx.server.origin;
        ctx.save();

        emit(
          ctx,
          {
            server: ctx.server.origin,
            user,
            cliToken: signedIn.cliToken,
          },
          () => `Signed in to ${ctx.server.origin} as ${user.email}`,
        );
      });
    });

  program
    .command("logout")
    .description("Revoke this CLI's sign-in and forget it")
    .action(async function (this: Command) {
      await runCommand(this, async (ctx) => {
        const login = ctx.login;
        if (!login) {
          emit(
            ctx,
            { server: ctx.server.origin, revoked: false },
            () => `Not signed in to ${ctx.server.origin}`,
          );
          return;
        }
        let revoked = true;
        try {
          await ctx.client().request("DELETE", "/cli-token", { body: {} });
        } catch (error) {
          // Already revoked or expired on the server: forgetting it locally
          // is all that is left to do.
          if (!(error instanceof ApiError && error.status === 401)) throw error;
          revoked = false;
        }
        ctx.entry.login = null;
        ctx.save();
        emit(
          ctx,
          { server: ctx.server.origin, revoked },
          () => `Signed out of ${ctx.server.origin}`,
        );
      });
    });

  program
    .command("whoami")
    .description("Show who this CLI is signed in as, and where")
    .action(async function (this: Command) {
      await runCommand(this, async (ctx) => {
        const { user } = await ctx
          .signedInClient()
          .request<{ user: Me }>("GET", "/me");
        emit(
          ctx,
          { server: ctx.server.origin, user, device: ctx.login?.device },
          () =>
            [
              `${user.name} <${user.email}>`,
              `server  ${ctx.server.origin}`,
              `device  ${ctx.login?.device ?? "-"}`,
            ].join("\n"),
        );
      });
    });
}
