/**
 * `hypotenuse member` — the selected project's members (`membership:*`).
 */
import type { Command } from "commander";
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

/** A project membership as `membership:list` answers it. */
interface Membership {
  userId: number;
  createdAt: number;
  user: { name: string; email: string };
  tags: { name: string }[];
}

/**
 * Register `member list|add|remove`.
 * @param program - The root program.
 */
export function registerMemberCommands(program: Command): void {
  const member = program
    .command("member")
    .description("The selected project's members");

  withPaging(member.command("list").description("List members")).action(
    async function (this: Command) {
      await runCommand(this, async (ctx) => {
        const projectId = await ctx.projectId();
        const result = await ctx
          .signedInClient()
          .request<Paginated<"memberships", Membership>>(
            "GET",
            `/project/${projectId}/members`,
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
                tags: m.tags.map((t) => t.name).join(", "),
                joined: when(m.createdAt),
              })),
              [
                { key: "user" },
                { key: "name", maxWidth: 30 },
                { key: "email", maxWidth: 40 },
                { key: "tags", maxWidth: 40 },
                { key: "joined" },
              ],
            ) + pageFooter(result.pagination),
        );
      });
    },
  );

  member
    .command("add")
    .description(
      "Add a member of the project's organization by email (admin); invite anyone else",
    )
    .requiredOption("--email <email>", "the person's email")
    .action(async function (this: Command) {
      await runCommand(this, async (ctx) => {
        const { email } = this.opts() as { email: string };
        const projectId = await ctx.projectId();
        const result = await ctx
          .signedInClient()
          .request("PUT", `/project/${projectId}/member`, { body: { email } });
        emit(ctx, result, () => `Added ${email}`);
      });
    });

  member
    .command("remove")
    .description("Remove a member by user id (admin)")
    .argument("<userId>", "the member's user id")
    .action(async function (this: Command, userId: string) {
      await runCommand(this, async (ctx) => {
        const projectId = await ctx.projectId();
        const result = await ctx
          .signedInClient()
          .request("DELETE", `/project/${projectId}/member/${Number(userId)}`);
        emit(ctx, result, () => `Removed user ${userId}`);
      });
    });
}
