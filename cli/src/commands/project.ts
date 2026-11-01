/**
 * `hypotenuse project` — the caller's projects (`project:*`), and which one
 * later commands act on.
 */
import type { Command } from "commander";
import {
  type ProjectSummary,
  resolveOrganizationId,
  resolveProjectId,
} from "../api/resolve";
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
import { parseDuration, parseNumber } from "../input";
import { table } from "../output/theme";

/** `project:view`'s answer. */
interface ProjectView {
  project: ProjectSummary;
  organization: { id: number; name: string; slug: string };
  callerTags: { id: number; name: string }[];
  standing: { isAdmin: boolean; viaOrganizationOwner: boolean };
}

/** `project:settings-view` and `project:settings-edit`'s answer. */
export interface ProjectSettings {
  projectId: number;
  sandboxProvider: string | null;
  sandboxConfig: { image?: string } | null;
  sandboxConcurrency: number | null;
  sandboxMaxDurationMs: number | null;
  effectiveSandbox: {
    provider: string;
    image: string | null;
    concurrency: number;
    maxDurationMs: number;
  };
  updatedAt: number;
}

/** `project settings`'s flags, as commander parses them; `false` is a `--no-*`. */
export interface ProjectSettingsFlags {
  sandboxProvider?: string | false;
  sandboxImage?: string | false;
  sandboxConcurrency?: string | false;
  sandboxMaxDuration?: string | false;
}

/**
 * Turn `project settings`'s flags into a `project:settings-edit` body: only
 * the fields given, and null for a `--no-*` (the deployment's default).
 * @param flags - What commander parsed.
 * @returns The body's fields; empty when only viewing.
 * @throws {Error} For a bad number or duration.
 */
export function projectSettingsBody(
  flags: ProjectSettingsFlags,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (flags.sandboxProvider !== undefined) {
    body.sandboxProvider = flags.sandboxProvider || null;
  }
  if (flags.sandboxImage !== undefined) {
    body.sandboxImage = flags.sandboxImage || null;
  }
  if (flags.sandboxConcurrency !== undefined) {
    body.sandboxConcurrency =
      flags.sandboxConcurrency === false
        ? null
        : parseNumber(flags.sandboxConcurrency, "--sandbox-concurrency");
  }
  if (flags.sandboxMaxDuration !== undefined) {
    body.sandboxMaxDurationMs =
      flags.sandboxMaxDuration === false
        ? null
        : parseDuration(flags.sandboxMaxDuration, "--sandbox-max-duration") *
          1000;
  }
  return body;
}

/**
 * A duration in milliseconds as a person reads it.
 * @param ms - The duration.
 * @returns e.g. `2h`, `45m`, `90s`.
 */
function durationText(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s % 3600 === 0) return `${s / 3600}h`;
  if (s % 60 === 0) return `${s / 60}m`;
  return `${s}s`;
}

/**
 * Render a project's settings for a person: what is in effect, and whether it
 * is the project's own choice or the deployment's default.
 * @param s - The settings.
 * @returns The lines.
 */
export function projectSettingsText(s: ProjectSettings): string {
  const own = (chosen: unknown) => (chosen == null ? " (default)" : "");
  const e = s.effectiveSandbox;
  return [
    `sandbox jobs for project ${s.projectId}`,
    `provider      ${e.provider}${own(s.sandboxProvider)}`,
    `image         ${e.image ?? "the provider's own"}${own(s.sandboxConfig?.image)}`,
    `at once       ${e.concurrency}${own(s.sandboxConcurrency)}`,
    `longest       ${durationText(e.maxDurationMs)}${own(s.sandboxMaxDurationMs)}`,
  ].join("\n");
}

/**
 * The project a subcommand names, else the selected one.
 * @param ctx - The context.
 * @param selector - An id or slug, if the person gave one.
 * @returns The project id.
 */
async function targetProject(
  ctx: CliContext,
  selector?: string,
): Promise<number> {
  return selector
    ? resolveProjectId(ctx.signedInClient(), selector)
    : ctx.projectId();
}

/**
 * Render projects as a table.
 * @param projects - The projects.
 * @param selected - The id `project use` selected, marked in the table.
 * @returns The table.
 */
function projectTable(
  projects: ProjectSummary[],
  selected?: number | null,
): string {
  return table(
    projects.map((p) => ({
      " ": p.id === selected ? "*" : "",
      id: p.id,
      slug: p.slug,
      name: p.name,
      org: p.organizationId,
      standing: p.standing?.isAdmin ? "admin" : "member",
      created: when(p.createdAt),
    })),
    [
      { key: " " },
      { key: "id" },
      { key: "slug" },
      { key: "name", maxWidth: 40 },
      { key: "org" },
      { key: "standing" },
      { key: "created" },
    ],
  );
}

/**
 * Register `project list|view|use|create|edit|settings|delete`.
 * @param program - The root program.
 */
