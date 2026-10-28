/**
 * The states a status glyph stands for, and the glyph, token, and words for
 * each. The web kit (`frontend/src/ui/StatusGlyph.tsx`) and the CLI palette
 * (`cli/src/output/theme.ts`) both import these names, so a renamed state is a
 * type error in both. The spec is docs/DESIGN.md#status-glyphs.
 *
 * Like `tokens.ts`, this file has no dependencies: every workspace may read it
 * without a dependency edge between them.
 */

/** Where a conversation is in its life. `waiting` always names what it waits on. */
export const CONVERSATION_STATES = [
  "working",
  "hibernating",
  "waiting",
  "ended",
] as const;
export type ConversationState = (typeof CONVERSATION_STATES)[number];

/** What a `waiting` conversation is waiting on. */
export const WAITING_ON = ["answer", "approval", "sandbox", "timer"] as const;
export type WaitingOn = (typeof WAITING_ON)[number];

/** How an `ended` conversation ended. */
export const CONVERSATION_OUTCOMES = ["complete", "failed"] as const;
export type ConversationOutcome = (typeof CONVERSATION_OUTCOMES)[number];

/** Where a sandbox job is in its life. */
export const SANDBOX_JOB_STATES = [
  "provisioning",
  "running",
  "complete",
  "failed",
] as const;
export type SandboxJobState = (typeof SANDBOX_JOB_STATES)[number];

/** A conversation's state, with the detail `waiting` and `ended` carry. */
export type ConversationStatus =
  | { state: "working" }
  | { state: "hibernating" }
  | { state: "waiting"; waitingOn: WaitingOn }
  | { state: "ended"; outcome: ConversationOutcome };

/** A conversation status flattened to one name: `working`, `waiting:answer`, `ended:failed`, …. */
export type ConversationStatusKey =
  | "working"
  | "hibernating"
  | `waiting:${WaitingOn}`
  | `ended:${ConversationOutcome}`;

/**
 * The shapes. Rings are in progress, discs are finished, a centre dot means a
 * person is needed. Each kind is one drawing on the web and one character in
 * the terminal, painted with one generated token.
 */
export const GLYPH_KINDS = {
  working: { token: "status-active", unicode: "◔", ascii: "*" },
  hibernating: { token: "status-idle", unicode: "○", ascii: "o" },
  "waiting-person": { token: "status-waiting", unicode: "◉", ascii: "?" },
  "waiting-system": { token: "status-pending", unicode: "◷", ascii: "~" },
  complete: { token: "status-complete", unicode: "✓", ascii: "v" },
  failed: { token: "status-error", unicode: "✕", ascii: "x" },
  provisioning: { token: "status-pending", unicode: "◌", ascii: "." },
  stale: { token: "status-stale", unicode: "◦", ascii: "-" },
} as const satisfies Record<
  string,
  { token: string; unicode: string; ascii: string }
>;
export type GlyphKind = keyof typeof GLYPH_KINDS;

/** The glyph and the words for every conversation status. */
export const CONVERSATION_STATUS: Record<
  ConversationStatusKey,
  { glyph: GlyphKind; label: string }
> = {
  working: { glyph: "working", label: "Working" },
  hibernating: { glyph: "hibernating", label: "Hibernating" },
  "waiting:answer": { glyph: "waiting-person", label: "Waiting for an answer" },
  "waiting:approval": { glyph: "waiting-person", label: "Waiting for approval" },
  "waiting:sandbox": { glyph: "waiting-system", label: "Waiting on a sandbox" },
  "waiting:timer": { glyph: "waiting-system", label: "Waiting on a timer" },
  "ended:complete": { glyph: "complete", label: "Complete" },
  "ended:failed": { glyph: "failed", label: "Failed" },
};

/** The glyph and the words for every sandbox job state. */
export const SANDBOX_JOB_STATUS: Record<
  SandboxJobState,
  { glyph: GlyphKind; label: string }
> = {
  provisioning: { glyph: "provisioning", label: "Provisioning" },
  running: { glyph: "working", label: "Running" },
  complete: { glyph: "complete", label: "Complete" },
  failed: { glyph: "failed", label: "Failed" },
};

/**
 * Flatten a conversation status to its key.
 * @param status - The state, with `waitingOn` or `outcome` where it has one.
 * @returns `working`, `waiting:approval`, `ended:complete`, ….
 */
export function conversationStatusKey(
  status: ConversationStatus,
): ConversationStatusKey {
  switch (status.state) {
    case "waiting":
      return `waiting:${status.waitingOn}`;
    case "ended":
      return `ended:${status.outcome}`;
    default:
      return status.state;
  }
}

/**
 * Undo {@link conversationStatusKey}.
 * @param key - `working`, `waiting:approval`, `ended:complete`, ….
 * @returns The status it names.
 */
export function conversationStatusFromKey(
  key: ConversationStatusKey,
): ConversationStatus {
  const [state, detail] = key.split(":") as [string, string | undefined];
  if (state === "waiting") return { state, waitingOn: detail as WaitingOn };
  if (state === "ended")
    return { state, outcome: detail as ConversationOutcome };
  return { state: state as "working" | "hibernating" };
}

/** Every conversation status, in the order a grouped list shows them: a person first. */
export const CONVERSATION_STATUS_ORDER: readonly ConversationStatusKey[] = [
  "waiting:answer",
  "waiting:approval",
  "working",
  "waiting:sandbox",
  "waiting:timer",
  "hibernating",
  "ended:failed",
  "ended:complete",
];

/** The platforms a conversation can live on. `api` is the HTTP API channel. */
export const PLATFORMS = ["slack", "linear", "pylon", "api"] as const;
export type Platform = (typeof PLATFORMS)[number];

/** How each platform is written in a chip: as text, never a logo. */
export const PLATFORM_LABELS: Record<Platform, string> = {
  slack: "Slack",
  linear: "Linear",
  pylon: "Pylon",
  api: "API",
};
