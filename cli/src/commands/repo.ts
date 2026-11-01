/**
 * `hypotenuse repo` — the GitHub repositories a project's bots may reach:
 * attaching the deployment's GitHub App installations (`github:install-url`,
 * `github:installation-list`, `github:installation-detach`) and granting
 * repositories through them (`repository-grant:*`).
 *
 * Out of scope: `github:install-callback`, the browser hop GitHub sends a
 * person back to after installing the App — `repo install` prints the link
 * that starts it.
 */
import type { Command } from "commander";
import { resolveBotId } from "../api/resolve";
import {
  emit,
  type Paginated,
  pageFooter,
  pageQuery,
  requireYes,
  runCommand,
  when,
  withPaging,
} from "../context";
import { collect, parseNumber } from "../input";
import { logger } from "../output/logger";
import { table } from "../output/theme";

/** An attached GitHub App installation. */
interface Installation {
  id: number;
  installationId: string;
  accountLogin: string;
  accountType: string;
  permissions: Record<string, string>;
  status: string;
  createdAt: number;
}

/** A repository grant. */
export interface RepositoryGrant {
  id: number;
  githubInstallationId: number;
  accountLogin: string | null;
  fullName: string;
  push: boolean;
  branchPrefix: string | null;
  botIds: number[] | null;
  allBots: boolean;
  recommendedRuleset: Record<string, unknown> | null;
  createdAt: number;
  updatedAt: number;
}

/** A grant's create, edit, and view answer. */
interface GrantAnswer {
  repositoryGrant: RepositoryGrant;
  warnings: string[];
}

/**
 * Who a grant covers, for a person.
 * @param g - The grant.
 * @returns `every bot`, or the bot ids.
 */
function botsText(g: Pick<RepositoryGrant, "botIds">): string {
  return g.botIds === null ? "every bot" : `bots ${g.botIds.join(", ")}`;
}

/**
 * Render a grant for a person.
 * @param g - The grant.
 * @returns The text.
 */
export function grantDetail(g: RepositoryGrant): string {
  const lines = [
    `repository grant ${g.id} — ${g.fullName}`,
    `access        ${g.push ? "read and push" : "read only"}`,
    `bots          ${botsText(g)}`,
    `branch prefix ${g.branchPrefix ?? "- (jobs use hypotenuse/<bot-slug>/)"}`,
    `installation  ${g.githubInstallationId}${g.accountLogin ? ` (${g.accountLogin})` : ""}`,
    `updated       ${when(g.updatedAt)}`,
  ];
  if (g.recommendedRuleset) {
    lines.push(
      "",
      "recommended GitHub ruleset (POST /repos/<owner>/<name>/rulesets):",
      JSON.stringify(g.recommendedRuleset, null, 2),
    );
  }
  return lines.join("\n");
}

/**
 * Print a grant answer's warnings on stderr, where a person sees them.
 * @param answer - The answer.
 */
function warn(answer: GrantAnswer): void {
  for (const w of answer.warnings) logger.tell(`warning: ${w}`);
}

/**
 * Resolve `--bot` values (ids or slugs) to bot ids.
 * @param client - The signed-in client.
 * @param projectId - The project.
 * @param bots - What the person typed.
 * @returns The ids.
 */
async function botIds(
  client: Parameters<typeof resolveBotId>[0],
  projectId: number,
  bots: string[],
): Promise<number[]> {
  const ids: number[] = [];
  for (const bot of bots) ids.push(await resolveBotId(client, projectId, bot));
  return ids;
}

/**
 * Register `repo install|installations|detach|grants|grant|grant-edit|revoke|view`.
 * @param program - The root program.
 */