export function registerProjectCommands(program: Command): void {
  const project = program
    .command("project")
    .description("Your projects, and which one commands act on");

  withPaging(
    project
      .command("list")
      .description(
        "List the projects you can see (only one organization's with --org)",
      ),
  ).action(async function (this: Command) {
    await runCommand(this, async (ctx) => {
      const client = ctx.signedInClient();
      // Only an explicit --org narrows the list; a saved `org use` does not
      // hide projects a person can see.
      const organizationId = ctx.options.org
        ? await resolveOrganizationId(client, ctx.options.org)
        : undefined;
      const result = await client.request<
        Paginated<"projects", ProjectSummary>
      >("GET", "/projects", {
        query: { organizationId, ...pageQuery(this) },
      });
      emit(
        ctx,
        result,
        () =>
          projectTable(result.projects, ctx.entry.project) +
          pageFooter(result.pagination),
      );
    });
  });

  project
    .command("view")
    .description("Show a project and your standing in it")
    .argument("[project]", "id or slug (default: the selected project)")
    .action(async function (this: Command, selector?: string) {
      await runCommand(this, async (ctx) => {
        const projectId = await targetProject(ctx, selector);
        const result = await ctx
          .signedInClient()
          .request<ProjectView>("GET", `/project/${projectId}`);
        emit(ctx, result, () =>
          [
            `${result.project.name} (${result.project.slug}, id ${result.project.id})`,
            `organization  ${result.organization.name} (${result.organization.slug})`,
            `standing      ${result.standing.isAdmin ? "admin" : "member"}${result.standing.viaOrganizationOwner ? " (organization owner)" : ""}`,
            `tags          ${result.callerTags.map((t) => t.name).join(", ") || "-"}`,
            `created       ${when(result.project.createdAt)}`,
          ].join("\n"),
        );
      });
    });

  project
    .command("use")
    .description("Select the project later commands act on")
    .argument("<project>", "id or slug")
    .action(async function (this: Command, selector: string) {
      await runCommand(this, async (ctx) => {
        const client = ctx.signedInClient();
        const projectId = await resolveProjectId(client, selector);
        // Proves membership before saving, so `use` never selects a project
        // every later command would be refused.
        const { project: selected } = await client.request<ProjectView>(
          "GET",
          `/project/${projectId}`,
        );
        ctx.entry.project = selected.id;
        ctx.save();
        emit(
          ctx,
          { project: selected },
          () => `Using ${selected.name} (${selected.slug}, id ${selected.id})`,
        );
      });
    });

  project
    .command("create")
    .description(
      "Create a project in the selected organization; you become its admin",
    )
    .requiredOption("--name <name>", "the project's display name")
    .action(async function (this: Command) {
      await runCommand(this, async (ctx) => {
        const { name } = this.opts() as { name: string };
        const organizationId = await ctx.organizationId();
        const result = await ctx
          .signedInClient()
          .request<{ project: ProjectSummary }>("PUT", "/project", {
            body: { organizationId, name },
          });
        emit(
          ctx,
          result,
          () =>
            `Created ${result.project.name} (${result.project.slug}, id ${result.project.id})`,
        );
      });
    });

  project
    .command("edit")
    .description("Rename a project (admin)")
    .argument("[project]", "id or slug (default: the selected project)")
    .requiredOption("--name <name>", "the new display name")
    .action(async function (this: Command, selector?: string) {
      await runCommand(this, async (ctx) => {
        const { name } = this.opts() as { name: string };
        const projectId = await targetProject(ctx, selector);
        const result = await ctx
          .signedInClient()
          .request<{ project: ProjectSummary }>(
            "POST",
            `/project/${projectId}`,
            { body: { name } },
          );
        emit(
          ctx,
          result,
          () => `Renamed project ${projectId} to ${result.project.name}`,
        );
      });
    });

  project
    .command("settings")
    .description(
      "Show a project's sandbox settings, or change them with flags (admin to change)",
    )
    .argument("[project]", "id or slug (default: the selected project)")
    .option(
      "--sandbox-provider <name>",
      "where sandbox jobs run, e.g. docker (development only)",
    )
    .option("--no-sandbox-provider", "the deployment's default provider")
    .option("--sandbox-image <image>", "the image a job's sandbox runs")
    .option("--no-sandbox-image", "the provider's own image")
    .option("--sandbox-concurrency <n>", "how many jobs may run at once (1-50)")
    .option("--no-sandbox-concurrency", "the deployment's default concurrency")
    .option(
      "--sandbox-max-duration <duration>",
      "the longest one job may run: seconds, or 30m, 2h; only lower than the deployment's",
    )
    .option("--no-sandbox-max-duration", "the deployment's ceiling")
    .action(async function (this: Command, selector?: string) {
      await runCommand(this, async (ctx) => {
        // Each `--no-*` follows its value flag, so commander leaves an
        // absent pair undefined: no flags at all means view.
        const body = projectSettingsBody(this.opts() as ProjectSettingsFlags);
        const projectId = await targetProject(ctx, selector);
        const client = ctx.signedInClient();
        const result =
          Object.keys(body).length === 0
            ? await client.request<{ settings: ProjectSettings }>(
                "GET",
                `/project/${projectId}/settings`,
              )
            : await client.request<{ settings: ProjectSettings }>(
                "POST",
                `/project/${projectId}/settings`,
                { body },
              );
        emit(ctx, result, () => projectSettingsText(result.settings));
      });
    });

  project
    .command("delete")
    .description("Delete a project and everything in it (admin)")
    .argument("<project>", "id or slug")
    .option("--yes", "confirm; required, because this cannot be undone")
    .action(async function (this: Command, selector: string) {
      await runCommand(this, async (ctx) => {
        requireYes(
          this,
          `Deleting a project cannot be undone. Re-run with --yes to delete ${selector}.`,
        );
        const client = ctx.signedInClient();
        const projectId = await resolveProjectId(client, selector);
        const result = await client.request("DELETE", `/project/${projectId}`);
        if (ctx.entry.project === projectId) {
          ctx.entry.project = null;
          ctx.save();
        }
        emit(ctx, result, () => `Deleted project ${selector}`);
      });
    });
}
