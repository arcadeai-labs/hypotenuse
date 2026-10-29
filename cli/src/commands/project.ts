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
import { table } from "../output/theme";

/** `project:view`'s answer. */
interface ProjectView {
  project: ProjectSummary;
  organization: { id: number; name: string; slug: string };
  callerTags: { id: number; name: string }[];
  standing: { isAdmin: boolean; viaOrganizationOwner: boolean };
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
 * Register `project list|view|use|create|edit|delete`.
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
