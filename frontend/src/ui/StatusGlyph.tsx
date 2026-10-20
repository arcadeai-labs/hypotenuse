import type { ComponentType } from "react";
import {
  ActiveGlyph,
  AwaitingInputGlyph,
  CompleteGlyph,
  ErrorGlyph,
  type GlyphProps,
  PendingGlyph,
  StaleGlyph,
  StoppingGlyph,
} from "./glyphs";

/**
 * A session's status, as Linear derives it from the last activity. The
 * dashboard mirrors it and never sets it, so these are Linear's own names.
 */
export type AgentSessionStatus =
  | "pending"
  | "active"
  | "awaitingInput"
  | "complete"
  | "error"
  | "stale"
  | "stopping";

/** Every status, in the order a grouped list shows them. */
export const AGENT_SESSION_STATUSES: readonly AgentSessionStatus[] = [
  "awaitingInput",
  "active",
  "stopping",
  "pending",
  "error",
  "stale",
  "complete",
];

/** The glyph for each status. A shape per state, so colour is never the only cue. */
export const STATUS_GLYPHS: Record<
  AgentSessionStatus,
  ComponentType<GlyphProps>
> = {
  pending: PendingGlyph,
  active: ActiveGlyph,
  awaitingInput: AwaitingInputGlyph,
  complete: CompleteGlyph,
  error: ErrorGlyph,
  stale: StaleGlyph,
  stopping: StoppingGlyph,
};

/** What each status is called in a label or a screen reader. */
export const STATUS_LABELS: Record<AgentSessionStatus, string> = {
  pending: "Pending",
  active: "Active",
  awaitingInput: "Waiting for input",
  complete: "Complete",
  error: "Error",
  stale: "Stale",
  stopping: "Stopping",
};

/**
 * The glyph for a session status, labelled for assistive technology.
 * @param props - `status`, plus any glyph prop (`size`, `label`, `className`).
 * @returns The status glyph.
 */
export function StatusGlyph({
  status,
  ...props
}: GlyphProps & { status: AgentSessionStatus }) {
  const Shape = STATUS_GLYPHS[status];
  return <Shape label={STATUS_LABELS[status]} {...props} />;
}
