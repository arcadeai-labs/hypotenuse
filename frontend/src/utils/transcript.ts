import type { AgentSessionActivities } from "@backend/actions/agent-session/agent-session-activities";
import type { AgentSessionView } from "@backend/actions/agent-session/agent-session-view";
import type { ActionResponse } from "keryx";

/**
 * The session transcript's pure passes: merge pages of activities, decide
 * which ephemeral lines Linear has replaced, split the log into turns, pin
 * the plan to the turn that last changed it, collapse long results, and
 * order the links. No React here, so every rule has a unit test
 * (`transcript.test.ts`).
 */

/** One activity as `agent-session:activities` serializes it. */
export type TranscriptActivity =
  ActionResponse<AgentSessionActivities>["activities"][number];

/** One turn as `agent-session:view` serializes it. */
export type SessionTurn = ActionResponse<AgentSessionView>["workItems"][number];

/** One external link on a session. */
export type SessionLink =
  ActionResponse<AgentSessionView>["agentSession"]["externalUrls"][number];

/** How many lines of an action's result show before it collapses. */
export const RESULT_PREVIEW_LINES = 8;

/**
 * Merge a newly read page into what is on screen: by id, newest copy wins
 * (a row's delivery status moves), ordered by `seq`.
 * @param existing - What the page already holds.
 * @param incoming - What was just read.
 * @returns A new array.
 */
export function mergeActivities(
  existing: TranscriptActivity[],
  incoming: TranscriptActivity[],
): TranscriptActivity[] {
  const byId = new Map(existing.map((a) => [a.id, a]));
  for (const a of incoming) byId.set(a.id, a);
  return [...byId.values()].sort((a, b) => a.seq - b.seq || a.id - b.id);
}

/** One line of the transcript, with what the passes decided about it. */
export interface TranscriptEntry {
  activity: TranscriptActivity;
  /**
   * An ephemeral line Linear has replaced (a later activity followed it) or
   * the outbox superseded before sending. Shown struck through and collapsed:
   * it is still part of what the agent said.
   */
  replaced: boolean;
  /** The ephemeral line still standing at the bottom: the live line. */
  live: boolean;
}

/**
 * The transcript's lines: every activity but session updates (plan, summary,
 * and link changes, which the page shows in their own places) and issue
 * attachments, with each ephemeral line marked replaced or live.
 * @param activities - The session's activities, in `seq` order.
 * @returns One entry per line.
 */
export function transcriptEntries(
  activities: TranscriptActivity[],
): TranscriptEntry[] {
  const lines = activities.filter((a) => a.kind === "activity");
  return lines.map((activity, index) => {
    const later = lines
      .slice(index + 1)
      .some((a) => a.direction === "outbound");
    const replaced =
      activity.ephemeral && (activity.deliveryStatus === "superseded" || later);
    return {
      activity,
      replaced,
      live: activity.ephemeral && !replaced,
    };
  });
}

/** A turn and the transcript lines that belong to it. */
export interface TurnGroup {
  /** The work item, or null for lines before the first turn. */
  turn: SessionTurn | null;
  entries: TranscriptEntry[];
}

/**
 * Split the transcript into turns. A line belongs to the latest turn created
 * at or before it; a person's prompt that started a turn is drawn under that
 * turn's separator, not at the end of the one before.
 * @param entries - The transcript lines, in order.
 * @param turns - The session's work items.
 * @returns The groups, in order. Turns with no lines yet are kept.
 */
export function groupByTurn(
  entries: TranscriptEntry[],
  turns: SessionTurn[],
): TurnGroup[] {
  const ordered = [...turns].sort(
    (a, b) => a.createdAt - b.createdAt || a.id - b.id,
  );
  const groups: TurnGroup[] = [
    { turn: null, entries: [] },
    ...ordered.map((turn) => ({ turn, entries: [] as TranscriptEntry[] })),
  ];
  for (const entry of entries) {
    let index = 0;
    for (let i = 0; i < ordered.length; i++) {
      if (ordered[i].createdAt <= entry.activity.createdAt) index = i + 1;
    }
    groups[index].entries.push(entry);
  }
  // A prompt that started a turn lands just before that turn's creation;
  // move a trailing run of inbound prompts forward into the next turn.
  for (let i = 0; i < groups.length - 1; i++) {
    const from = groups[i].entries;
    const moved: TranscriptEntry[] = [];
    while (
      from.length > 0 &&
      from[from.length - 1].activity.direction === "inbound" &&
      groups[i + 1].turn?.kind === "prompt"
    ) {
      moved.unshift(from.pop() as TranscriptEntry);
    }
    groups[i + 1].entries.unshift(...moved);
  }
  return groups.filter((g) => g.turn !== null || g.entries.length > 0);
}

