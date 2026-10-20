/**
 * `hypotenuse member` — who belongs to the selected project (`membership:*`).
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

/** One row of `membership:list`. */
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
        const result = await ctx.signedInClient().request<{
          memberships: Membership[];
          pagination: { page: number; pages: number; total: number };
        }>("GET", "/memberships", {
          query: { projectId, ...pageQuery(this) },
        });
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
    .description("Add an existing user by email (admin)")
    .requiredOption("--email <email>", "the user's email")
    .action(async function (this: Command) {
      await runCommand(this, async (ctx) => {
        const { email } = this.opts() as { email: string };
        const projectId = await ctx.projectId();
        const result = await ctx
          .signedInClient()
          .request("PUT", "/membership", { body: { projectId, email } });
        emit(ctx, result, () => `Added ${email}`);
      });
    });

  member
    .command("remove")
    .description(
      "Remove a member by user id (admin); revokes their runners too",
    )
    .argument("<userId>", "the member's user id")
    .action(async function (this: Command, userId: string) {
      await runCommand(this, async (ctx) => {
        const projectId = await ctx.projectId();
        const result = await ctx
          .signedInClient()
          .request("DELETE", "/membership", {
            body: { projectId, userId: Number(userId) },
          });
        emit(ctx, result, () => `Removed user ${userId}`);
      });
    });
}