export function registerRepoCommands(program: Command): void {
  const repo = program
    .command("repo")
    .description(
      "GitHub repositories bots may reach: install, installations, detach, grants, grant, grant-edit, revoke, view",
    );

  repo
    .command("install")
    .description(
      "Print the link that installs the deployment's GitHub App and attaches it to the project (admin; ten minutes, once)",
    )
    .action(async function (this: Command) {
      await runCommand(this, async (ctx) => {
        const client = ctx.signedInClient();
        const projectId = await ctx.projectId();
        const result = await client.request<{
          url: string | null;
          missing: string[];
          message: string | null;
        }>("GET", `/project/${projectId}/github/install-url`);
        if (!result.url) {
          throw new Error(
            result.message ??
              `This deployment's GitHub App is not configured: set ${result.missing.join(", ")}.`,
          );
        }
        emit(ctx, result, () => result.url as string);
        logger.tell(
          "Open this link in a browser signed in to Hypotenuse within ten minutes, and install the App on the GitHub organization or account whose repositories the bots need. Then check `hypotenuse repo installations`.",
        );
      });
    });

  withPaging(
    repo
      .command("installations")
      .description("List the GitHub App installations attached to the project"),
  ).action(async function (this: Command) {
    await runCommand(this, async (ctx) => {
      const client = ctx.signedInClient();
      const projectId = await ctx.projectId();
      const result = await client.request<
        Paginated<"installations", Installation>
      >("GET", `/project/${projectId}/github/installations`, {
        query: pageQuery(this),
      });
      emit(ctx, result, () =>
        result.installations.length === 0
          ? "No GitHub installations. Attach one with `hypotenuse repo install`."
          : table(
              result.installations.map((i) => ({
                id: i.id,
                account: `${i.accountLogin} (${i.accountType})`,
                github: i.installationId,
                status: i.status,
                attached: when(i.createdAt),
              })),
              [
                { key: "id" },
                { key: "account" },
                { key: "github" },
                { key: "status" },
                { key: "attached" },
              ],
            ) + pageFooter(result.pagination),
      );
    });
  });

  repo
    .command("detach")
    .description(
      "Detach an installation; every grant made through it is deleted with it (admin)",
    )
    .argument(
      "<installationId>",
      "the installation's id, from `repo installations`",
    )
    .option("--yes", "confirm; required, because its grants go with it")
    .action(async function (this: Command, raw: string) {
      await runCommand(this, async (ctx) => {
        const id = parseNumber(raw, "<installationId>");
        requireYes(
          this,
          `Detaching deletes every repository grant made through installation ${id}. Re-run with --yes to detach it.`,
        );
        const client = ctx.signedInClient();
        const projectId = await ctx.projectId();
        const result = await client.request<{
          installation: Installation;
          removedGrants: { id: number; fullName: string }[];
        }>("DELETE", `/project/${projectId}/github/installation/${id}`);
        emit(ctx, result, () => {
          const grants = result.removedGrants.map((g) => g.fullName);
          return `Detached ${result.installation.accountLogin}${grants.length ? `; removed the grants for ${grants.join(", ")}` : ""}.`;
        });
      });
    });

  withPaging(
    repo
      .command("grants")
      .description("List the repositories the project's bots are granted"),
  ).action(async function (this: Command) {
    await runCommand(this, async (ctx) => {
      const client = ctx.signedInClient();
      const projectId = await ctx.projectId();
      const result = await client.request<
        Paginated<"repositoryGrants", RepositoryGrant>
      >("GET", `/project/${projectId}/repository-grants`, {
        query: pageQuery(this),
      });
      emit(ctx, result, () =>
        result.repositoryGrants.length === 0
          ? "No repository grants. Grant one with `hypotenuse repo grant <owner/name> --installation <id>`."
          : table(
              result.repositoryGrants.map((g) => ({
                id: g.id,
                repository: g.fullName,
                access: g.push ? "push" : "read",
                bots: botsText(g),
                prefix: g.branchPrefix ?? "-",
              })),
              [
                { key: "id" },
                { key: "repository" },
                { key: "access" },
                { key: "bots", maxWidth: 40 },
                { key: "prefix" },
              ],
            ) + pageFooter(result.pagination),
      );
    });
  });

  repo
    .command("grant")
    .description(
      "Grant the project's bots a repository through an attached installation (admin)",
    )
    .argument("<repository>", "owner/name")
    .requiredOption(
      "--installation <id>",
      "the attached installation, from `repo installations`",
    )
    .option("--push", "let jobs push branches and open pull requests")
    .option(
      "--branch-prefix <prefix>",
      "the branch namespace jobs push into (default hypotenuse/<bot-slug>/)",
    )
    .option(
      "--bot <bot>",
      "a bot that may use it (id or slug; repeat for more; default every bot)",
      collect,
    )
    .action(async function (this: Command, repository: string) {
      await runCommand(this, async (ctx) => {
        const o = this.opts() as {
          installation: string;
          push?: boolean;
          branchPrefix?: string;
          bot?: string[];
        };
        const client = ctx.signedInClient();
        const projectId = await ctx.projectId();
        const body: Record<string, unknown> = {
          githubInstallationId: parseNumber(o.installation, "--installation"),
          repository,
          push: Boolean(o.push),
        };
        if (o.branchPrefix !== undefined) body.branchPrefix = o.branchPrefix;
        if (o.bot?.length) body.botIds = await botIds(client, projectId, o.bot);
        const result = await client.request<GrantAnswer>(
          "PUT",
          `/project/${projectId}/repository-grant`,
          { body },
        );
        emit(
          ctx,
          result,
          () =>
            `Granted ${result.repositoryGrant.fullName} (${result.repositoryGrant.push ? "read and push" : "read only"}) to ${botsText(result.repositoryGrant)}; grant ${result.repositoryGrant.id}.`,
        );
        warn(result);
      });
    });

  repo
    .command("grant-edit")
    .description(
      "Change a grant: push, its branch prefix, or its bots; only the flags given change (admin)",
    )
    .argument("<grantId>", "the grant, from `repo grants`")
    .option("--push", "let jobs push")
    .option("--no-push", "read only")
    .option("--branch-prefix <prefix>", "the branch namespace jobs push into")
    .option("--no-branch-prefix", "clear the branch prefix")
    .option(
      "--bot <bot>",
      "a bot that may use it (id or slug; repeat; replaces the list)",
      collect,
    )
    .option("--all-bots", "every bot in the project may use it")
    .action(async function (this: Command, raw: string) {
      await runCommand(this, async (ctx) => {
        const id = parseNumber(raw, "<grantId>");
        const o = this.opts() as {
          push?: boolean;
          branchPrefix?: string | false;
          bot?: string[];
          allBots?: boolean;
        };
        if (o.bot?.length && o.allBots) {
          throw new Error("Pass --bot or --all-bots, not both.");
        }
        const client = ctx.signedInClient();
        const projectId = await ctx.projectId();
        const body: Record<string, unknown> = {};
        if (o.push !== undefined) body.push = o.push;
        if (o.branchPrefix === false) body.branchPrefix = null;
        else if (o.branchPrefix !== undefined) {
          body.branchPrefix = o.branchPrefix;
        }
        if (o.allBots) body.botIds = null;
        else if (o.bot?.length) {
          body.botIds = await botIds(client, projectId, o.bot);
        }
        if (Object.keys(body).length === 0) {
          throw new Error(
            "Nothing to change. `hypotenuse repo grant-edit --help` lists the flags.",
          );
        }
        const result = await client.request<GrantAnswer>(
          "POST",
          `/project/${projectId}/repository-grant/${id}`,
          { body },
        );
        emit(ctx, result, () => grantDetail(result.repositoryGrant));
        warn(result);
      });
    });

  repo
    .command("revoke")
    .description("Delete a grant: no bot can reach the repository (admin)")
    .argument("<grantId>", "the grant, from `repo grants`")
    .option("--yes", "confirm")
    .action(async function (this: Command, raw: string) {
      await runCommand(this, async (ctx) => {
        const id = parseNumber(raw, "<grantId>");
        requireYes(
          this,
          `Revoking takes the repository from every bot it was granted to. Re-run with --yes to revoke grant ${id}.`,
        );
        const client = ctx.signedInClient();
        const projectId = await ctx.projectId();
        const result = await client.request<{
          repositoryGrant: RepositoryGrant;
        }>("DELETE", `/project/${projectId}/repository-grant/${id}`);
        emit(
          ctx,
          result,
          () => `Revoked the grant for ${result.repositoryGrant.fullName}.`,
        );
      });
    });

  repo
    .command("view")
    .description(
      "Show a grant, with the GitHub ruleset that would enforce its branch prefix",
    )
    .argument("<grantId>", "the grant, from `repo grants`")
    .action(async function (this: Command, raw: string) {
      await runCommand(this, async (ctx) => {
        const id = parseNumber(raw, "<grantId>");
        const client = ctx.signedInClient();
        const projectId = await ctx.projectId();
        const result = await client.request<GrantAnswer>(
          "GET",
          `/project/${projectId}/repository-grant/${id}`,
        );
        emit(ctx, result, () => grantDetail(result.repositoryGrant));
        warn(result);
      });
    });
}
