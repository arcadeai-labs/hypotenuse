/**
 * `hypotenuse prompt` — the sections a bot's system prompt is assembled from
 * (`prompt-section:*`), their versions, and `prompt:preview`, which shows the
 * exact text a bot would be sent. A section is named by id, or by key: a key
 * names one of `--bot`'s sections, or with no `--bot` one of the project's.
 */
import type { Command } from "commander";
import type { ApiClient } from "../api/client";
import { findInPages, resolveBotId } from "../api/resolve";
import {
  emit,
  type Paginated,
  pageFooter,
  pageQuery,
  requireYes,
  runCommand,
  when,
  withPaging,
} from "../context";
import { bodyText, collect, parseNumber } from "../input";
import { dim, table } from "../output/theme";

/** A section as the prompt-section actions answer it. */
export interface PromptSection {
  id: number;
  scope: "bot" | "project";
  botId: number | null;
  key: string;
  title: string;
  loading: "always" | "contextual";
  keywords: string[];
  agentEditable: boolean;
  position: number;
  origin: "seed" | "person" | "agent";
  currentVersion: number;
  archived: boolean;
  body?: string;
  versionSource?: string;
  versionCreatedAt?: number;
}

/** A section version as `prompt-section:versions` answers it. */
export interface PromptSectionVersion {
  id: number;
  version: number;
  title: string;
  body: string;
  source: "seed" | "person" | "agent" | "revert";
  userId: number | null;
  conversationId: number | null;
  entryId: number | null;
  changeNote: string | null;
  createdAt: number;
}

/** A section as a preview names it. */
interface PreviewSection {
  id: number;
  key: string;
  title: string;
  scope: string;
  loading: string;
  version: number;
  estimatedTokens: number;
}

/** What `prompt:preview` answers. */
export interface PromptPreview {
  system: string;
  hash: string;
  sections: PreviewSection[];
  dropped: PreviewSection[];
  contextTerms: string[];
  estimatedTokens: number;
  budgetTokens: number;
  overBudget: boolean;
  mcp: boolean;
}

/**
 * Resolve a section id or key.
 * @param client - A signed-in client.
 * @param projectId - The project.
 * @param selector - An id, or a key.
 * @param botId - The bot whose key it is, or undefined for a project section.
 * @returns The section's id.
 * @throws {Error} When no section has that key.
 */
export async function resolveSectionId(
  client: ApiClient,
  projectId: number,
  selector: string,
  botId: number | undefined,
): Promise<number> {
  if (/^\d+$/.test(selector)) return Number(selector);
  const path =
    botId === undefined
      ? `/project/${projectId}/prompt-sections`
      : `/project/${projectId}/prompt-sections?botId=${botId}`;
  const match = await findInPages<PromptSection>(
    client,
    path,
    "promptSections",
    (s) => s.key === selector,
  );
  if (!match) {
    throw new Error(
      botId === undefined
        ? `No project section with the key "${selector}" (pass --bot for a bot's section)`
        : `No section with the key "${selector}" on that bot`,
    );
  }
  return match.id;
}

/**
 * How a section loads, as a person reads it.
 * @param s - The section.
 * @returns `always`, or `contextual (keywords)`.
 */
export function loadingText(
  s: Pick<PromptSection, "loading" | "keywords">,
): string {
  if (s.loading === "always") return "always";
  return s.keywords.length > 0
    ? `contextual (${s.keywords.join(", ")})`
    : "contextual (title words)";
}

/**
 * Render a section for a person: its settings, then its text.
 * @param s - The section.
 * @returns The text.
 */
export function renderSection(s: PromptSection): string {
  return [
    `${s.title}  ${dim(`#${s.id} ${s.key}`)}`,
    `scope         ${s.scope}${s.botId ? ` (bot ${s.botId})` : ""}`,
    `loads         ${loadingText(s)}`,
    `bot may edit  ${s.agentEditable ? "yes" : "no"}`,
    `version       ${s.currentVersion}${s.versionSource ? ` (${s.versionSource}, ${when(s.versionCreatedAt)})` : ""}`,
    ...(s.archived ? ["deleted       yes"] : []),
    "",
    s.body?.trim() ? s.body : dim("(empty)"),
  ].join("\n");
}

/** The flags `add` and `edit` share. */
interface SectionFlags {
  bot?: string;
  key?: string;
  title?: string;
  body?: string;
  bodyFile?: string;
  contextual?: boolean;
  always?: boolean;
  keyword?: string[] | false;
  agentEditable?: boolean;
  position?: string;
  base?: string;
  note?: string;
}

