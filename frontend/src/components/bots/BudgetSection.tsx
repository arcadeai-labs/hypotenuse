import { useEffect, useState } from "react";
import { Chip, Form } from "../../ui";
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

/**
 * A monthly spending ceiling in US dollars. It is stored and shown, and says
 * plainly that nothing enforces it yet: spending is not metered until model
 * calls are priced.
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
  const locked = denied !== undefined;

  useEffect(() => {
    setBudget(budgetText(bot.monthlyBudgetUsd));
  }, [bot]);

  const parsed = optionalNumber(budget);
  const changed = parsed !== undefined && parsed !== bot.monthlyBudgetUsd;

  /** Save the budget, or clear it. */
  async function onSave() {
    if (parsed === undefined || (parsed !== null && parsed < 0)) {
      setError("A budget is a number of dollars, or empty for none.");
      return;
    }
    await save(
      async () => {
        onSaved(await editBot(projectId, bot.id, { monthlyBudgetUsd: parsed }));
      },
      parsed === null ? "Budget cleared." : "Saved.",
    );
  }

  return (
    <SectionCard
      title="Budget"
      testId="bot-budget"
      idPrefix="bot"
      intro={
        <>
          <Chip data-testid="bot-budget-not-enforced">Not enforced yet</Chip> A
          monthly ceiling in US dollars. It is recorded now; nothing stops a bot
          at it until model calls are priced.
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
    </SectionCard>
  );
}
