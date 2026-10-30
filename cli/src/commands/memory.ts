/**
 * `hypotenuse memory` — what the selected project's bots remember
 * (`memory:*`): search it as a bot does, list and read documents and their
 * history, correct or forget one, pin it so it never fades, promote a bot's
 * channel memory to project memory, and re-embed after the embedding model
 * changes.
 *
 * A document lives in one of two scopes. With neither `--bot` nor `--channel`
 * a command acts on **project** memory, which every bot of the project
 * shares; with both it acts on **channel** memory, one bot's memory of one
 * channel. `search` and `list` also take `--scope both`.
 */
import type { Command } from "commander";
import { resolveBotId } from "../api/resolve";
import {
  type CliContext,
  emit,
  type Paginated,
  pageFooter,
  pageQuery,
  runCommand,
  when,
  withPaging,
} from "../context";
import { parseNumber, readAllStdin } from "../input";
import { dim, table, truncateMiddle } from "../output/theme";

/** A memory scope, as the server names it. */
type ScopeName = "channel" | "project";

/** The scopes `search` and `list` may look in. */
const SCOPE_CHOICES = ["channel", "project", "both"] as const;

/** A scope choice for `search` and `list`. */
type ScopeChoice = (typeof SCOPE_CHOICES)[number];

/** A memory document version as the memory actions answer it. */
export interface MemoryDocument {
  id: number;
  projectId: number;
  scope: ScopeName;
  botId: number | null;
  channelId: number | null;
  path: string;
  versionId: number;
  current: boolean;
  forgotten: boolean;
  description: string;
  changeNote: string | null;
  pinned: boolean;
  sourceType: string;
  provenance: Record<string, unknown>;
  authorUserId: number | null;
  accessCount: number;
  lastAccessedAt: number | null;
  createdAt: number;
  decay?: number;
  content?: string;
}

/** One hit as `memory:search` answers it. */
export interface SearchHit {
  documentId: number;
  path: string;
  scope: ScopeName;
  versionId: number;
  description: string;
  chunkIndex: number;
  snippet: string;
  score: number;
  relevance: number;
  decay: number;
  pinned: boolean;
  semanticRank: number | null;
  keywordRank: number | null;
}

/** What `memory:search` answers. */
interface SearchResult {
  hits: SearchHit[];
  mode: "hybrid" | "keyword";
  keywordOnlyReason: string | null;
}

/** What `memory:list` answers. */
type ListResult = Paginated<"documents", MemoryDocument> & {
  halfLifeDays: { channel: number; project: number };
  index: { embeddingModel: string | null; staleChunks: number };
};

/** A channel as `memory:channels` answers it. */
interface MemoryChannel {
  id: number;
  projectId: number;
  type: string;
  name: string;
  botId: number | null;
  createdAt: number;
  documents: number;
}

/** The scope flags every memory command takes, as commander parses them. */
interface ScopeFlags {
  bot?: string;
  channel?: string;
  scope?: string;
}

/** Where a command acts: a scope, and the bot and channel channel scope needs. */
export interface Target {
  scope: ScopeName;
  botId?: number;
  channelId?: number;
}

/** The longest a snippet or description is shown on its one line. */
const LINE_WIDTH = 80;

/**
 * Parse a channel id flag.
 * @param raw - What the person typed.
 * @returns The id.
 * @throws {Error} When it is not a positive whole number.
 */
export function channelIdOf(raw: string): number {
  if (!/^\d+$/.test(raw.trim()) || Number(raw) < 1) {
    throw new Error(
      `--channel takes a channel's id (a number; \`hypotenuse memory channels --bot <bot>\` lists them); got "${raw}".`,
    );
  }
  return Number(raw);
}

/**
 * Parse a version id flag: the `versionId` a document, version, or hit shows.
 * @param raw - What the person typed.
 * @param flag - The flag's name, for the refusal.
 * @returns The version id.
 * @throws {Error} When it is not a positive whole number.
 */
export function versionIdOf(raw: string, flag: string): number {
  if (!/^\d+$/.test(raw.trim()) || Number(raw) < 1) {
    throw new Error(
      `${flag} takes a versionId (a number, as \`memory versions\` shows it); got "${raw}".`,
    );
  }
  return Number(raw);
}

