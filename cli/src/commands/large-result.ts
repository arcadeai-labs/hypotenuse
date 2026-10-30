/**
 * `hypotenuse large-result` — a tool result too long to show inline in a
 * transcript (`large-result:view`), which the transcript names `lr_<id>`.
 */
import type { Command } from "commander";
import { emit, runCommand } from "../context";
import { parseNumber } from "../input";
import { logger } from "../output/logger";

/** One page of a large result, as `large-result:view` answers it. */
interface LargeResultPage {
  largeResult: {
    id: number;
    ref: string;
    conversationId: number;
    mimeType: string;
    totalChars: number;
    createdAt: number;
  };
  page: {
    id: string;
    offset: number;
    totalChars: number;
    text: string;
    nextOffset: number | null;
  };
}

/**
 * The number of a large result, from `lr_<id>` or the bare digits.
 * @param raw - What the person typed.
 * @returns The id.
 * @throws {Error} When it is neither.
 */
export function largeResultId(raw: string): number {
  const match = /^(?:lr_)?(\d+)$/.exec(raw.trim());
  if (!match) {
    throw new Error(
      `A large result is named lr_<id> or by its number; got "${raw}".`,
    );
  }
  return Number(match[1]);
}

/**
 * Register `large-result view`.
 * @param program - The root program.
 */
export function registerLargeResultCommands(program: Command): void {
  const large = program
    .command("large-result")
    .description(
      "Tool results too long to show in a transcript (lr_<id>): view",
    );

  large
    .command("view")
    .description(
      "Print a large result's text, a page at a time or (--all) whole (the bot's read access)",
    )
    .argument("<result>", "lr_<id> or its number")
    .option("--offset <n>", "the first character (default 0)")
    .option("--limit <n>", "how many characters (default 50000)")
    .option("--all", "every page, from --offset to the end")
    .action(async function (this: Command, raw: string) {
      await runCommand(this, async (ctx) => {
        const o = this.opts() as {
          offset?: string;
          limit?: string;
          all?: boolean;
        };
        const id = largeResultId(raw);
        const client = ctx.signedInClient();
        const projectId = await ctx.projectId();
        let offset: number | null =
          o.offset !== undefined ? parseNumber(o.offset, "--offset") : 0;
        const limit =
          o.limit !== undefined ? parseNumber(o.limit, "--limit") : undefined;
        let first: LargeResultPage | undefined;
        let text = "";
        while (offset !== null) {
          const result: LargeResultPage = await client.request(
            "GET",
            `/project/${projectId}/large-result/${id}`,
            { query: { offset, limit } },
          );
          first ??= result;
          text += result.page.text;
          offset = o.all ? result.page.nextOffset : null;
        }
        const answer = first as LargeResultPage;
        const page = { ...answer.page, text };
        if (o.all) page.nextOffset = null;
        emit(ctx, { largeResult: answer.largeResult, page }, () => text);
        if (!ctx.json && page.nextOffset !== null) {
          logger.tell(
            `${page.totalChars - page.nextOffset} more characters: --offset ${page.nextOffset}, or --all.`,
          );
        }
      });
    });
}
