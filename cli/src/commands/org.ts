/**
 * `hypotenuse org` — the caller's organizations (`organization:*`), their
 * members (`organization-membership:*`), and which organization later commands
 * act on.
 */
import type { Command } from "commander";
import {
  type OrganizationSummary,
  resolveOrganizationId,
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

/** An organization membership as `organization-membership:list` answers it. */
interface OrganizationMember {
  userId: number;
  role: "owner" | "member";
  createdAt: number;
  user: { name: string; email: string };
}

/**
 * The organization a subcommand names, else the selected one.
 * @param ctx - The context.
 * @param selector - An id or slug, if the person gave one.
 * @returns The organization id.
 */
async function targetOrganization(
  ctx: CliContext,
  selector?: string,
): Promise<number> {
  return selector
    ? resolveOrganizationId(ctx.signedInClient(), selector)
    : ctx.organizationId();
}

/**
 * Render organizations as a table.
 * @param organizations - The organizations.
 * @param selected - The id `org use` selected, marked in the table.
 * @returns The table.
 */
function organizationTable(
  organizations: OrganizationSummary[],
  selected?: number | null,
): string {
  return table(
    organizations.map((o) => ({
      " ": o.id === selected ? "*" : "",
      id: o.id,
      slug: o.slug,
      name: o.name,
      role: o.standing?.role ?? "-",
      created: when(o.createdAt),
    })),
    [
      { key: " " },
      { key: "id" },
      { key: "slug" },
      { key: "name", maxWidth: 40 },
      { key: "role" },
      { key: "created" },
    ],
  );
}

/**
 * Register `org list|view|use|create|edit|delete|members|invites` and
 * `org member set-role|remove`.
 * @param program - The root program.
 */
export function registerOrgCommands(program: Command): void {
  const org = program
    .command("org")
    .description(
      "Your organizations, their members, and which one commands act on",
    );

  withPaging(
    org.command("list").description("List the organizations you belong to"),
  ).action(async function (this: Command) {
    await runCommand(this, async (ctx) => {
      const result = await ctx
        .signedInClient()
        .request<Paginated<"organizations", OrganizationSummary>>(
          "GET",
          "/organizations",
          { query: pageQuery(this) },
        );
      emit(
        ctx,
        result,
        () =>
          organizationTable(result.organizations, ctx.entry.organization) +
          pageFooter(result.pagination),
      );
    });
  });

  org
    .command("view")
    .description("Show an organization and your role in it")
    .argument("[org]", "id or slug (default: the selected organization)")
    .action(async function (this: Command, selector?: string) {
      await runCommand(this, async (ctx) => {
        const organizationId = await targetOrganization(ctx, selector);
        const result = await ctx.signedInClient().request<{
          organization: OrganizationSummary;
          standing: { role: string };
        }>("GET", `/organization/${organizationId}`);
        emit(ctx, result, () =>
          [
            `${result.organization.name} (${result.organization.slug}, id ${result.organization.id})`,
            `role     ${result.standing.role}`,
            `created  ${when(result.organization.createdAt)}`,
          ].join("\n"),
        );
      });
    });

  org
    .command("use")
    .description("Select the organization later commands act on")
    .argument("<org>", "id or slug")
    .action(async function (this: Command, selector: string) {
      await runCommand(this, async (ctx) => {
        const client = ctx.signedInClient();
        const organizationId = await resolveOrganizationId(client, selector);
        // Proves membership before saving, so `use` never selects an
        // organization every later command would be refused.
        const { organization } = await client.request<{
          organization: OrganizationSummary;
        }>("GET", `/organization/${organizationId}`);
        ctx.entry.organization = organization.id;
        ctx.save();
        emit(
          ctx,
          { organization },
          () =>
            `Using ${organization.name} (${organization.slug}, id ${organization.id})`,
        );
      });
    });

  org
    .command("create")
    .description("Create an organization; you become its owner")
    .requiredOption("--name <name>", "the organization's display name")
    .action(async function (this: Command) {
      await runCommand(this, async (ctx) => {
        const { name } = this.opts() as { name: string };
        const result = await ctx
          .signedInClient()
          .request<{ organization: OrganizationSummary }>(
            "PUT",
            "/organization",
            { body: { name } },
          );
        emit(
          ctx,
          result,
          () =>
            `Created ${result.organization.name} (${result.organization.slug}, id ${result.organization.id})`,
        );
      });
    });

  org
    .command("edit")
    .description("Rename an organization or change its slug (owner)")
    .argument("[org]", "id or slug (default: the selected organization)")
    .option("--name <name>", "the new display name")
    .option("--slug <slug>", "the new slug")
    .action(async function (this: Command, selector?: string) {
      await runCommand(this, async (ctx) => {
        const { name, slug } = this.opts() as { name?: string; slug?: string };
        if (name === undefined && slug === undefined) {
          throw new Error("Pass --name, --slug, or both.");
        }
        const organizationId = await targetOrganization(ctx, selector);
        const result = await ctx
          .signedInClient()
          .request<{ organization: OrganizationSummary }>(
            "POST",
            `/organization/${organizationId}`,
            { body: { name, slug } },
          );
        emit(
          ctx,
          result,
          () =>
            `Updated ${result.organization.name} (${result.organization.slug}, id ${result.organization.id})`,
        );
      });
    });

  org
    .command("delete")
    .description("Delete an organization and every project in it (owner)")
    .argument("<org>", "id or slug")
    .option("--yes", "confirm; required, because this cannot be undone")
    .action(async function (this: Command, selector: string) {
      await runCommand(this, async (ctx) => {
        requireYes(
          this,
          `Deleting an organization cannot be undone. Re-run with --yes to delete ${selector}.`,
        );
        const client = ctx.signedInClient();
        const organizationId = await resolveOrganizationId(client, selector);
        const result = await client.request(
          "DELETE",
          `/organization/${organizationId}`,
        );
        if (ctx.entry.organization === organizationId) {
          ctx.entry.organization = null;
          ctx.save();
        }
        emit(ctx, result, () => `Deleted organization ${selector}`);
      });
    });

  withPaging(
    org
      .command("members")
      .description("List the selected organization's members and their roles"),
  ).action(async function (this: Command) {
    await runCommand(this, async (ctx) => {
      const organizationId = await ctx.organizationId();
      const result = await ctx
        .signedInClient()
        .request<Paginated<"memberships", OrganizationMember>>(
          "GET",
          `/organization/${organizationId}/members`,
          { query: pageQuery(this) },
        );
      emit(
        ctx,
        result,
        () =>
          table(
            result.memberships.map((m) => ({
              user: m.userId,
              name: m.user.name,
              email: m.user.email,
              role: m.role,
              joined: when(m.createdAt),
            })),
            [
              { key: "user" },
              { key: "name", maxWidth: 30 },
              { key: "email", maxWidth: 40 },
              { key: "role" },
              { key: "joined" },
            ],
          ) + pageFooter(result.pagination),
      );
    });
  });

  const member = org
    .command("member")
    .description("Change or remove one member of the selected organization");

  member
    .command("set-role")
    .description("Make a member an owner, or an owner a member (owner)")
    .argument("<userId>", "the member's user id")
    .argument("<role>", "owner or member")
    .action(async function (this: Command, userId: string, role: string) {
      await runCommand(this, async (ctx) => {
        if (role !== "owner" && role !== "member") {
          throw new Error("The role is owner or member.");
        }
        const organizationId = await ctx.organizationId();
        const result = await ctx
          .signedInClient()
          .request(
            "POST",
            `/organization/${organizationId}/member/${Number(userId)}`,
            { body: { role } },
          );
        emit(ctx, result, () => `User ${userId} is now an ${role}`);
      });
    });

  member
    .command("remove")
    .description(
      "Remove a member from the organization and all its projects (owner; your own id to leave)",
    )
    .argument("<userId>", "the member's user id")
    .action(async function (this: Command, userId: string) {
      await runCommand(this, async (ctx) => {
        const organizationId = await ctx.organizationId();
        const result = await ctx
          .signedInClient()
          .request<{ removedFromProjectIds: number[] }>(
            "DELETE",
            `/organization/${organizationId}/member/${Number(userId)}`,
          );
        emit(
          ctx,
          result,
          () =>
            `Removed user ${userId} from the organization and ${result.removedFromProjectIds.length} project(s)`,
        );
      });
    });
}
