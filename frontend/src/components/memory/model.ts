import type { MemoryChannels } from "@backend/actions/memory/memory-channels";
import type { MemoryList } from "@backend/actions/memory/memory-list";
import type { MemorySearch } from "@backend/actions/memory/memory-search";
import type { MemoryVersions } from "@backend/actions/memory/memory-versions";
import type { MemoryView } from "@backend/actions/memory/memory-view";
import type { ActionResponse } from "keryx";

/** `memory:list`'s answer. */
export type MemoryListResponse = ActionResponse<MemoryList>;

/** A document row of `memory:list`, with its decay. */
export type MemoryDocumentRow = MemoryListResponse["documents"][number];

/** `memory:search`'s answer. */
export type MemorySearchResponse = ActionResponse<MemorySearch>;

/** One hit of `memory:search`. */
export type MemoryHit = MemorySearchResponse["hits"][number];

/** `memory:view`'s answer: the document, with its text, and the caller's standing. */
export type MemoryViewResponse = ActionResponse<MemoryView>;

/** A document as `memory:view` serializes it. */
export type MemoryDocumentView = MemoryViewResponse["document"];

/** `memory:versions`'s answer. */
export type MemoryVersionsResponse = ActionResponse<MemoryVersions>;

/** One version of a document, with its text. */
export type MemoryVersion = MemoryVersionsResponse["versions"][number];

/** `memory:channels`'s answer. */
export type MemoryChannelsResponse = ActionResponse<MemoryChannels>;

/** One channel a bot works in, with how many documents it remembers there. */
export type MemoryChannel = MemoryChannelsResponse["channels"][number];

/** Where a document lives: the project, or one bot's memory of one channel. */
export type MemoryWhere =
  | { scope: "project" }
  | { scope: "channel"; botId: number; channelId: number };

/** The page size of the explorer's document list. */
export const MEMORY_PAGE_SIZE = 25;

/**
 * The query string naming where a document lives, as every memory action
 * takes it.
 * @param where - The project, or a bot's channel.
 * @returns `scope=…` with the bot and channel when it is a channel's.
 */
function whereParams(where: MemoryWhere): URLSearchParams {
  const params = new URLSearchParams({ scope: where.scope });
  if (where.scope === "channel") {
    params.set("botId", String(where.botId));
    params.set("channelId", String(where.channelId));
  }
  return params;
}

/**
 * The body naming where a document lives, for the write actions.
 * @param where - The project, or a bot's channel.
 * @returns `{ scope }`, with `botId` and `channelId` for a channel.
 */
export function whereBody(where: MemoryWhere): Record<string, unknown> {
  return where.scope === "channel"
    ? { scope: "channel", botId: where.botId, channelId: where.channelId }
    : { scope: "project" };
}

/**
 * `memory:list`'s route for one scope and page.
 * @param projectId - The project.
 * @param where - The project, or a bot's channel.
 * @param options - The page, a path prefix, and whether forgotten documents are listed.
 * @returns The path beneath `/api`.
 */
export function memoryListPath(
  projectId: number,
  where: MemoryWhere,
  options: { page?: number; pathPrefix?: string; includeForgotten?: boolean },
): string {
  const params = whereParams(where);
  params.set("limit", String(MEMORY_PAGE_SIZE));
  if (options.page && options.page > 1)
    params.set("page", String(options.page));
  if (options.pathPrefix) params.set("pathPrefix", options.pathPrefix);
  if (options.includeForgotten) params.set("includeForgotten", "true");
  return `/project/${projectId}/memory?${params}`;
}

/**
 * `memory:search`'s route. A channel's search may reach into project memory
 * too (`both`), which is what its bot sees.
 * @param projectId - The project.
 * @param where - The project, or a bot's channel.
 * @param query - What to find.
 * @param withProject - For a channel, also search project memory.
 * @returns The path beneath `/api`.
 */
