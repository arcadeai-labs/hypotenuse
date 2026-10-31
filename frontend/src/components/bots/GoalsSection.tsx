import { useCallback, useEffect, useState } from "react";
import { Alert, Button, Chip, Form } from "../../ui";
import { apiFetch } from "../../utils/client";
import {
  GOAL_PRIORITIES,
  GOAL_PRIORITY_LABELS,
  GOAL_STATUS_LABELS,
  GOAL_STATUSES,
  lastReviewedLabel,
  REVIEW_INTERVALS,
  reviewIntervalLabel,
  reviewIntervalOptions,
} from "../../utils/prompts";
import { ConfirmDialog } from "../ConfirmDialog";
import { GatedButton } from "../GatedButton";
import type { Goal, GoalsResponse } from "../prompts/data";
import { SectionCard } from "../sections/SectionCard";
import { useSectionSave } from "../sections/useSectionSave";
import type { Bot } from "./data";

/** See {@link GoalsSection}. */
export interface GoalsSectionProps {
  projectId: number;
  bot: Bot;
  /** Why the person may not change its goals, or `undefined`. */
  denied: string | undefined;
}

/** A goal's fields, as typed. */
interface GoalDraft {
  title: string;
  description: string;
  priority: string;
  status: string;
  notes: string;
  /** The interval in seconds, as the select's value; `""` is never. */
  review: string;
}

/** An empty goal. */
const NEW_GOAL: GoalDraft = {
  title: "",
  description: "",
  priority: "medium",
  status: "active",
  notes: "",
  review: "",
};

/**
 * A goal as its draft.
 * @param goal - The goal.
 * @returns The draft.
 */
function draftOf(goal: Goal): GoalDraft {
  return {
    title: goal.title,
    description: goal.description,
    priority: goal.priority,
    status: goal.status,
    notes: goal.notes,
    review:
      goal.reviewEverySeconds === null ? "" : String(goal.reviewEverySeconds),
  };
}

/**
 * A draft's review interval as the API takes it.
 * @param review - The select's value.
 * @returns Seconds, or `null` for never.
 */
function reviewSeconds(review: string): number | null {
  return review === "" ? null : Number(review);
}

/** Active goals first, then achieved, then dropped; within each, the server's order. */
const STATUS_ORDER: Record<string, number> = {
  active: 0,
  achieved: 1,
  dropped: 2,
};

/**
 * What the bot works toward. Active goals are in its prompt, highest
 * priority first, with their notes, and the bot reads and updates them
 * itself with `goal_list` and `goal_update`; achieved and dropped goals are
 * kept here. A goal with a review interval is flagged **Review due** once
 * that long has passed since its last review, and the bot is asked to review
 * it at the start of its next turn.
 * @param props - See {@link GoalsSectionProps}.
 * @returns The section.
 */
