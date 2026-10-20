/**
 * `hypotenuse project` — the caller's projects (`project:*`), and which one
 * later commands act on.
 */
import type { Command } from "commander";
import { type ProjectSummary, resolveProjectId } from "../api/resolve";
import {
  emit,
  pageFooter,
  pageQuery,
  runCommand,
  when,
  withPaging,
} from "../context";
import { table } from "../output/theme";

/** `project:list`'s answer. */
interface ProjectList {
  projects: ProjectSummary[];
  pagination: { page: number; limit: number; total: number; pages: number };
}

/**
 * Render projects as a table.
 * @param projects - The projects.
 * @param selected - The id `project use` selected, marked in the table.
 * @returns The table.
 */
function projectTable(projects: ProjectSummary[], selected?: number | null) {
  return table(
    projects.map((p) => ({
      " ": p.id === selected ? "*" : "",
      id: p.id,
      slug: p.slug,
      name: p.name,
      created: when(p.createdAt),
    })),
    [
      { key: " " },
      { key: "id" },
      { key: "slug" },
      { key: "name", maxWidth: 40 },
      { key: "created" },
    ],
  );
}

/**
 * Register `project list|view|create|edit|delete|use`.
 * @param program - The root program.
 */
export function registerProjectCommands(program: Command): void {
  const project = program
    .command("project")
    .description("Your projects, and which one commands act on");

  withPaging(
    project.command("list").description("List the projects you belong to"),
  ).action(async function (this: Command) {
    await runCommand(this, async (ctx) => {
      const result = await ctx
        .signedInClient()
        .request<ProjectList>("GET", "/projects", { query: pageQuery(this) });
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
        const client = ctx.signedInClient();
        const projectId = selector
          ? await resolveProjectId(client, selector)
          : await ctx.projectId();
        const result = await client.request<{
          project: ProjectSummary;
          standing: { isMember: boolean; isAdmin: boolean };
          callerTags: { name: string }[];
        }>("GET", "/project", { query: { projectId } });
        emit(ctx, result, () =>
          [
            `${result.project.name} (${result.project.slug}, id ${result.project.id})`,
            `standing  ${result.standing.isAdmin ? "admin" : "member"}`,
            `tags      ${result.callerTags.map((t) => t.name).join(", ") || "-"}`,
            `created   ${when(result.project.createdAt)}`,
          ].join("\n"),
        );
      });
    });

  project
    .command("create")
    .description("Create a project; you become its admin")
    .requiredOption("--name <name>", "the project's display name")
    .action(async function (this: Command) {
      await runCommand(this, async (ctx) => {
        const { name } = this.opts() as { name: string };
        const result = await ctx
          .signedInClient()
          .request<{ project: ProjectSummary }>("PUT", "/project", {
            body: { name },
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
    .argument("<project>", "id or slug")
    .requiredOption("--name <name>", "the new display name")
    .action(async function (this: Command, selector: string) {
      await runCommand(this, async (ctx) => {
        const { name } = this.opts() as { name: string };
        const client = ctx.signedInClient();
        const projectId = await resolveProjectId(client, selector);
        const result = await client.request<{ project: ProjectSummary }>(
          "POST",
          "/project",
          { body: { projectId, name } },
        );
        emit(ctx, result, () => `Renamed project ${projectId} to ${name}`);
      });
    });

  project
    .command("delete")
    .description("Delete a project and everything in it (admin)")
    .argument("<project>", "id or slug")
    .option("--yes", "confirm; required, because this cannot be undone")
    .action(async function (this: Command, selector: string) {
      await runCommand(this, async (ctx) => {
        const { yes } = this.opts() as { yes?: boolean };
        if (!yes) {
          throw new Error(
            `Deleting a project cannot be undone. Re-run with --yes to delete ${selector}.`,
          );
        }
        const client = ctx.signedInClient();
        const projectId = await resolveProjectId(client, selector);
        const result = await client.request("DELETE", "/project", {
          body: { projectId },
        });
        if (ctx.entry.project === projectId) {
          ctx.entry.project = null;
          ctx.save();
        }
        emit(ctx, result, () => `Deleted project ${selector}`);
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
        const { project: selected } = await client.request<{
          project: ProjectSummary;
        }>("GET", "/project", { query: { projectId } });
        ctx.entry.project = selected.id;
        ctx.save();
        emit(
          ctx,
          { project: selected },
          () => `Using ${selected.name} (${selected.slug}, id ${selected.id})`,
        );
      });
    });
}
