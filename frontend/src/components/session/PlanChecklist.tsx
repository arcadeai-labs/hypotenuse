import type { ComponentType } from "react";
import {
  ActiveGlyph,
  CompleteGlyph,
  type GlyphProps,
  PendingGlyph,
  StaleGlyph,
} from "../../ui";

/** One plan step, in Linear's shape. */
export interface PlanStep {
  content: string;
  status: "pending" | "inProgress" | "completed" | "canceled";
}

/** Each of Linear's four step statuses as a glyph and a word. */
const STEP: Record<
  PlanStep["status"],
  { Shape: ComponentType<GlyphProps>; label: string }
> = {
  pending: { Shape: PendingGlyph, label: "Pending" },
  inProgress: { Shape: ActiveGlyph, label: "In progress" },
  completed: { Shape: CompleteGlyph, label: "Completed" },
  canceled: { Shape: StaleGlyph, label: "Canceled" },
};

/**
 * The session's latest plan as a checklist card, with the same status glyphs
 * the rest of the dashboard uses.
 * @param props - The steps.
 * @returns The card.
 */
export function PlanChecklist({ steps }: { steps: PlanStep[] }) {
  return (
    <section className="transcript-plan" data-testid="plan" aria-label="Plan">
      <h3 className="text-meta">Plan</h3>
      <ol>
        {steps.map((step, i) => {
          const { Shape, label } = STEP[step.status] ?? STEP.pending;
          return (
            <li
              // Plan steps have no id; a step is its position.
              // biome-ignore lint/suspicious/noArrayIndexKey: steps have no id.
              key={i}
              className={`transcript-plan-step transcript-plan-${step.status}`}
              data-testid={`plan-step-${i}`}
            >
              <Shape label={label} />
              <span>{step.content}</span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