export function GoalsSection({ projectId, bot, denied }: GoalsSectionProps) {
  const { busy, error, notice, setError, setNotice, save } = useSectionSave();
  const [goals, setGoals] = useState<Goal[] | null>(null);
  const [draft, setDraft] = useState<GoalDraft>(NEW_GOAL);
  const locked = busy || denied !== undefined;

  const reload = useCallback(async () => {
    try {
      const res = await apiFetch<GoalsResponse>(
        `/project/${projectId}/bot/${bot.id}/goals?limit=100`,
      );
      setGoals(res.goals);
    } catch (err) {
      setGoals((current) => current ?? []);
      setError(err instanceof Error ? err.message : "Could not load goals.");
    }
  }, [projectId, bot.id, setError]);

  useEffect(() => {
    reload();
  }, [reload]);

  /** Add the drafted goal. */
  async function onAdd() {
    const ok = await save(
      () =>
        apiFetch(`/project/${projectId}/bot/${bot.id}/goal`, {
          method: "PUT",
          body: JSON.stringify({
            title: draft.title.trim(),
            description: draft.description.trim(),
            priority: draft.priority,
            reviewEverySeconds: reviewSeconds(draft.review),
          }),
        }),
      `Added "${draft.title.trim()}". ${bot.name} sees it from its next step.`,
    );
    if (ok) {
      setDraft(NEW_GOAL);
      await reload();
    }
  }

  const sorted = goals
    ? [...goals].sort(
        (a, b) => (STATUS_ORDER[a.status] ?? 3) - (STATUS_ORDER[b.status] ?? 3),
      )
    : null;
  const active = goals?.filter((g) => g.status === "active").length ?? 0;

  return (
    <SectionCard
      title="Goals"
      testId="bot-goals"
      idPrefix="bot"
      intro={
        <>
          What {bot.name} works toward between and across conversations. Active
          goals are in its prompt, highest priority first, with their notes; it
          reads them and records progress itself.
        </>
      }
      error={error}
      notice={notice}
      onDismissError={() => setError(null)}
      onDismissNotice={() => setNotice(null)}
      loading={goals === null && error === null}
      loadingBlocks={2}
    >
      {goals?.length === 0 && (
        <p className="text-muted" data-testid="bot-goals-empty">
          {bot.name} has no goals yet.
        </p>
      )}
      {goals && goals.length > 0 && (
        <p className="text-meta" data-testid="bot-goals-count">
          {active === 1 ? "1 active goal" : `${active} active goals`} of{" "}
          {goals.length}
        </p>
      )}
      <ul className="goal-list" data-testid="bot-goal-list">
        {sorted?.map((goal) => (
          <GoalRow
            key={goal.id}
            projectId={projectId}
            goal={goal}
            denied={denied}
            reload={reload}
          />
        ))}
      </ul>

      <Form
        className="goal-new"
        onSubmit={(e) => {
          e.preventDefault();
          onAdd();
        }}
      >
        <h3 className="goal-new-title">Add a goal</h3>
        <Form.Group controlId="goal-new-title" className="mb-0">
          <Form.Label>Goal</Form.Label>
          <Form.Control
            size="sm"
            value={draft.title}
            maxLength={200}
            placeholder="Every billing question answered within a day"
            disabled={locked}
            title={denied}
            onChange={(e) => {
              setDraft((d) => ({ ...d, title: e.target.value }));
              setNotice(null);
            }}
            data-testid="goal-new-title"
          />
        </Form.Group>
        <Form.Group controlId="goal-new-description" className="mb-0">
          <Form.Label>
            What done looks like <span className="text-meta">optional</span>
          </Form.Label>
          <Form.Control
            as="textarea"
            rows={2}
            size="sm"
            value={draft.description}
            maxLength={2_000}
            disabled={locked}
            title={denied}
            onChange={(e) =>
              setDraft((d) => ({ ...d, description: e.target.value }))
            }
            data-testid="goal-new-description"
          />
        </Form.Group>
        <div className="goal-fields-row">
          <PrioritySelect
            id="goal-new-priority"
            value={draft.priority}
            disabled={locked}
            title={denied}
            onChange={(priority) => setDraft((d) => ({ ...d, priority }))}
          />
          <ReviewSelect
            id="goal-new-review"
            value={draft.review}
            options={REVIEW_INTERVALS}
            disabled={locked}
            title={denied}
            onChange={(review) => setDraft((d) => ({ ...d, review }))}
          />
        </div>
        <div>
          <GatedButton
            size="sm"
            type="submit"
            variant="outline-primary"
            disabled={busy || draft.title.trim() === ""}
            deniedReason={denied}
            data-testid="goal-new-submit"
          >
            Add goal
          </GatedButton>
        </div>
      </Form>
    </SectionCard>
  );
}

/**
 * The priority picker.
 * @param props - Its id, value, and change handler.
 * @returns The field.
 */
function PrioritySelect({
  id,
  value,
  disabled,
  title,
  onChange,
}: {
  id: string;
  value: string;
  disabled: boolean;
  title?: string;
  onChange: (value: string) => void;
}) {
  return (
    <Form.Group controlId={id} className="mb-0">
      <Form.Label>Priority</Form.Label>
      <Form.Select
        size="sm"
        value={value}
        disabled={disabled}
        title={title}
        onChange={(e) => onChange(e.target.value)}
        data-testid={id}
      >
        {GOAL_PRIORITIES.map((p) => (
          <option key={p} value={p}>
            {GOAL_PRIORITY_LABELS[p]}
          </option>
        ))}
      </Form.Select>
    </Form.Group>
  );
}

/**
 * The review interval picker.
 * @param props - Its id, value (seconds as text; empty for never), options, and change handler.
 * @returns The field.
 */
