import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Form } from "../../ui";
import {
  MIN_JOB_TOKEN_BUDGET,
  parseJobTokenBudget,
} from "../../utils/sandboxJobs";
import { SectionCard } from "../sections/SectionCard";
import { useSectionSave } from "../sections/useSectionSave";
import { type BotSectionProps, editBot } from "./IdentitySection";

/** The sandbox policies `bot:edit` takes, in the order the menu offers them. */
export const SANDBOX_POLICIES = [
  {
    value: "approve",
    label: "Ask first — each job waits for a person's approval",
  },
  { value: "allow", label: "Allow — jobs start at once" },
  { value: "off", label: "Off — the bot cannot start jobs" },
] as const;

/** One of {@link SANDBOX_POLICIES}. */
export type SandboxPolicy = (typeof SANDBOX_POLICIES)[number]["value"];

/**
 * A budget as the field shows it.
 * @param budget - `sandboxJobTokenBudget`, or `null` for none.
 * @returns The field's text.
 */
function budgetText(budget: number | null): string {
  return budget === null ? "" : String(budget);
}

/**
 * Sandboxes: whether the bot may hand code work to a coding agent in an
 * ephemeral sandbox (`sandbox_start`), whether each job waits for a person's
 * approval first, and the most model tokens one job may use before it is
 * stopped. Both save through `bot:edit`.
 * @param props - See {@link BotSectionProps}.
 * @returns The section.
 */
export function SandboxSection({
  projectId,
  bot,
  denied,
  onSaved,
}: BotSectionProps) {
  const { busy, error, notice, setError, setNotice, save } = useSectionSave();
  const [policy, setPolicy] = useState<string>(bot.sandboxPolicy);
  const [budget, setBudget] = useState(budgetText(bot.sandboxJobTokenBudget));
  const locked = denied !== undefined;

  useEffect(() => {
    setPolicy(bot.sandboxPolicy);
    setBudget(budgetText(bot.sandboxJobTokenBudget));
  }, [bot]);

  const parsed = parseJobTokenBudget(budget);
  const changed =
    policy !== bot.sandboxPolicy ||
    parsed === undefined ||
    parsed !== bot.sandboxJobTokenBudget;

  /** Save the policy and the budget. */
  async function onSave() {
    if (parsed === undefined) {
      setError(
        `A job's token budget is a whole number of at least ${MIN_JOB_TOKEN_BUDGET.toLocaleString()}, or blank for no cap.`,
      );
      return;
    }
    await save(async () => {
      onSaved(
        await editBot(projectId, bot.id, {
          sandboxPolicy: policy as SandboxPolicy,
          sandboxJobTokenBudget: parsed,
        }),
      );
    }, "Saved.");
  }

  return (
    <SectionCard
      title="Sandboxes"
      testId="bot-sandbox"
      idPrefix="bot"
      intro={
        <>
          With sandboxes, {bot.name} can hand work that needs a real machine — a
          repository, a shell, tests, hours — to a coding agent in an ephemeral
          sandbox (<code>sandbox_start</code>). The agent reaches only the
          project's models and {bot.name}'s own MCP servers, reports back into
          the conversation, and is destroyed when the job ends.{" "}
          <Link to={`/sandboxes?bot=${bot.id}`} data-testid="bot-sandbox-jobs">
            See its jobs
          </Link>
          .
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
      <div className="sandbox-fields">
        <Form.Group controlId="bot-sandbox-policy" className="mb-0">
          <Form.Label>Sandbox jobs</Form.Label>
          <Form.Select
            size="sm"
            className="settings-input"
            value={policy}
            disabled={busy || locked}
            title={denied}
            onChange={(e) => {
              setPolicy(e.target.value);
              setNotice(null);
            }}
            data-testid="bot-sandbox-policy"
          >
            {SANDBOX_POLICIES.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </Form.Select>
        </Form.Group>
        <Form.Group controlId="bot-sandbox-budget" className="mb-0">
          <Form.Label>Tokens per job</Form.Label>
          <Form.Control
            size="sm"
            inputMode="numeric"
            className="settings-input tabular"
            placeholder="No cap"
            value={budget}
            disabled={busy || locked || policy === "off"}
            title={denied}
            isInvalid={parsed === undefined}
            onChange={(e) => {
              setBudget(e.target.value);
              setNotice(null);
            }}
            data-testid="bot-sandbox-budget"
          />
          <Form.Text className="text-muted">
            Input plus output, as the model proxy counts them. Over it, the job
            is stopped.
          </Form.Text>
        </Form.Group>
      </div>
    </SectionCard>
  );
}