/**
 * The settings `add` and `edit` send, from their flags.
 * @param o - The flags.
 * @returns The request body (without text).
 * @throws {Error} For --always with --contextual.
 */
function settingsBody(o: SectionFlags): Record<string, unknown> {
  if (o.always && o.contextual) {
    throw new Error("Pass --always or --contextual, not both.");
  }
  const body: Record<string, unknown> = {};
  if (o.always) body.loading = "always";
  if (o.contextual) body.loading = "contextual";
  if (o.keyword === false) body.keywords = [];
  else if (o.keyword !== undefined) body.keywords = o.keyword;
  if (o.agentEditable !== undefined) body.agentEditable = o.agentEditable;
  if (o.position !== undefined)
    body.position = parseNumber(o.position, "--position");
  if (o.note !== undefined) body.changeNote = o.note;
  return body;
}

/**
 * Add the flags `add` and `edit` share.
 * @param command - The command.
 * @returns The same command.
 */
function withSectionFlags(command: Command): Command {
  return command
    .option("--title <title>", "the section's heading")
    .option("--body <text>", "the section's markdown (- reads standard input)")
    .option("--body-file <path>", "read the section's markdown from a file")
    .option("--always", "include it in every step")
    .option(
      "--contextual",
      "include it only when one of its keywords comes up in the conversation",
    )
    .option(
      "--keyword <word>",
      "a word that brings a contextual section in (repeatable; replaces the list)",
      collect,
    )
    .option("--no-keyword", "clear the keywords, so the title's words are used")
    .option("--agent-editable", "let the bot change it itself (bot sections)")
    .option("--no-agent-editable", "only people change it")
    .option("--position <n>", "order within its group")
    .option("--note <text>", "why it changed, kept with the version");
}

/**
 * Register `prompt list|view|versions|add|edit|revert|remove|preview`.
 * @param program - The root command.
 */
