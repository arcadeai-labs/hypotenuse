/**
 * `hypotenuse tag` — the selected project's permission tags (`tag:*`) and who
 * holds them (`user-tag:*`).
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

/** A tag as the tag actions answer it. */
interface Tag {
  id: number;
  name: string;
  reserved: boolean;
  createdAt: number;
}

/**
 * Register `tag list|create|edit|delete|assign|remove`.
 * @param program - The root program.
 */
export function registerTagCommands(program: Command): void {
  const tag = program
    .command("tag")
    .description("The selected project's permission tags");

  withPaging(tag.command("list").description("List tags")).action(
    async function (this: Command) {
      await runCommand(this, async (ctx) => {
        const projectId = await ctx.projectId();
        const result = await ctx
          .signedInClient()
          .request<Paginated<"tags", Tag>>(
            "GET",
            `/project/${projectId}/tags`,
            { query: pageQuery(this) },
          );
        emit(
          ctx,
          result,
          () =>
            table(
              result.tags.map((t) => ({
                id: t.id,
                name: t.name,
                reserved: t.reserved ? "yes" : "",
                created: when(t.createdAt),
              })),
              [
                { key: "id" },
                { key: "name", maxWidth: 40 },
                { key: "reserved" },
                { key: "created" },
              ],
            ) + pageFooter(result.pagination),
        );
      });
    },
  );

  tag
    .command("create")
    .description("Create a tag (admin)")
    .argument("<name>", "the tag's name")
    .action(async function (this: Command, name: string) {
      await runCommand(this, async (ctx) => {
        const projectId = await ctx.projectId();
        const result = await ctx
          .signedInClient()
          .request<{ tag: Tag }>("PUT", `/project/${projectId}/tag`, {
            body: { name },
          });
        emit(
          ctx,
          result,
          () => `Created tag ${result.tag.name} (id ${result.tag.id})`,
        );
      });
    });

  tag
    .command("edit")
    .description("Rename a tag (admin); the admin tag is reserved")
    .argument("<tagId>", "the tag's id")
    .requiredOption("--name <name>", "the new name")
    .action(async function (this: Command, tagId: string) {
      await runCommand(this, async (ctx) => {
        const { name } = this.opts() as { name: string };
        const projectId = await ctx.projectId();
        const result = await ctx
          .signedInClient()
          .request<{ tag: Tag }>(
            "POST",
            `/project/${projectId}/tag/${Number(tagId)}`,
            { body: { name } },
          );
        emit(ctx, result, () => `Renamed tag ${tagId} to ${result.tag.name}`);
      });
    });

  tag
    .command("delete")
    .description("Delete a tag, and every grant of it (admin)")
    .argument("<tagId>", "the tag's id")
    .action(async function (this: Command, tagId: string) {
      await runCommand(this, async (ctx) => {
        const projectId = await ctx.projectId();
        const result = await ctx
          .signedInClient()
          .request("DELETE", `/project/${projectId}/tag/${Number(tagId)}`);
        emit(ctx, result, () => `Deleted tag ${tagId}`);
      });
    });

  tag
    .command("assign")
    .description("Grant a tag to a member (admin)")
    .argument("<tagId>", "the tag's id")
    .requiredOption("--user <userId>", "the member's user id")
    .action(async function (this: Command, tagId: string) {
      await runCommand(this, async (ctx) => {
        const { user } = this.opts() as { user: string };
        const projectId = await ctx.projectId();
        const result = await ctx
          .signedInClient()
          .request(
            "PUT",
            `/project/${projectId}/member/${Number(user)}/tag/${Number(tagId)}`,
          );
        emit(ctx, result, () => `Granted tag ${tagId} to user ${user}`);
      });
    });

  tag
    .command("remove")
    .description("Revoke a tag from a member (admin)")
    .argument("<tagId>", "the tag's id")
    .requiredOption("--user <userId>", "the member's user id")
    .action(async function (this: Command, tagId: string) {
      await runCommand(this, async (ctx) => {
        const { user } = this.opts() as { user: string };
        const projectId = await ctx.projectId();
        const result = await ctx
          .signedInClient()
          .request(
            "DELETE",
            `/project/${projectId}/member/${Number(user)}/tag/${Number(tagId)}`,
          );
        emit(ctx, result, () => `Revoked tag ${tagId} from user ${user}`);
      });
    });
}