export function memorySearchPath(
  projectId: number,
  where: MemoryWhere,
  query: string,
  withProject = false,
): string {
  const params = whereParams(where);
  if (where.scope === "channel" && withProject) params.set("scope", "both");
  params.set("query", query);
  params.set("limit", "20");
  return `/project/${projectId}/memory/search?${params}`;
}

/**
 * `memory:view`'s or `memory:versions`' route for one document.
 * @param projectId - The project.
 * @param where - The project, or a bot's channel.
 * @param path - The document's path.
 * @param options - `versions` for the history, `versionId` for an earlier version.
 * @returns The path beneath `/api`.
 */
export function memoryDocumentPath(
  projectId: number,
  where: MemoryWhere,
  path: string,
  options: { versions?: boolean; versionId?: number | null } = {},
): string {
  const params = whereParams(where);
  params.set("path", path);
  if (options.versions) params.set("limit", "50");
  if (options.versionId) params.set("versionId", String(options.versionId));
  return `/project/${projectId}/memory/document${options.versions ? "/versions" : ""}?${params}`;
}

/**
 * The dashboard's address of an explorer: the project's memory, or one bot's
 * memory of one channel.
 * @param where - The project, or a bot's channel.
 * @returns The route.
 */
export function explorerHref(where: MemoryWhere): string {
  return where.scope === "channel"
    ? `/bots/${where.botId}/memory/${where.channelId}`
    : "/memory";
}

/**
 * The dashboard's address of a document, at a version when one is named.
 * @param where - The project, or a bot's channel.
 * @param path - The document's path.
 * @param versionId - An earlier version, or nothing for the current one.
 * @returns The route.
 */
export function documentHref(
  where: MemoryWhere,
  path: string,
  versionId?: number | null,
): string {
  const params = new URLSearchParams({ path });
  if (versionId) params.set("version", String(versionId));
  return `${explorerHref(where)}/document?${params}`;
}

/**
 * A transcript address that marks the entries a memory came from.
 * @param conversationId - The conversation.
 * @param seqs - The entries, if any.
 * @returns The route.
 */
export function transcriptHref(
  conversationId: number,
  seqs?: readonly number[],
): string {
  return seqs && seqs.length > 0
    ? `/conversations/${conversationId}?seqs=${seqs.join(",")}`
    : `/conversations/${conversationId}`;
}

/**
 * Read a `seqs` query value back into the entries to mark.
 * @param value - `?seqs=` as written by {@link transcriptHref}, or `null`.
 * @returns The seqs; empty for none or nonsense.
 */
export function parseSeqs(value: string | null): Set<number> {
  const seqs = new Set<number>();
  for (const part of (value ?? "").split(",")) {
    const n = Number(part.trim());
    if (part.trim() !== "" && Number.isSafeInteger(n) && n > 0) seqs.add(n);
  }
  return seqs;
}

/**
 * How a memory's decay reads on hover: how fresh it is, and how fast it fades.
 * @param decay - The factor, 0–1.
 * @param halfLifeDays - The scope's half-life in days.
 * @param pinned - Pinned memories never fade.
 * @returns The sentence.
 */
export function decayTitle(
  decay: number,
  halfLifeDays: number,
  pinned: boolean,
): string {
  const percent = Math.round(Math.min(1, Math.max(0, decay)) * 100);
  if (pinned) return `${percent}% fresh — pinned, so it never fades`;
  return `${percent}% fresh — unused, it loses half its weight every ${halfLifeDays} ${halfLifeDays === 1 ? "day" : "days"}`;
}

/**
 * The half-life a document fades with, by its scope.
 * @param scope - `channel` or `project`.
 * @param halfLifeDays - `memory:list`'s half-lives.
 * @returns Days.
 */
export function halfLifeOf(
  scope: string,
  halfLifeDays: { channel: number; project: number },
): number {
  return scope === "channel" ? halfLifeDays.channel : halfLifeDays.project;
}

/**
 * A score, a relevance, or a decay as the explorer prints it.
 * @param value - A number in [0, 1].
 * @returns Two decimals.
 */