/**
 * Which scope one document command acts on: project with neither `--bot` nor
 * `--channel`, channel with both. One without the other is refused, because
 * channel memory is always one bot's memory of one channel.
 * @param flags - `--bot` and `--channel`.
 * @returns The scope.
 * @throws {Error} When only one of the two is given.
 */
export function documentScope(flags: ScopeFlags): ScopeName {
  const bot = flags.bot !== undefined;
  const channel = flags.channel !== undefined;
  if (bot && channel) return "channel";
  if (!bot && !channel) return "project";
  throw new Error(
    "Channel memory is one bot's memory of one channel: pass both --bot and --channel, or neither for project memory.",
  );
}

/**
 * Which scopes `search` or `list` look in. `--scope` decides when given;
 * otherwise channel with `--bot` and `--channel`, project with neither.
 *
 * | `--scope` | `--bot` + `--channel` | Looks in |
 * |---|---|---|
 * | absent | neither | project |
 * | absent | both | channel |
 * | absent | one of them | refused |
 * | `project` | any | project (a `--bot` sets the half-lives decay is read with) |
 * | `channel` or `both` | both | that |
 * | `channel` or `both` | not both | refused |
 * @param flags - `--scope`, `--bot`, and `--channel`.
 * @returns The scope choice.
 * @throws {Error} For an unknown scope, or a channel scope without both flags.
 */
export function searchScope(flags: ScopeFlags): ScopeChoice {
  if (flags.scope === undefined) return documentScope(flags);
  if (!(SCOPE_CHOICES as readonly string[]).includes(flags.scope)) {
    throw new Error(
      `--scope is one of ${SCOPE_CHOICES.join(", ")}; got "${flags.scope}".`,
    );
  }
  const scope = flags.scope as ScopeChoice;
  if (
    scope !== "project" &&
    (flags.bot === undefined || flags.channel === undefined)
  ) {
    throw new Error(
      `--scope ${scope} reads one bot's memory of one channel: pass --bot and --channel too.`,
    );
  }
  return scope;
}

/**
 * Resolve `--bot` (an id or slug) and `--channel` (an id) into ids.
 * @param ctx - The context.
 * @param projectId - The project.
 * @param flags - The flags.
 * @returns The ids given, undefined where a flag was not.
 */
async function botAndChannel(
  ctx: CliContext,
  projectId: number,
  flags: ScopeFlags,
): Promise<{ botId?: number; channelId?: number }> {
  const channelId =
    flags.channel !== undefined ? channelIdOf(flags.channel) : undefined;
  const botId =
    flags.bot !== undefined
      ? await resolveBotId(ctx.signedInClient(), projectId, flags.bot)
      : undefined;
  return { botId, channelId };
}

/**
 * Resolve where a document command acts.
 * @param ctx - The context.
 * @param projectId - The project.
 * @param flags - `--bot` and `--channel`.
 * @returns The scope and the ids it needs.
 */
async function documentTarget(
  ctx: CliContext,
  projectId: number,
  flags: ScopeFlags,
): Promise<Target> {
  const scope = documentScope(flags);
  return { scope, ...(await botAndChannel(ctx, projectId, flags)) };
}

/**
 * Declare `--bot` and `--channel` on a command.
 * @param command - The command.
 * @returns The same command.
 */
function withScope(command: Command): Command {
  return command
    .option(
      "--bot <bot>",
      "with --channel: the bot whose channel memory this is (id or slug)",
    )
    .option(
      "--channel <id>",
      "with --bot: the channel's id (`memory channels --bot` lists them)",
    );
}

/**
 * Declare `--scope` beside `--bot` and `--channel`, for `search` and `list`.
 * @param command - The command.
 * @returns The same command.
 */
function withScopeChoice(command: Command): Command {
  return withScope(command).option(
    "--scope <scope>",
    "project, channel, or both (default: channel with --bot and --channel, else project)",
  );
}

/**
 * Name a document for a person: `project:facts/a.md` or `channel 3:facts/a.md`.
 * @param doc - Its scope, channel, and path.
 * @returns The label.
 */
