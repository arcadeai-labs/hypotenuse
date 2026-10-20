/**
 * `hypotenuse invite` — inviting people to the selected project, and answering
 * invites addressed to you (`invite:*`).
 */
import type { Command } from "commander";
import {
  emit,
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
  projectId: number;
  projectName: string;
  inviteeEmail: string;
  inviterEmail: string;
  status: string;
  tagIds: number[];
  expiresAt: number;
}

/** A list answer. */
interface InviteList {
  invites: Invite[];
  pagination: { page: number; pages: number; total: number };
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
      project: i.projectName,
      invitee: i.inviteeEmail,
      from: i.inviterEmail,
      status: i.status,
      expires: when(i.expiresAt),
    })),
    [
      { key: "id" },
      { key: "project", maxWidth: 30 },
      { key: "invitee", maxWidth: 40 },
      { key: "from", maxWidth: 40 },
      { key: "status" },
      { key: "expires" },
    ],
  );
}

/**
 * Parse `--tag 3 --tag 5` or `--tags 3,5` into ids.
 * @param raw - The collected values.
 * @returns The tag ids.
 */
function tagIds(raw: string[] | undefined): number[] {
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
  const invite = program.command("invite").description("Project invitations");

  withPaging(
    invite
      .command("list")
      .description("The selected project's invites (admin)"),
  ).action(async function (this: Command) {
    await runCommand(this, async (ctx) => {
      const projectId = await ctx.projectId();
      const result = await ctx
        .signedInClient()
        .request<InviteList>("GET", "/invites", {
          query: { projectId, ...pageQuery(this) },
        });
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
        .request<InviteList>("GET", "/invites/pending", {
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
    .description("Invite someone to the selected project by email (admin)")
    .requiredOption("--email <email>", "who to invite")
    .option(
      "--tag <id>",
      "a tag id to grant on acceptance (repeatable, or comma-separated)",
      (value: string, previous: string[] = []) => [...previous, value],
    )
    .action(async function (this: Command) {
      await runCommand(this, async (ctx) => {
        const opts = this.opts() as { email: string; tag?: string[] };
        const projectId = await ctx.projectId();
        const result = await ctx
          .signedInClient()
          .request<{ invite: Invite }>("PUT", "/invite", {
            body: {
              projectId,
              inviteeEmail: opts.email,
              tagIds: tagIds(opts.tag),
            },
          });
        emit(
          ctx,
          result,
          () =>
            `Invited ${result.invite.inviteeEmail} (invite ${result.invite.id})`,
        );
      });
    });

  for (const verb of ["accept", "reject"] as const) {
    invite
      .command(verb)
      .description(
        `${verb === "accept" ? "Accept" : "Reject"} an invite addressed to you`,
      )
      .argument("<inviteId>", "the invite's id (see `invite pending`)")
      .action(async function (this: Command, inviteId: string) {
        await runCommand(this, async (ctx) => {
          const result = await ctx
            .signedInClient()
            .request("POST", `/invite/${verb}`, {
              body: { inviteId: Number(inviteId) },
            });
          emit(
            ctx,
            result,
            () =>
              `${verb === "accept" ? "Accepted" : "Rejected"} invite ${inviteId}`,
          );
        });
      });
  }
}
