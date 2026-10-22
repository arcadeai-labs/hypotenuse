/**
 * What a webhook delivery's outcome means for the person reading the
 * integration card: the badge's tone, and a sentence for the outcomes that
 * ask for something (`trigger_events.outcome` on the server).
 */

/** How one outcome is shown. */
export interface OutcomeView {
  /** The badge's tone. */
  tone: "danger" | "warning" | "secondary";
  /** Why it matters and what to do, when it asks for anything. */
  hint: string | null;
}

/** The outcomes that need a sentence; every other one is shown as is. */
const HINTS: Record<string, OutcomeView> = {
  failed: { tone: "danger", hint: null },
  mention_without_session: {
    tone: "warning",
    hint: "@hypotenuse was mentioned but Linear started no session — the app may have lost its mentionable scope. Reconnect Linear to restore it.",
  },
  assigned_not_delegated: {
    tone: "warning",
    hint: "The issue was assigned to @hypotenuse. It works by delegation: set it as the issue's agent instead.",
  },
};

/**
 * The view of one delivery outcome.
 * @param outcome - The outcome.
 * @returns Its tone and hint.
 */
export function outcomeView(outcome: string): OutcomeView {
  return HINTS[outcome] ?? { tone: "secondary", hint: null };
}