function ReviewSelect({
  id,
  value,
  options,
  disabled,
  title,
  onChange,
}: {
  id: string;
  value: string;
  options: readonly (number | null)[];
  disabled: boolean;
  title?: string;
  onChange: (value: string) => void;
}) {
  return (
    <Form.Group controlId={id} className="mb-0">
      <Form.Label>Review</Form.Label>
      <Form.Select
        size="sm"
        value={value}
        disabled={disabled}
        title={title}
        onChange={(e) => onChange(e.target.value)}
        data-testid={id}
      >
        {options.map((seconds) => (
          <option key={seconds ?? "never"} value={seconds ?? ""}>
            {reviewIntervalLabel(seconds)}
          </option>
        ))}
      </Form.Select>
    </Form.Group>
  );
}

/**
 * One goal: its title, status, priority, and whether a review is due; its
 * description and notes; and, opened, an editor for all of it, with Delete.
 * @param props - The goal and the section's context.
 * @returns The row.
 */
function GoalRow({
  projectId,
  goal,
  denied,
  reload,
}: {
  projectId: number;
  goal: Goal;
  denied: string | undefined;
  reload: () => Promise<void>;
}) {
  const { busy, error, setError, save } = useSectionSave();
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [draft, setDraft] = useState<GoalDraft>(() => draftOf(goal));
  const path = `/project/${projectId}/goal/${goal.id}`;
  const testId = `goal-${goal.id}`;

  useEffect(() => {
    if (!editing) setDraft(draftOf(goal));
  }, [goal, editing]);

  const saved = draftOf(goal);
  const changed = (Object.keys(saved) as (keyof GoalDraft)[]).some(
    (key) => draft[key] !== saved[key],
  );

  /** Save the changed fields. */
  async function onSave() {
    const fields: Record<string, unknown> = {};
    if (draft.title.trim() !== goal.title) fields.title = draft.title.trim();
    if (draft.description.trim() !== goal.description)
      fields.description = draft.description.trim();
    if (draft.priority !== goal.priority) fields.priority = draft.priority;
    if (draft.status !== goal.status) fields.status = draft.status;
    if (draft.notes !== goal.notes) fields.notes = draft.notes;
    if (draft.review !== saved.review)
      fields.reviewEverySeconds = reviewSeconds(draft.review);
    const ok = await save(
      () => apiFetch(path, { method: "POST", body: JSON.stringify(fields) }),
      "Saved.",
    );
    if (ok) {
      setEditing(false);
      await reload();
    }
  }

  /** Delete the goal. */
  async function onDelete() {
    setDeleting(false);
    const ok = await save(
      () => apiFetch(path, { method: "DELETE" }),
      "Deleted.",
    );
    if (ok) await reload();
  }

  return (
    <li
      className="goal"
      data-status={goal.status}
      data-review-due={goal.reviewDue}
      data-testid={testId}
    >
      <div className="goal-head">
        <span className="goal-title" data-testid={`${testId}-title`}>
          {goal.title}
        </span>
        <Chip data-testid={`${testId}-status`}>
          {GOAL_STATUS_LABELS[goal.status] ?? goal.status}
        </Chip>
        <Chip
          className={goal.priority === "high" ? "goal-chip-high" : undefined}
          data-testid={`${testId}-priority`}
        >
          {GOAL_PRIORITY_LABELS[goal.priority] ?? goal.priority} priority
        </Chip>
        {goal.reviewDue && (
          <Chip
            className="goal-chip-due"
            title="It will be reviewed at the start of the bot's next turn."
            data-testid={`${testId}-review-due`}
          >
            Review due
          </Chip>
        )}
        <span className="goal-actions">
          <GatedButton
            size="sm"
            variant="outline-secondary"
            disabled={busy || editing}
            deniedReason={denied}
            onClick={() => {
              setDraft(draftOf(goal));
              setEditing(true);
            }}
            data-testid={`${testId}-edit`}
          >
            Edit
          </GatedButton>
          <GatedButton
            size="sm"
            variant="outline-danger"
            disabled={busy}
            deniedReason={denied}
            aria-label={`Delete the goal ${goal.title}`}
            onClick={() => setDeleting(true)}
            data-testid={`${testId}-delete`}
          >
            Delete
          </GatedButton>
        </span>
      </div>
      <p className="text-meta goal-review">
        {goal.reviewEverySeconds === null
          ? "No review schedule"
          : `Reviewed ${reviewIntervalLabel(goal.reviewEverySeconds).toLowerCase()}`}
        {(goal.reviewEverySeconds !== null || goal.lastReviewedAt !== null) &&
          ` · ${lastReviewedLabel(goal)}`}
      </p>
      {error && (
        <Alert
          variant="danger"
          dismissible
          onClose={() => setError(null)}
          data-testid={`${testId}-error`}
        >
          {error}
        </Alert>
      )}
      {editing ? (
        <div className="goal-editor">
          <Form.Group controlId={`${testId}-title-input`} className="mb-0">
            <Form.Label>Goal</Form.Label>
            <Form.Control
              size="sm"
              value={draft.title}
              maxLength={200}
              disabled={busy}
              onChange={(e) =>
                setDraft((d) => ({ ...d, title: e.target.value }))
              }
              data-testid={`${testId}-title-input`}
            />
          </Form.Group>
          <Form.Group
            controlId={`${testId}-description-input`}
            className="mb-0"
          >
            <Form.Label>What done looks like</Form.Label>
            <Form.Control
              as="textarea"
              rows={2}
              size="sm"
              value={draft.description}
              maxLength={2_000}
              disabled={busy}
              onChange={(e) =>
                setDraft((d) => ({ ...d, description: e.target.value }))
              }
              data-testid={`${testId}-description-input`}
            />
          </Form.Group>
          <div className="goal-fields-row">
            <Form.Group controlId={`${testId}-status-input`} className="mb-0">
              <Form.Label>Status</Form.Label>
              <Form.Select
                size="sm"
                value={draft.status}
                disabled={busy}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, status: e.target.value }))
                }
                data-testid={`${testId}-status-input`}
              >
                {GOAL_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {GOAL_STATUS_LABELS[s]}
                  </option>
                ))}
              </Form.Select>
            </Form.Group>
            <PrioritySelect
              id={`${testId}-priority-input`}
              value={draft.priority}
              disabled={busy}
              onChange={(priority) => setDraft((d) => ({ ...d, priority }))}
            />
            <ReviewSelect
              id={`${testId}-review-input`}
              value={draft.review}
              options={reviewIntervalOptions(goal.reviewEverySeconds)}
              disabled={busy}
              onChange={(review) => setDraft((d) => ({ ...d, review }))}
            />
          </div>
          <Form.Group controlId={`${testId}-notes-input`} className="mb-0">
            <Form.Label>Notes</Form.Label>
            <Form.Control
              as="textarea"
              rows={3}
              size="sm"
              value={draft.notes}
              maxLength={4_000}
              disabled={busy}
              onChange={(e) =>
                setDraft((d) => ({ ...d, notes: e.target.value }))
              }
              data-testid={`${testId}-notes-input`}
            />
            <Form.Text className="text-meta">
              Progress so far. The bot writes here too.
            </Form.Text>
          </Form.Group>
          <div className="d-flex gap-2">
            <GatedButton
              size="sm"
              variant="primary"
              disabled={busy || !changed || draft.title.trim() === ""}
              deniedReason={denied}
              onClick={onSave}
              data-testid={`${testId}-save`}
            >
              Save
            </GatedButton>
            <Button
              size="sm"
              variant="link"
              disabled={busy}
              onClick={() => setEditing(false)}
              data-testid={`${testId}-cancel`}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <>
          {goal.description && (
            <p className="goal-description">{goal.description}</p>
          )}
          {goal.notes && (
            <div className="goal-notes" data-testid={`${testId}-notes`}>
              <span className="text-meta">Notes</span>
              <p className="goal-notes-text">{goal.notes}</p>
            </div>
          )}
        </>
      )}
      <ConfirmDialog
        show={deleting}
        title={`Delete "${goal.title}"?`}
        confirmLabel="Delete goal"
        busy={busy}
        onConfirm={onDelete}
        onCancel={() => setDeleting(false)}
        testId={`${testId}-delete`}
      >
        It leaves the bot's prompt and this list. To keep it on record, mark it
        achieved or dropped instead.
      </ConfirmDialog>
    </li>
  );
}