export function documentLabel(
  doc: Pick<MemoryDocument, "scope" | "channelId" | "path">,
): string {
  return doc.scope === "project"
    ? `project:${doc.path}`
    : `channel ${doc.channelId ?? "?"}:${doc.path}`;
}

/**
 * How much of a memory's weight is left, as a person reads it.
 * @param decay - In (0, 1]; absent when the action did not compute it.
 * @param pinned - Whether it is pinned, which means it never fades.
 * @returns E.g. `pinned`, `0.82`, or `-`.
 */
export function decayText(decay: number | undefined, pinned: boolean): string {
  if (pinned) return "pinned";
  return decay === undefined ? "-" : decay.toFixed(2);
}

/**
 * Where a version came from, as one phrase.
 * @param doc - The version.
 * @returns E.g. `person (user 4)`, `agent (conversation 12)`, `promotion`.
 */
function sourceText(doc: MemoryDocument): string {
  const p = doc.provenance ?? {};
  if (typeof p.conversationId === "number") {
    return `${doc.sourceType} (conversation ${p.conversationId})`;
  }
  if (typeof p.userId === "number" && doc.sourceType === "person") {
    return `person (user ${p.userId})`;
  }
  if (
    doc.sourceType === "promotion" &&
    typeof p.promotedFromBotId === "number"
  ) {
    return `promotion (bot ${p.promotedFromBotId}, channel ${String(p.promotedFromChannelId ?? "?")})`;
  }
  return doc.sourceType;
}

/**
 * Collapse text onto one line and shorten it.
 * @param text - The text.
 * @returns One line of at most {@link LINE_WIDTH} characters.
 */
function oneLine(text: string): string {
  return truncateMiddle(text.replace(/\s+/g, " ").trim(), LINE_WIDTH);
}

/**
 * Render a document version for a person: what it is, then its text.
 * @param doc - The version, with its content.
 * @param standing - What the caller may do with it, when known.
 * @returns The lines.
 */
export function documentDetail(
  doc: MemoryDocument,
  standing?: { canWrite: boolean; canPromote: boolean },
): string {
  const lines = [
    `${documentLabel(doc)}${doc.forgotten ? " — forgotten" : ""}${doc.current ? "" : " — an earlier version"}`,
    `description   ${doc.description || "-"}`,
    `version       ${doc.versionId} (${when(doc.createdAt)})`,
    `source        ${sourceText(doc)}`,
    `change note   ${doc.changeNote ?? "-"}`,
    `decay         ${decayText(doc.decay, doc.pinned)}`,
    `used          ${doc.accessCount} times, last ${when(doc.lastAccessedAt)}`,
  ];
  if (doc.scope === "channel") lines.push(`bot           ${doc.botId ?? "-"}`);
  if (standing) {
    const can = [
      standing.canWrite ? "change, forget, and pin it" : "read it",
      standing.canPromote ? "promote it" : "",
    ].filter(Boolean);
    lines.push(`you can       ${can.join("; ")}`);
  }
  if (doc.content !== undefined) lines.push("", doc.content.replace(/\n$/, ""));
  return lines.join("\n");
}

/**
 * The line under a listing about the index: which model embeds memory, and
 * how much still waits for a vector.
 * @param index - `index` from `memory:list`.
 * @returns The line.
 */
export function indexLine(index: ListResult["index"]): string {
  if (!index.embeddingModel) {
    return "no embedding model — search is keyword-only until an admin sets the `embedding` alias";
  }
  return index.staleChunks > 0
    ? `embedded with ${index.embeddingModel}; ${index.staleChunks} chunk${index.staleChunks === 1 ? "" : "s"} not embedded yet (\`hypotenuse memory reindex\`)`
    : `embedded with ${index.embeddingModel}`;
}

/**
 * The document text a command was given: the flag's value, or all of
 * standard input when it is `-`.
 * @param raw - The `--text` value.
 * @returns The text.
 * @throws {Error} When it is empty.
 */
async function documentText(raw: string): Promise<string> {
  const text = raw === "-" ? await readAllStdin() : raw;
  if (text.trim() === "") {
    throw new Error(
      raw === "-"
        ? "Standard input was empty; a memory needs some text."
        : "A memory needs some text.",
    );
  }
  return text;
}

