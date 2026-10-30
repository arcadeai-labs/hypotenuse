import { FileText } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Form } from "../../ui";
import {
  MAX_AGENT_SECTIONS_LIMIT,
  PROMPT_BUDGET_RANGE,
  parseWhole,
} from "../../utils/prompts";
import { SectionCard } from "../sections/SectionCard";
import { useSectionSave } from "../sections/useSectionSave";
import { type BotSectionProps, editBot } from "./IdentitySection";

/**
 * The size of the bot's prompt: its budget in tokens — contextual sections
 * are dropped to fit it, and a change that would push the sections that
 * always load over it is refused — and how many sections the bot may add to
 * its own prompt. The sections themselves are on the Prompt page this
 * links to. Both fields save together.
 * @param props - See {@link BotSectionProps}.
 * @returns The section.
 */
export function PromptSettingsSection({
  projectId,
  bot,
  denied,
  onSaved,
}: BotSectionProps) {
  const { busy, error, notice, setError, setNotice, save } = useSectionSave();
  const [budget, setBudget] = useState(String(bot.promptBudgetTokens));
  const [sections, setSections] = useState(String(bot.maxAgentSections));
  const locked = denied !== undefined;

  useEffect(() => {
    setBudget(String(bot.promptBudgetTokens));
    setSections(String(bot.maxAgentSections));
  }, [bot]);

  const budgetChanged = budget.trim() !== String(bot.promptBudgetTokens);
  const sectionsChanged = sections.trim() !== String(bot.maxAgentSections);

  /** Save the budget and the section cap. */
  async function onSave() {
    const parsedBudget = parseWhole(
      budget,
      PROMPT_BUDGET_RANGE.min,
      PROMPT_BUDGET_RANGE.max,
    );
    const parsedSections = parseWhole(sections, 0, MAX_AGENT_SECTIONS_LIMIT);
    if (parsedBudget === null) {
      setError(
        `A prompt budget is a whole number of tokens from ${PROMPT_BUDGET_RANGE.min.toLocaleString()} to ${PROMPT_BUDGET_RANGE.max.toLocaleString()}.`,
      );
      return;
    }
    if (parsedSections === null) {
      setError(
        `Sections it may add is a whole number from 0 to ${MAX_AGENT_SECTIONS_LIMIT}.`,
      );
      return;
    }
    const fields: Record<string, unknown> = {};
    if (budgetChanged) fields.promptBudgetTokens = parsedBudget;
    if (sectionsChanged) fields.maxAgentSections = parsedSections;
    await save(async () => {
      onSaved(await editBot(projectId, bot.id, fields));
    }, "Saved.");
  }

  return (
    <SectionCard
      title="Prompt"
      testId="bot-prompt"
      idPrefix="bot"
      intro={
        <>
          What {bot.name} is told before every step is built from sections: its
          Identity, the project's sections, and its own.{" "}
          <Link to={`/bots/${bot.id}/prompt`} data-testid="bot-prompt-link">
            <FileText size={12} aria-hidden="true" /> Open its prompt
          </Link>{" "}
          to edit them, see their versions, and preview the whole.
        </>
      }
      error={error}
      notice={notice}
      onDismissError={() => setError(null)}
      onDismissNotice={() => setNotice(null)}
      onSave={onSave}
      canSave={budgetChanged || sectionsChanged}
      saveDeniedReason={denied}
      busy={busy}
    >
      <div className="bot-budget-fields">
        <Form.Group controlId="bot-prompt-budget" className="mb-0">
          <Form.Label>Prompt budget (tokens)</Form.Label>
          <Form.Control
            size="sm"
            type="number"
            min={PROMPT_BUDGET_RANGE.min}
            max={PROMPT_BUDGET_RANGE.max}
            step={500}
            className="settings-input tabular"
            value={budget}
            disabled={busy || locked}
            title={denied}
            onChange={(e) => {
              setBudget(e.target.value);
              setNotice(null);
            }}
            data-testid="bot-prompt-budget"
          />
          <Form.Text className="text-meta">
            Contextual sections are dropped to fit it.
          </Form.Text>
        </Form.Group>
        <Form.Group controlId="bot-max-agent-sections" className="mb-0">
          <Form.Label>Sections it may add</Form.Label>
          <Form.Control
            size="sm"
            type="number"
            min={0}
            max={MAX_AGENT_SECTIONS_LIMIT}
            step={1}
            className="settings-input tabular"
            value={sections}
            disabled={busy || locked}
            title={denied}
            onChange={(e) => {
              setSections(e.target.value);
              setNotice(null);
            }}
            data-testid="bot-max-agent-sections"
          />
          <Form.Text className="text-meta">
            With <span className="mono">prompt_create</span>; 0 stops it.
          </Form.Text>
        </Form.Group>
      </div>
    </SectionCard>
  );
}
