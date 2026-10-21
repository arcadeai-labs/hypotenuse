/**
 * `hypotenuse identity` — which project member each person in the project's
 * Linear workspace is (`external-identity:*`). Routing prefers the runners of
 * the person who started a session; a link is a preference, never a
 * permission.
 *
 * Links are made by an e-mail match when a session starts, or by an admin
 * here. Linking yourself by signing in to Linear is not available yet.
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

/** An identity as `external-identity:*` serializes it. */
export interface ExternalIdentity {
  id: number;
  type: string;
  integrationId: number;
  userId: number;
  user: { name: string; email: string } | null;
  externalUserId: string;
  externalName: string | null;
  externalEmail: string | null;
  linkedVia: "email" | "oauth" | "admin";
  createdAt: number;
}

/** The page envelope every list answers with. */
interface Pagination {
  page: number;
  limit: number;
  pages: number;
  total: number;
}

/**
 * How a link was made, in words.
 * @param via - `linkedVia`.
 * @returns The phrase.
 */
export function linkedViaText(via: ExternalIdentity["linkedVia"]): string {
  return via === "email"
    ? "e-mail match"
    : via === "oauth"
      ? "Linear sign-in"
      : "admin";
}

/**
 * The human rendering of a list of identities.
 * @param identities - The identities.
 * @returns The table.
 */
export function describeIdentities(identities: ExternalIdentity[]): string {
  return table(
    identities.map((i) => ({
      id: i.id,
      linear: i.externalName ?? i.externalEmail ?? i.externalUserId,
      user: i.user ? `${i.user.name} <${i.user.email}>` : String(i.userId),
      via: linkedViaText(i.linkedVia),
      linked: when(i.createdAt),
    })),
    [
      { key: "id" },
      { key: "linear", header: "LINEAR USER", maxWidth: 36 },
      { key: "user", maxWidth: 40 },
      { key: "via" },
      { key: "linked" },
    ],
  );
}

/**
 * Register `identity list|link|unlink`.
 * @param program - The root program.
 */
export function registerIdentityCommands(program: Command): void {
  const identity = program
    .command("identity")
    .description(
      "Links between people in the project's Linear workspace and project members (routing prefers the issuer's runners)",
    );

  withPaging(
    identity
      .command("list")
      .description("List the links")
      .option("--user <id>", "only links to this Hypotenuse user"),
  ).action(async function (this: Command) {
    await runCommand(this, async (ctx) => {
      const opts = this.opts() as { user?: string };
      const projectId = await ctx.projectId();
      const result = await ctx.signedInClient().request<{
        externalIdentities: ExternalIdentity[];
        pagination: Pagination;
      }>("GET", "/external-identities", {
        query: { projectId, userId: opts.user, ...pageQuery(this) },
      });
      emit(
        ctx,
        result,
        () =>
          describeIdentities(result.externalIdentities) +
          pageFooter(result.pagination),
      );
    });
  });

  identity
    .command("link")
    .description(
      "Link a Linear user to a project member, replacing any earlier link (admin). Linking yourself by signing in to Linear is not available yet.",
    )
    .requiredOption("--user <id>", "the Hypotenuse user (a project member)")
    .requiredOption("--linear-user <id>", "the Linear user's id")
    .option("--name <name>", "their name in Linear, for display")
    .option("--email <email>", "their e-mail in Linear, for display")
    .action(async function (this: Command) {
      await runCommand(this, async (ctx) => {
        const opts = this.opts() as {
          user: string;
          linearUser: string;
          name?: string;
          email?: string;
        };
        if (!/^\d+$/.test(opts.user)) throw new Error("--user is a user id.");
        const projectId = await ctx.projectId();
        const result = await ctx.signedInClient().request<{
          externalIdentity: ExternalIdentity;
        }>("PUT", "/external-identity", {
          body: {
            projectId,
            type: "linear",
            userId: Number(opts.user),
            externalUserId: opts.linearUser,
            externalName: opts.name,
            externalEmail: opts.email,
          },
        });
        const i = result.externalIdentity;
        emit(
          ctx,
          result,
          () =>
            `Linked Linear user ${i.externalName ?? i.externalUserId} to ${i.user?.name ?? `user ${i.userId}`} (#${i.id}).`,
        );
      });
    });

  identity
    .command("unlink <id>")
    .description("Remove a link: your own, or anyone's as an admin")
    .action(async function (this: Command, id: string) {
      await runCommand(this, async (ctx) => {
        const projectId = await ctx.projectId();
        const result = await ctx
          .signedInClient()
          .request<{ success: boolean }>(
            "DELETE",
            `/external-identity/${encodeURIComponent(id)}`,
            { body: { projectId } },
          );
        emit(ctx, result, () => `Removed link #${id}.`);
      });
    });
}