/**
 * The turn the plan card is pinned to: the one holding the last session
 * update that carried a plan, else the last turn.
 * @param activities - Every activity, session updates included.
 * @param groups - The turn groups.
 * @returns The index into `groups`, or -1 when there are none.
 */
export function planTurnIndex(
  activities: TranscriptActivity[],
  groups: TurnGroup[],
): number {
  if (groups.length === 0) return -1;
  const update = [...activities]
    .reverse()
    .find(
      (a) =>
        a.kind === "session_update" &&
        typeof a.content === "object" &&
        a.content !== null &&
        "plan" in a.content,
    );
  if (!update) return groups.length - 1;
  let index = groups.length - 1;
  for (let i = 0; i < groups.length; i++) {
    const turn = groups[i].turn;
    if (turn && turn.createdAt <= update.createdAt) index = i;
  }
  return index;
}

/**
 * Split a result into what shows and how much is folded away.
 * @param text - The result.
 * @param maxLines - How many lines show.
 * @returns The visible head and the number of hidden lines.
 */
export function collapseResult(
  text: string,
  maxLines = RESULT_PREVIEW_LINES,
): { head: string; hidden: number } {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return { head: text, hidden: 0 };
  return {
    head: lines.slice(0, maxLines).join("\n"),
    hidden: lines.length - maxLines,
  };
}

/**
 * A session's links in the order the page lists them: pull requests first,
 * then the rest as written.
 * @param links - `externalUrls`.
 * @returns A new array.
 */
export function orderLinks(links: SessionLink[]): SessionLink[] {
  const isPr = (l: SessionLink) => /^pull request/i.test(l.label);
  return [...links.filter(isPr), ...links.filter((l) => !isPr(l))];
}

/** A turn status that can still produce activities. */
export const LIVE_TURN_STATUSES: ReadonlySet<string> = new Set([
  "queued",
  "offered",
  "claimed",
  "running",
]);

/**
 * Whether the dashboard's Cancel has anything to do: a turn not yet over, or
 * a session waiting on a person (the server answers it).
 * @param status - The session's status.
 * @param turns - Its work items.
 * @returns True when Cancel should be enabled.
 */
export function canCancelSession(
  status: string,
  turns: Pick<SessionTurn, "status">[],
): boolean {
  return (
    status === "awaitingInput" ||
    turns.some((t) => LIVE_TURN_STATUSES.has(t.status))
  );
}

/**
 * The text body of an activity's content, whatever its type.
 * @param content - The activity's content.
 * @returns The body, or an empty string.
 */
export function bodyOf(content: unknown): string {
  if (typeof content !== "object" || content === null) return "";
  const body = (content as { body?: unknown }).body;
  return typeof body === "string" ? body : "";
}

/** An action's three parts. */
export interface ActionContent {
  action: string;
  parameter: string;
  result: string | null;
}

/**
 * Read an `action` activity's content.
 * @param content - The activity's content.
 * @returns Its verb, parameter, and result.
 */
export function actionOf(content: unknown): ActionContent {
  const c = (
    typeof content === "object" && content !== null ? content : {}
  ) as Record<string, unknown>;
  return {
    action: typeof c.action === "string" ? c.action : "",
    parameter: typeof c.parameter === "string" ? c.parameter : "",
    result: typeof c.result === "string" ? c.result : null,
  };
}

/**
 * The options a `select` elicitation offered, as Linear's signal metadata
 * carries them.
 * @param metadata - The activity's `signalMetadata`.
 * @returns The option labels, in order.
 */
export function selectOptions(metadata: unknown): string[] {
  const options = (metadata as { options?: unknown } | null)?.options;
  if (!Array.isArray(options)) return [];
  return options
    .map((o) => {
      if (typeof o === "string") return o;
      const opt = o as { label?: unknown; value?: unknown };
      return typeof opt.label === "string"
        ? opt.label
        : typeof opt.value === "string"
          ? opt.value
          : "";
    })
    .filter((label) => label.length > 0);
}

/**
 * How long a turn ran, or has been running.
 * @param turn - The work item.
 * @param now - The current time, epoch ms.
 * @returns e.g. `6m 12s`, or null before it was claimed.
 */
export function turnDuration(
  turn: Pick<SessionTurn, "claimedAt" | "finishedAt">,
  now: number,
): string | null {
  if (turn.claimedAt === null) return null;
  const ms = Math.max(0, (turn.finishedAt ?? now) - turn.claimedAt);
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
