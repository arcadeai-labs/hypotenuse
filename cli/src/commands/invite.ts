/**
 * `hypotenuse invite` — invitations into a project or an organization
 * (`invite:*`, `organization:invite-list`).
 */
import type { Command } from "commander";
import { resolveOrganizationId } from "../api/resolve";
import {
  emit,
  type Paginated,
  pageFooter,
  pageQuery,
  runCommand,
  when,
  withPaging,
} from "../context";
import { table } from "../output/theme";

/** An invite as the invite actions answer it. */
interface Invite {
  id: number;
  kind: "project" | "organization";
  organizationName: string;
  projectName: string | null;
  inviteeEmail: string;
  inviterEmail: string;
  status: string;
  expiresAt: number;
}

/**
 * Render invites as a table.
 * @param invites - The invites.
 * @returns The table.
 */
function inviteTable(invites: Invite[]): string {
  return table(
    invites.map((i) => ({
      id: i.id,
      into: i.projectName
        ? `${i.organizationName} / ${i.projectName}`
        : i.organizationName,
      invitee: i.inviteeEmail,
      from: i.inviterEmail,
      status: i.status,
      expires: when(i.expiresAt),
    })),
    [
      { key: "id" },
      { key: "into", maxWidth: 40 },
      { key: "invitee", maxWidth: 40 },
      { key: "from", maxWidth: 40 },
      { key: "status" },
      { key: "expires" },
    ],
  );
}

/**
 * Parse repeatable, comma-separated `--tag` values into ids.
 * @param raw - The values given.
 * @returns The tag ids.
 * @throws {Error} For a value that is not an id.
 */
export function tagIds(raw: string[] | undefined): number[] {
  return (raw ?? [])
    .flatMap((v) => v.split(","))
    .map((v) => v.trim())
    .filter(Boolean)
    .map((v) => {
      if (!/^\d+$/.test(v)) throw new Error(`Not a tag id: ${v}`);
      return Number(v);
    });
}

/**
 * Register `invite list|pending|create|accept|reject`.
 * @param program - The root program.
 */
export function registerInviteCommands(program: Command): void {
  const invite = program
    .command("invite")
    .description("Invitations into a project or an organization");

  withPaging(
    invite
      .command("list")
      .description(
        "The selected project's invites (admin); with --org, the organization's (owner)",
      ),
  ).action(async function (this: Command) {
    await runCommand(this, async (ctx) => {
      const client = ctx.signedInClient();
      const path = ctx.options.org
        ? `/organization/${await resolveOrganizationId(client, ctx.options.org)}/invites`
        : `/project/${await ctx.projectId()}/invites`;
      const result = await client.request<Paginated<"invites", Invite>>(
        "GET",
        path,
        { query: pageQuery(this) },
      );
      emit(
        ctx,
        result,
        () => inviteTable(result.invites) + pageFooter(result.pagination),
      );
    });
  });

  withPaging(
    invite.command("pending").description("Invites addressed to you"),
  ).action(async function (this: Command) {
    await runCommand(this, async (ctx) => {
      const result = await ctx
        .signedInClient()
        .request<Paginated<"invites", Invite>>("GET", "/invites/pending", {
          query: pageQuery(this),
        });
      emit(
        ctx,
        result,
        () => inviteTable(result.invites) + pageFooter(result.pagination),
      );
    });
  });

  invite
    .command("create")
    .description(
      "Invite someone by email into the selected project (admin), or with --organization-only into the selected organization (owner)",
    )
    .requiredOption("--email <email>", "who to invite")
    .option(
      "--tag <id>",
      "a project tag id to grant on acceptance (repeatable, or comma-separated)",
      (value: string, previous: string[] = []) => [...previous, value],
    )
    .option(
      "--organization-only",
      "invite into the organization, with no project",
    )
    .action(async function (this: Command) {
      await runCommand(this, async (ctx) => {
        const opts = this.opts() as {
          email: string;
          tag?: string[];
          organizationOnly?: boolean;
        };
        const client = ctx.signedInClient();
        let body: Record<string, unknown>;
        let organizationId: number;
        if (opts.organizationOnly) {
          if (opts.tag?.length) {
            throw new Error(
              "Tags are project grants; drop --tag or --organization-only.",
            );
          }
          organizationId = await ctx.organizationId();
          body = { inviteeEmail: opts.email };
        } else {
          const projectId = await ctx.projectId();
          // A project invite is sent through its own organization.
          const { project } = await client.request<{
            project: { organizationId: number };
          }>("GET", `/project/${projectId}`);
          organizationId = project.organizationId;
          body = {
            projectId,
            inviteeEmail: opts.email,
            tagIds: tagIds(opts.tag),
          };
        }
        const result = await client.request<{ invite: Invite }>(
          "PUT",
          `/organization/${organizationId}/invite`,
          { body },
        );
        emit(
          ctx,
          result,
          () =>
            `Invited ${opts.email} (invite ${result.invite.id}, expires ${when(result.invite.expiresAt)})`,
        );
      });
    });

  invite
    .command("accept")
    .description("Accept an invite addressed to you")
    .argument("<inviteId>", "the invite's id, from `invite pending`")
    .action(async function (this: Command, inviteId: string) {
      await runCommand(this, async (ctx) => {
        const result = await ctx
          .signedInClient()
          .request("POST", `/invite/${Number(inviteId)}/accept`);
        emit(ctx, result, () => `Accepted invite ${inviteId}`);
      });
    });

  invite
    .command("reject")
    .description("Decline an invite addressed to you")
    .argument("<inviteId>", "the invite's id, from `invite pending`")
    .action(async function (this: Command, inviteId: string) {
      await runCommand(this, async (ctx) => {
        const result = await ctx
          .signedInClient()
          .request("POST", `/invite/${Number(inviteId)}/reject`);
        emit(ctx, result, () => `Rejected invite ${inviteId}`);
      });
    });
}