export function formatScore(value: number): string {
  return value.toFixed(2);
}

/** The words each source of a version is described with. */
export const SOURCE_LABELS: Record<string, string> = {
  agent: "Written by the bot",
  person: "Written by a person",
  consolidation: "Learned from a conversation",
  promotion: "Promoted from a channel",
  decay: "Faded from disuse",
};

/**
 * What wrote a version, in words.
 * @param sourceType - The version's `sourceType`.
 * @returns The label.
 */
export function sourceLabel(sourceType: string): string {
  return SOURCE_LABELS[sourceType] ?? sourceType;
}

/** Whether a write was refused because someone else changed the document first. */
export const STALE_BASE = /changed since version/;

/** One line of a diff. */
export interface DiffLine {
  kind: "same" | "add" | "remove";
  text: string;
}

/** Above this many cells the diff stops looking for common lines. */
const DIFF_CELL_LIMIT = 4_000_000;

/**
 * A line diff from `before` to `after`: the longest common subsequence of
 * lines kept, the rest removed or added. Past a size where that would be
 * slow, everything is shown removed then added.
 * @param before - The older text.
 * @param after - The newer text.
 * @returns The lines in order, each kept, removed, or added.
 */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  // Trim the common head and tail, which is most of an edit.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  )
    tail++;
  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);
  const out: DiffLine[] = a
    .slice(0, head)
    .map((text) => ({ kind: "same", text }));

  if (midA.length * midB.length > DIFF_CELL_LIMIT) {
    for (const text of midA) out.push({ kind: "remove", text });
    for (const text of midB) out.push({ kind: "add", text });
  } else {
    // lcs[i][j]: the common lines of midA[i…] and midB[j…].
    const n = midA.length;
    const m = midB.length;
    const lcs: Uint32Array[] = Array.from(
      { length: n + 1 },
      () => new Uint32Array(m + 1),
    );
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i][j] =
          midA[i] === midB[j]
            ? lcs[i + 1][j + 1] + 1
            : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) {
        out.push({ kind: "same", text: midA[i] });
        i++;
        j++;
      } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
        out.push({ kind: "remove", text: midA[i] });
        i++;
      } else {
        out.push({ kind: "add", text: midB[j] });
        j++;
      }
    }
    for (; i < n; i++) out.push({ kind: "remove", text: midA[i] });
    for (; j < m; j++) out.push({ kind: "add", text: midB[j] });
  }

  for (const text of a.slice(a.length - tail)) out.push({ kind: "same", text });
  return out;
}

/**
 * How many lines a diff adds and removes.
 * @param diff - See {@link lineDiff}.
 * @returns The two counts.
 */
export function diffStats(diff: readonly DiffLine[]): {
  added: number;
  removed: number;
} {
  let added = 0;
  let removed = 0;
  for (const line of diff) {
    if (line.kind === "add") added++;
    else if (line.kind === "remove") removed++;
  }
  return { added, removed };
}

/**
 * Whether a path is one `memory:write` takes: slash-separated segments of
 * letters, digits, dots, dashes, and underscores, at most 200 characters,
 * never `.` or `..`. The server is the judge; this only spares a round trip.
 * @param path - What was typed.
 * @returns A sentence saying what is wrong, or `null`.
 */
export function pathProblem(path: string): string | null {
  const p = path.trim().replace(/^\/+/, "").replace(/\/+$/, "");
  if (p === "")
    return "A memory needs a path, such as facts/deploy-process.md.";
  if (p.length > 200) return "A path is at most 200 characters.";
  for (const segment of p.split("/")) {
    if (segment === "." || segment === "..")
      return "A path cannot climb out of memory with . or ..";
    if (!/^[A-Za-z0-9._-]+$/.test(segment))
      return "A path is slash-separated words of letters, digits, dots, dashes, and underscores, such as facts/deploy-process.md.";
  }
  return null;
}
