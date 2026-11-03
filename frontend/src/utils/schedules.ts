/**
 * Schedules as the dashboard words them: a slot in the viewer's own zone,
 * what a target means, and what each run status says happened.
 */

/** A run's statuses, as the server names them. */
export const RUN_STATUS_LABELS: Record<string, string> = {
  pending: "Pending",
  guarding: "Checking guard",
  skipped: "Skipped",
  woken: "Working",
  silent: "Nothing to say",
  posted: "Posted",
  failed: "Failed",
};

/**
 * The status colour of a run, as a `--status-*` token's name: a run still
 * going is `active`, one that posted is `complete`, one that stayed quiet or
 * was skipped is `idle`, and a failure is `error`.
 * @param status - The run's status.
 * @returns The token suffix.
 */
export function runTone(
  status: string,
): "active" | "complete" | "idle" | "error" {
  if (status === "failed") return "error";
  if (status === "posted") return "complete";
  if (status === "skipped" || status === "silent") return "idle";
  return "active";
}

/** The target types, worded for a picker. */
export const TARGET_LABELS: Record<string, string> = {
  channel: "A channel — a new conversation each time",
  conversation: "One conversation — a new turn in it",
  none: "Nowhere — memory and goals only",
};

/**
 * A target in a few words.
 * @param s - The schedule's target.
 * @param channelName - The channel's name, when known.
 * @returns The phrase.
 */
export function targetSummary(
  s: {
    targetType: string;
    channelId: number | null;
    conversationId: number | null;
  },
  channelName?: string,
): string {
  if (s.targetType === "channel") {
    return channelName
      ? `New conversation in #${channelName}`
      : "New conversation in a channel";
  }
  if (s.targetType === "conversation") {
    return `Turn in conversation #${s.conversationId}`;
  }
  return "Nothing posted";
}

/**
 * A slot in a time zone, the way a person reads it.
 * @param ms - The slot, epoch ms.
 * @param timeZone - The zone to show it in (the viewer's by default).
 * @returns E.g. "Mon, Nov 9, 09:00".
 */
export function formatSlot(ms: number, timeZone?: string): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    ...(timeZone ? { timeZone } : {}),
  }).format(new Date(ms));
}

/**
 * The viewer's own IANA zone, the default for a new schedule.
 * @returns The zone, or `UTC` when the browser does not say.
 */
export function viewerTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** A schedule's fields, as typed. */
export interface ScheduleDraft {
  name: string;
  kind: string;
  targetType: string;
  channelId: string;
  conversationId: string;
  cron: string;
  timeZone: string;
  instruction: string;
  guard: string;
  catchUp: string;
}

/**
 * A draft as `schedule:create` or `schedule:edit` takes it.
 * @param d - The draft.
 * @returns The body.
 */
export function scheduleBody(d: ScheduleDraft): Record<string, unknown> {
  return {
    name: d.name.trim(),
    kind: d.kind,
    targetType: d.targetType,
    ...(d.targetType === "channel" && d.channelId
      ? { channelId: Number(d.channelId) }
      : {}),
    ...(d.targetType === "conversation" && d.conversationId
      ? { conversationId: Number(d.conversationId) }
      : {}),
    cron: d.cron.trim(),
    timeZone: d.timeZone.trim() || "UTC",
    instruction: d.instruction.trim(),
    guard: d.guard.trim() ? d.guard.trim() : null,
    catchUp: d.catchUp,
  };
}

/** Cron shapes people reach for, offered beside the field. */
export const CRON_EXAMPLES: { cron: string; label: string }[] = [
  { cron: "0 9 * * 1", label: "Mondays at 09:00" },
  { cron: "0 9 * * 1-5", label: "Weekdays at 09:00" },
  { cron: "0 17 * * 5", label: "Fridays at 17:00" },
  { cron: "0 * * * *", label: "Every hour" },
];
