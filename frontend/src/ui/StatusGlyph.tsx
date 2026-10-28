import type { ComponentType } from "react";
import {
  CONVERSATION_STATUS,
  type ConversationOutcome,
  type ConversationState,
  type ConversationStatus,
  conversationStatusKey,
  type GlyphKind,
  SANDBOX_JOB_STATUS,
  type SandboxJobState,
  type WaitingOn,
} from "../../../design/states";
import {
  CompleteGlyph,
  FailedGlyph,
  type GlyphProps,
  HibernatingGlyph,
  ProvisioningGlyph,
  StaleGlyph,
  WaitingOnPersonGlyph,
  WaitingOnSystemGlyph,
  WorkingGlyph,
} from "./glyphs";

/** The drawing for each glyph kind. A shape per kind, so colour is never the only cue. */
export const GLYPH_COMPONENTS: Record<GlyphKind, ComponentType<GlyphProps>> = {
  working: WorkingGlyph,
  hibernating: HibernatingGlyph,
  "waiting-person": WaitingOnPersonGlyph,
  "waiting-system": WaitingOnSystemGlyph,
  complete: CompleteGlyph,
  failed: FailedGlyph,
  provisioning: ProvisioningGlyph,
  stale: StaleGlyph,
};

/**
 * The glyph for a conversation's state, labelled for assistive technology.
 * `waiting` names what it waits on and `ended` names how it ended, so the
 * props are the same union the server reports.
 * @param props - The conversation status, plus any glyph prop (`size`, `label`, `className`).
 * @returns The status glyph.
 */
export function StatusGlyph(props: GlyphProps & ConversationStatus) {
  // The status fields name the glyph; everything else is the SVG's.
  const { state, waitingOn, outcome, ...glyphProps } = props as GlyphProps & {
    state: ConversationState;
    waitingOn?: WaitingOn;
    outcome?: ConversationOutcome;
  };
  const { glyph, label } = CONVERSATION_STATUS[conversationStatusKey(props)];
  const Shape = GLYPH_COMPONENTS[glyph];
  return <Shape label={label} {...glyphProps} />;
}

/**
 * The glyph for a sandbox job's state, labelled for assistive technology.
 * @param props - `state`, plus any glyph prop.
 * @returns The status glyph.
 */
export function SandboxJobGlyph({
  state,
  ...props
}: GlyphProps & { state: SandboxJobState }) {
  const { glyph, label } = SANDBOX_JOB_STATUS[state];
  const Shape = GLYPH_COMPONENTS[glyph];
  return <Shape label={label} {...props} />;
}
