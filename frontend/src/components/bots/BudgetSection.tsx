import { useEffect, useState } from "react";
import { Form } from "../../ui";
import { optionalNumber } from "../../utils/models";
import { SectionCard } from "../sections/SectionCard";
import { useSectionSave } from "../sections/useSectionSave";
import { type BotSectionProps, editBot } from "./IdentitySection";

/**
 * A budget as the field shows it.
 * @param budget - `monthlyBudgetUsd`, or `null` for none.
 * @returns The field's text.
 */
function budgetText(budget: number | null): string {
  return budget === null ? "" : String(budget);
}

/** The steps a turn may take when the bot does not say. */
export const DEFAULT_MAX_STEPS_PER_TURN = 50;

/** The most steps per turn `bot:edit` accepts. */
export const MAX_STEPS_PER_TURN = 500;

/**
 * Whether a steps-per-turn field holds a value `bot:edit` takes.
 * @param text - The field's text.
 * @returns The whole number from 1 to {@link MAX_STEPS_PER_TURN}, or `null`.
 */
export function parseStepsPerTurn(text: string): number | null {
  if (!/^\d+$/.test(text.trim())) return null;
  const n = Number(text.trim());
  return n >= 1 && n <= MAX_STEPS_PER_TURN ? n : null;
}

/**
 * What a bot may spend: a monthly ceiling in US dollars, enforced against the
 * cost its provider reports, and how many model steps one turn may take.
 * Both save together.
 * @param props - See {@link BotSectionProps}.
 * @returns The section.
 */
export function BudgetSection({
  projectId,
  bot,
  denied,
  onSaved,
}: BotSectionProps) {
  const { busy, error, notice, setError, setNotice, save } = useSectionSave();
  const [budget, setBudget] = useState(budgetText(bot.monthlyBudgetUsd));
  const [steps, setSteps] = useState(String(bot.maxStepsPerTurn));
  const locked = denied !== undefined;

  useEffect(() => {
    setBudget(budgetText(bot.monthlyBudgetUsd));
    setSteps(String(bot.maxStepsPerTurn));
  }, [bot]);

  const parsed = optionalNumber(budget);
  const parsedSteps = parseStepsPerTurn(steps);
  const budgetChanged = parsed === undefined || parsed !== bot.monthlyBudgetUsd;
  const stepsChanged = steps.trim() !== String(bot.maxStepsPerTurn);
  const changed = budgetChanged || stepsChanged;

  /** Save the budget (or clear it) and the steps per turn. */
  async function onSave() {
    if (parsed === undefined || (parsed !== null && parsed < 0)) {
      setError("A budget is a number of dollars, or empty for none.");
      return;
    }
    if (parsedSteps === null) {
      setError(
        `Steps per turn is a whole number from 1 to ${MAX_STEPS_PER_TURN}.`,
      );
      return;
    }
    const fields: Record<string, unknown> = {};
    if (budgetChanged) fields.monthlyBudgetUsd = parsed;
    if (stepsChanged) fields.maxStepsPerTurn = parsedSteps;
    await save(
      async () => {
        onSaved(await editBot(projectId, bot.id, fields));
      },
      budgetChanged && parsed === null ? "Budget cleared." : "Saved.",
    );
  }

  return (
    <SectionCard
      title="Budget"
      testId="bot-budget"
      idPrefix="bot"
      intro={
        <>
          A monthly ceiling in US dollars: once the cost its model provider
          reports reaches it, the bot takes no more steps that month. Steps per
          turn caps how many model steps one turn may take; a turn that reaches
          it fails, saying so.
        </>
      }
      error={error}
      notice={notice}
      onDismissError={() => setError(null)}
      onDismissNotice={() => setNotice(null)}
      onSave={onSave}
      canSave={changed}
      saveDeniedReason={denied}
      busy={busy}
    >
      <div className="bot-budget-fields">
        <Form.Group controlId="bot-budget" className="mb-0">
          <Form.Label>Monthly budget (USD)</Form.Label>
          <Form.Control
            size="sm"
            type="number"
            min={0}
            step={1}
            className="settings-input tabular"
            placeholder="No budget"
            value={budget}
            disabled={busy || locked}
            title={denied}
            onChange={(e) => {
              setBudget(e.target.value);
              setNotice(null);
            }}
            data-testid="bot-budget"
          />
        </Form.Group>
        <Form.Group controlId="bot-max-steps" className="mb-0">
          <Form.Label>Steps per turn</Form.Label>
          <Form.Control
            size="sm"
            type="number"
            min={1}
            max={MAX_STEPS_PER_TURN}
            step={1}
            className="settings-input tabular"
            placeholder={String(DEFAULT_MAX_STEPS_PER_TURN)}
            value={steps}
            disabled={busy || locked}
            title={denied}
            onChange={(e) => {
              setSteps(e.target.value);
              setNotice(null);
            }}
            data-testid="bot-max-steps"
          />
        </Form.Group>
      </div>
    </SectionCard>
  );
}