export function registerPromptCommands(program: Command): void {
  const prompt = program
    .command("prompt")
    .description(
      "The sections a bot's system prompt is built from, their versions, and a preview of the exact text: list|view|versions|add|edit|revert|remove|preview",
    );

  withPaging(
    prompt
      .command("list")
      .description(
        "List a bot's prompt sections (--bot), or the project's that every bot includes",
      )
      .option("--bot <bot>", "the bot's id or slug; omit for project sections")
      .option("--deleted", "include deleted sections"),
  ).action(async function (this: Command) {
    await runCommand(this, async (ctx) => {
      const o = this.opts() as { bot?: string; deleted?: boolean };
      const client = ctx.signedInClient();
      const projectId = await ctx.projectId();
      const botId = o.bot
        ? await resolveBotId(client, projectId, o.bot)
        : undefined;
      const result = await client.request<
        Paginated<"promptSections", PromptSection>
      >("GET", `/project/${projectId}/prompt-sections`, {
        query: {
          ...pageQuery(this),
          ...(botId !== undefined ? { botId } : {}),
          ...(o.deleted ? { includeArchived: "true" } : {}),
        },
      });
      emit(ctx, result, () => {
        if (result.promptSections.length === 0) {
          return botId === undefined
            ? "No project sections. `hypotenuse prompt add --title <t>` adds one (admin)."
            : "No sections.";
        }
        return (
          table(
            result.promptSections.map((s) => ({
              id: s.id,
              key: s.key,
              title: s.title,
              loads: loadingText(s),
              "bot edits": s.agentEditable ? "yes" : "no",
              version: s.currentVersion,
              origin: s.archived ? `${s.origin}, deleted` : s.origin,
            })),
            [
              { key: "id" },
              { key: "key", maxWidth: 30 },
              { key: "title", maxWidth: 30 },
              { key: "loads", maxWidth: 40 },
              { key: "bot edits" },
              { key: "version" },
              { key: "origin" },
            ],
          ) + pageFooter(result.pagination)
        );
      });
    });
  });

  prompt
    .command("view")
    .description("Show a prompt section and its current text")
    .argument("<section>", "id, or key (with --bot for a bot's section)")
    .option("--bot <bot>", "the bot whose section key it is")
    .action(async function (this: Command, selector: string) {
      await runCommand(this, async (ctx) => {
        const o = this.opts() as { bot?: string };
        const client = ctx.signedInClient();
        const projectId = await ctx.projectId();
        const botId = o.bot
          ? await resolveBotId(client, projectId, o.bot)
          : undefined;
        const id = await resolveSectionId(client, projectId, selector, botId);
        const result = await client.request<{ promptSection: PromptSection }>(
          "GET",
          `/project/${projectId}/prompt-section/${id}`,
        );
        emit(ctx, result, () => renderSection(result.promptSection));
      });
    });

  withPaging(
    prompt
      .command("versions")
      .description(
        "A section's history, newest first: who wrote each version (a person, the bot in which conversation, a revert) and why",
      )
      .argument("<section>", "id, or key (with --bot for a bot's section)")
      .option("--bot <bot>", "the bot whose section key it is"),
  ).action(async function (this: Command, selector: string) {
    await runCommand(this, async (ctx) => {
      const o = this.opts() as { bot?: string };
      const client = ctx.signedInClient();
      const projectId = await ctx.projectId();
      const botId = o.bot
        ? await resolveBotId(client, projectId, o.bot)
        : undefined;
      const id = await resolveSectionId(client, projectId, selector, botId);
      const result = await client.request<
        Paginated<"versions", PromptSectionVersion>
      >("GET", `/project/${projectId}/prompt-section/${id}/versions`, {
        query: pageQuery(this),
      });
      emit(
        ctx,
        result,
        () =>
          table(
            result.versions.map((v) => ({
              version: v.version,
              by:
                v.source === "agent"
                  ? `bot (conversation ${v.conversationId})`
                  : v.source === "person"
                    ? `user ${v.userId ?? "-"}`
                    : v.source,
              when: when(v.createdAt),
              note: v.changeNote ?? "",
              lines: v.body === "" ? 0 : v.body.split("\n").length,
            })),
            [
              { key: "version" },
              { key: "by", maxWidth: 30 },
              { key: "when" },
              { key: "note", maxWidth: 50 },
              { key: "lines" },
            ],
          ) + pageFooter(result.pagination),
      );
    });
  });

  withSectionFlags(
    prompt
      .command("add")
      .description(
        "Add a section to a bot's prompt (--bot; write access) or to every bot's in the project (admin)",
      )
      .option("--bot <bot>", "the bot's id or slug; omit for a project section")
      .option("--key <key>", "a short unique key (default: from the title)"),
  ).action(async function (this: Command) {
    await runCommand(this, async (ctx) => {
      const o = this.opts() as SectionFlags;
      if (!o.title) throw new Error("A section needs --title.");
      const client = ctx.signedInClient();
      const projectId = await ctx.projectId();
      const body: Record<string, unknown> = {
        title: o.title,
        ...settingsBody(o),
      };
      if (o.bot) body.botId = await resolveBotId(client, projectId, o.bot);
      if (o.key) body.key = o.key;
      const text = await bodyText(o);
      if (text !== undefined) body.body = text;
      const result = await client.request<{ promptSection: PromptSection }>(
        "PUT",
        `/project/${projectId}/prompt-section`,
        { body },
      );
      const s = result.promptSection;
      emit(
        ctx,
        result,
        () => `Added "${s.title}" (#${s.id}, ${s.key}), ${loadingText(s)}`,
      );
    });
  });

  withSectionFlags(
    prompt
      .command("edit")
      .description(
        "Change a section: its text (a new version) or its settings. Only the flags given change.",
      )
      .argument("<section>", "id, or key (with --bot for a bot's section)")
      .option("--bot <bot>", "the bot whose section key it is")
      .option(
        "--base <version>",
        "refuse the change if the section is no longer at this version",
      ),
  ).action(async function (this: Command, selector: string) {
    await runCommand(this, async (ctx) => {
      const o = this.opts() as SectionFlags;
      const client = ctx.signedInClient();
      const projectId = await ctx.projectId();
      const botId = o.bot
        ? await resolveBotId(client, projectId, o.bot)
        : undefined;
      const id = await resolveSectionId(client, projectId, selector, botId);
      const body: Record<string, unknown> = settingsBody(o);
      if (o.title !== undefined) body.title = o.title;
      const text = await bodyText(o);
      if (text !== undefined) body.body = text;
      if (o.base !== undefined)
        body.baseVersion = parseNumber(o.base, "--base");
      if (Object.keys(body).length === 0) {
        throw new Error(
          "Nothing to change: pass --title, --body, --body-file, or a setting.",
        );
      }
      const result = await client.request<{ promptSection: PromptSection }>(
        "POST",
        `/project/${projectId}/prompt-section/${id}`,
        { body },
      );
      const s = result.promptSection;
      emit(
        ctx,
        result,
        () =>
          `"${s.title}" is at version ${s.currentVersion}, ${loadingText(s)}`,
      );
    });
  });

  prompt
    .command("revert")
    .description(
      "Put an earlier version's text back, as a new version — how you undo the bot's own edit",
    )
    .argument("<section>", "id, or key (with --bot for a bot's section)")
    .requiredOption("--to <version>", "the version whose text to put back")
    .option("--bot <bot>", "the bot whose section key it is")
    .action(async function (this: Command, selector: string) {
      await runCommand(this, async (ctx) => {
        const o = this.opts() as { bot?: string; to: string };
        const client = ctx.signedInClient();
        const projectId = await ctx.projectId();
        const botId = o.bot
          ? await resolveBotId(client, projectId, o.bot)
          : undefined;
        const id = await resolveSectionId(client, projectId, selector, botId);
        const result = await client.request<{ promptSection: PromptSection }>(
          "POST",
          `/project/${projectId}/prompt-section/${id}/revert`,
          { body: { version: parseNumber(o.to, "--to") } },
        );
        const s = result.promptSection;
        emit(
          ctx,
          result,
          () =>
            `"${s.title}" is at version ${s.currentVersion}, with version ${o.to}'s text`,
        );
      });
    });

  prompt
    .command("remove")
    .description(
      "Delete a section; its versions stay readable. A bot's Identity section cannot be deleted.",
    )
    .argument("<section>", "id, or key (with --bot for a bot's section)")
    .option("--bot <bot>", "the bot whose section key it is")
    .option("--yes", "confirm")
    .action(async function (this: Command, selector: string) {
      await runCommand(this, async (ctx) => {
        requireYes(this, "Deleting a section needs --yes.");
        const o = this.opts() as { bot?: string };
        const client = ctx.signedInClient();
        const projectId = await ctx.projectId();
        const botId = o.bot
          ? await resolveBotId(client, projectId, o.bot)
          : undefined;
        const id = await resolveSectionId(client, projectId, selector, botId);
        const result = await client.request<{ promptSection: PromptSection }>(
          "DELETE",
          `/project/${projectId}/prompt-section/${id}`,
        );
        emit(ctx, result, () => `Deleted "${result.promptSection.title}"`);
      });
    });

  prompt
    .command("preview")
    .description(
      "The exact system prompt a bot would be sent, its hash, and which sections were in and out",
    )
    .requiredOption("--bot <bot>", "the bot's id or slug")
    .option(
      "--message <text>",
      "a sample message, which decides the contextual sections",
    )
    .option(
      "--conversation <id>",
      "assemble it as this conversation's next step would",
    )
    .option("--sections", "print only the sections, not the text")
    .action(async function (this: Command) {
      await runCommand(this, async (ctx) => {
        const o = this.opts() as {
          bot: string;
          message?: string;
          conversation?: string;
          sections?: boolean;
        };
        const client = ctx.signedInClient();
        const projectId = await ctx.projectId();
        const botId = await resolveBotId(client, projectId, o.bot);
        const result = await client.request<{ prompt: PromptPreview }>(
          "GET",
          `/project/${projectId}/bot/${botId}/prompt-preview`,
          {
            query: {
              ...(o.message !== undefined ? { message: o.message } : {}),
              ...(o.conversation !== undefined
                ? {
                    conversationId: parseNumber(
                      o.conversation,
                      "--conversation",
                    ),
                  }
                : {}),
            },
          },
        );
        emit(ctx, result, () => renderPreview(result.prompt, !o.sections));
      });
    });
}

/**
 * Render a preview for a person: a summary, the sections, then the text.
 * @param p - The preview.
 * @param withText - Whether to print the prompt itself.
 * @returns The text.
 */
export function renderPreview(p: PromptPreview, withText: boolean): string {
  const lines = [
    `hash      ${p.hash}`,
    `tokens    about ${p.estimatedTokens} of ${p.budgetTokens}${p.overBudget ? " — over budget" : ""}`,
    `terms     ${p.contextTerms.join(", ") || "-"}`,
    `sections  ${p.sections.map((s) => `${s.key}@${s.version}`).join(", ") || "-"}`,
  ];
  if (p.dropped.length > 0) {
    lines.push(
      `dropped   ${p.dropped.map((s) => `${s.key}@${s.version}`).join(", ")} (over budget)`,
    );
  }
  if (withText) lines.push("", p.system);
  return lines.join("\n");
}