/**
 * Register `memory search|list|view|versions|channels|write|forget|pin|promote|reindex`.
 * @param program - The root program.
 */
export function registerMemoryCommands(program: Command): void {
  const memory = program
    .command("memory")
    .description(
      "What the selected project's bots remember: project memory, or with --bot and --channel one bot's memory of one channel",
    );

  withScopeChoice(
    memory
      .command("search")
      .description(
        "Search memory the way a bot does: semantic and keyword ranking fused, weighed by decay",
      )
      .argument("<query>", "what to find")
      .option("--path <prefix>", "only documents under this path")
      .option("--limit <n>", "how many hits, at most 50 (default 10)"),
  ).action(async function (this: Command, query: string) {
    await runCommand(this, async (ctx) => {
      const flags = this.opts() as ScopeFlags & {
        path?: string;
        limit?: string;
      };
      const scope = searchScope(flags);
      const limit =
        flags.limit !== undefined
          ? parseNumber(flags.limit, "--limit")
          : undefined;
      const projectId = await ctx.projectId();
      const ids = await botAndChannel(ctx, projectId, flags);
      const result = await ctx
        .signedInClient()
        .request<SearchResult>("GET", `/project/${projectId}/memory/search`, {
          query: { query, scope, ...ids, pathPrefix: flags.path, limit },
        });
      emit(ctx, result, () => {
        const note =
          result.mode === "keyword"
            ? `\n${dim(`keyword-only: ${result.keywordOnlyReason ?? "no vectors to compare"}`)}`
            : "";
        if (result.hits.length === 0) return `No memories match.${note}`;
        return (
          table(
            result.hits.map((h) => ({
              score: h.score.toFixed(3),
              scope: h.scope,
              path: h.path,
              decay: decayText(h.decay, h.pinned),
              snippet: oneLine(h.snippet),
            })),
            [
              { key: "score" },
              { key: "scope" },
              { key: "path", maxWidth: 40 },
              { key: "decay" },
              { key: "snippet", maxWidth: LINE_WIDTH },
            ],
          ) + note
        );
      });
    });
  });

  withPaging(
    withScopeChoice(
      memory
        .command("list")
        .description("List memory documents by path, with each one's decay")
        .option("--path <prefix>", "only documents under this path")
        .option("--forgotten", "include forgotten documents"),
    ),
  ).action(async function (this: Command) {
    await runCommand(this, async (ctx) => {
      const flags = this.opts() as ScopeFlags & {
        path?: string;
        forgotten?: boolean;
      };
      const scope = searchScope(flags);
      const projectId = await ctx.projectId();
      const ids = await botAndChannel(ctx, projectId, flags);
      const result = await ctx
        .signedInClient()
        .request<ListResult>("GET", `/project/${projectId}/memory`, {
          query: {
            ...pageQuery(this),
            scope,
            ...ids,
            pathPrefix: flags.path,
            includeForgotten: flags.forgotten ? true : undefined,
          },
        });
      emit(ctx, result, () => {
        const footer = `${pageFooter(result.pagination)}\n${dim(indexLine(result.index))}`;
        if (result.documents.length === 0) return `No memories yet.${footer}`;
        return (
          table(
            result.documents.map((d) => ({
              scope: d.scope,
              path: d.path,
              version: d.versionId,
              updated: when(d.createdAt),
              decay: d.forgotten ? "forgotten" : decayText(d.decay, d.pinned),
              description: d.description,
            })),
            [
              { key: "scope" },
              { key: "path", maxWidth: 40 },
              { key: "version" },
              { key: "updated" },
              { key: "decay" },
              { key: "description", maxWidth: 50 },
            ],
          ) + footer
        );
      });
    });
  });

  withScope(
    memory
      .command("view")
      .description(
        "Show a memory document: its text, version, source, and decay",
      )
      .argument("<path>", "the document's path, e.g. facts/deploy.md")
      .option(
        "--version-id <versionId>",
        "an earlier version (`memory versions` lists them)",
      ),
  ).action(async function (this: Command, path: string) {
    await runCommand(this, async (ctx) => {
      const flags = this.opts() as ScopeFlags & { versionId?: string };
      const versionId =
        flags.versionId !== undefined
          ? versionIdOf(flags.versionId, "--version-id")
          : undefined;
      const projectId = await ctx.projectId();
      const target = await documentTarget(ctx, projectId, flags);
      const result = await ctx.signedInClient().request<{
        document: MemoryDocument;
        standing: { canWrite: boolean; canPromote: boolean };
      }>("GET", `/project/${projectId}/memory/document`, {
        query: { ...target, path, versionId },
      });
      emit(ctx, result, () => documentDetail(result.document, result.standing));
    });
  });

  withPaging(
    withScope(
      memory
        .command("versions")
        .description(
          "List a memory document's versions, newest first, with who or what made each",
        )
        .argument("<path>", "the document's path"),
    ),
  ).action(async function (this: Command, path: string) {
    await runCommand(this, async (ctx) => {
      const flags = this.opts() as ScopeFlags;
      const projectId = await ctx.projectId();
      const target = await documentTarget(ctx, projectId, flags);
      const result = await ctx
        .signedInClient()
        .request<Paginated<"versions", MemoryDocument>>(
          "GET",
          `/project/${projectId}/memory/document/versions`,
          { query: { ...pageQuery(this), ...target, path } },
        );
      emit(
        ctx,
        result,
        () =>
          table(
            result.versions.map((v) => ({
              version: v.versionId,
              when: when(v.createdAt),
              current: v.current ? "yes" : "",
              source: v.forgotten ? "forgotten" : sourceText(v),
              note: v.changeNote ?? "",
            })),
            [
              { key: "version" },
              { key: "when" },
              { key: "current" },
              { key: "source", maxWidth: 40 },
              { key: "note", maxWidth: 50 },
            ],
          ) + pageFooter(result.pagination),
      );
    });
  });

  withPaging(
    memory
      .command("channels")
      .description(
        "List the channels a bot works in, and how many documents it remembers about each",
      )
      .requiredOption("--bot <bot>", "the bot: id or slug"),
  ).action(async function (this: Command) {
    await runCommand(this, async (ctx) => {
      const flags = this.opts() as { bot: string };
      const client = ctx.signedInClient();
      const projectId = await ctx.projectId();
      const botId = await resolveBotId(client, projectId, flags.bot);
      const result = await client.request<Paginated<"channels", MemoryChannel>>(
        "GET",
        `/project/${projectId}/bot/${botId}/memory/channels`,
        { query: pageQuery(this) },
      );
      emit(
        ctx,
        result,
        () =>
          table(
            result.channels.map((c) => ({
              id: c.id,
              type: c.type,
              name: c.name,
              documents: c.documents,
            })),
            [
              { key: "id" },
              { key: "type" },
              { key: "name", maxWidth: 40 },
              { key: "documents" },
            ],
          ) + pageFooter(result.pagination),
      );
    });
  });

  withScope(
    memory
      .command("write")
      .description(
        "Write a memory document as a new version; earlier versions are kept",
      )
      .argument("<path>", "the document's path, e.g. facts/deploy.md")
      .requiredOption(
        "--text <text>",
        "the whole document, as markdown; - reads it from standard input",
      )
      .option(
        "--description <text>",
        "one line on what it is about (default: kept, or its first line)",
      )
      .option("--note <text>", "why it changed")
      .option(
        "--base <versionId>",
        "refuse the write if the document changed since this version",
      ),
  ).action(async function (this: Command, path: string) {
    await runCommand(this, async (ctx) => {
      const flags = this.opts() as ScopeFlags & {
        text: string;
        description?: string;
        note?: string;
        base?: string;
      };
      const baseVersionId =
        flags.base !== undefined
          ? versionIdOf(flags.base, "--base")
          : undefined;
      const content = await documentText(flags.text);
      const projectId = await ctx.projectId();
      const target = await documentTarget(ctx, projectId, flags);
      const result = await ctx
        .signedInClient()
        .request<{ document: MemoryDocument }>(
          "PUT",
          `/project/${projectId}/memory/document`,
          {
            body: {
              ...target,
              path,
              content,
              description: flags.description,
              changeNote: flags.note,
              baseVersionId,
            },
          },
        );
      const d = result.document;
      emit(
        ctx,
        result,
        () => `Wrote ${documentLabel(d)} (version ${d.versionId})`,
      );
    });
  });

  withScope(
    memory
      .command("forget")
      .description(
        "Forget a memory document: search and lists stop showing it, and its history is kept",
      )
      .argument("<path>", "the document's path")
      .option("--reason <text>", "why it is forgotten"),
  ).action(async function (this: Command, path: string) {
    await runCommand(this, async (ctx) => {
      const flags = this.opts() as ScopeFlags & { reason?: string };
      const projectId = await ctx.projectId();
      const target = await documentTarget(ctx, projectId, flags);
      const result = await ctx
        .signedInClient()
        .request<{ document: MemoryDocument }>(
          "DELETE",
          `/project/${projectId}/memory/document`,
          { body: { ...target, path, reason: flags.reason } },
        );
      emit(ctx, result, () => `Forgot ${documentLabel(result.document)}`);
    });
  });

  withScope(
    memory
      .command("pin")
      .description("Pin a memory document so it never fades, or unpin it")
      .argument("<path>", "the document's path")
      .option("--unpin", "let it fade again"),
  ).action(async function (this: Command, path: string) {
    await runCommand(this, async (ctx) => {
      const flags = this.opts() as ScopeFlags & { unpin?: boolean };
      const projectId = await ctx.projectId();
      const target = await documentTarget(ctx, projectId, flags);
      const result = await ctx
        .signedInClient()
        .request<{ document: MemoryDocument }>(
          "POST",
          `/project/${projectId}/memory/document/pin`,
          { body: { ...target, path, pinned: !flags.unpin } },
        );
      emit(
        ctx,
        result,
        () =>
          `${result.document.pinned ? "Pinned" : "Unpinned"} ${documentLabel(result.document)}`,
      );
    });
  });

  memory
    .command("promote")
    .description(
      "Copy a bot's channel memory document into project memory, where every bot reads it",
    )
    .argument("<path>", "the channel document's path")
    .requiredOption("--bot <bot>", "the bot whose channel memory it is")
    .requiredOption("--channel <id>", "the channel's id")
    .option("--to <path>", "its path in project memory (default: the same)")
    .option(
      "--version-id <versionId>",
      "promote this version (default: the current one)",
    )
    .option("--note <text>", "why it is promoted")
    .action(async function (this: Command, path: string) {
      await runCommand(this, async (ctx) => {
        const flags = this.opts() as {
          bot: string;
          channel: string;
          to?: string;
          versionId?: string;
          note?: string;
        };
        const versionId =
          flags.versionId !== undefined
            ? versionIdOf(flags.versionId, "--version-id")
            : undefined;
        const projectId = await ctx.projectId();
        const ids = await botAndChannel(ctx, projectId, flags);
        const result = await ctx.signedInClient().request<{
          document: MemoryDocument;
          promotedFrom: MemoryDocument;
        }>("POST", `/project/${projectId}/memory/document/promote`, {
          body: {
            ...ids,
            path,
            versionId,
            targetPath: flags.to,
            changeNote: flags.note,
          },
        });
        emit(
          ctx,
          result,
          () =>
            `Promoted ${documentLabel(result.promotedFrom)} to ${documentLabel(result.document)} (version ${result.document.versionId})`,
        );
      });
    });

  memory
    .command("reindex")
    .description(
      "Re-embed every chunk without a vector from the current embedding model, in the background (admin)",
    )
    .action(async function (this: Command) {
      await runCommand(this, async (ctx) => {
        const projectId = await ctx.projectId();
        const result = await ctx.signedInClient().request<{
          embeddingModel: string | null;
          queuedChunks: number;
        }>("POST", `/project/${projectId}/memory/reindex`);
        emit(ctx, result, () => {
          if (!result.embeddingModel) {
            return "There is no embedding model, so nothing can be embedded. Set the `embedding` alias first (`hypotenuse model alias set embedding --kind embedding …`).";
          }
          return result.queuedChunks > 0
            ? `Queued ${result.queuedChunks} chunk${result.queuedChunks === 1 ? "" : "s"} for ${result.embeddingModel}; search ranks them by keyword until they are embedded`
            : `Every chunk is already embedded with ${result.embeddingModel}`;
        });
      });
    });
}
