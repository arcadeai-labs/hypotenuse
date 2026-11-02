import type { ScheduleList } from "@backend/actions/schedule/schedule-list";
import type { SchedulePreview } from "@backend/actions/schedule/schedule-preview";
import type { ScheduleRuns } from "@backend/actions/schedule/schedule-runs";
import type { ActionResponse } from "keryx";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Alert, Button, Chip, Form } from "../../ui";
import { apiFetch } from "../../utils/client";
import {
  CRON_EXAMPLES,
  formatSlot,
  RUN_STATUS_LABELS,
  runTone,
  type ScheduleDraft,
  scheduleBody,
  TARGET_LABELS,
  targetSummary,
  viewerTimeZone,
} from "../../utils/schedules";
import { ConfirmDialog } from "../ConfirmDialog";
import { GatedButton } from "../GatedButton";
import { SectionCard } from "../sections/SectionCard";
import { useSectionSave } from "../sections/useSectionSave";
import { type Bot, useRead } from "./data";

/** One schedule, as `schedule:list` serializes it. */
type Schedule = ActionResponse<ScheduleList>["schedules"][number];

/** One run, as `schedule:runs` serializes it. */
type Run = ActionResponse<ScheduleRuns>["runs"][number];

/** `schedule:preview`'s answer. */
type Preview = ActionResponse<SchedulePreview>["preview"];

/** A channel a schedule may post in, as `channel:list?botId=` carries it. */
interface ChannelOption {
  id: number;
  name: string;
  type: string;
  binding?: { enabled: boolean } | null;
}

/** The channel types a schedule may start conversations in. */
const SCHEDULE_CHANNEL_TYPES = ["slack", "webhook", "web"];

/** See {@link SchedulesSection}. */
export interface SchedulesSectionProps {
  projectId: number;
  bot: Bot;
  /** Why the person may not change its schedules, or `undefined`. */
  denied: string | undefined;
}

/**
 * An empty schedule, in the viewer's zone.
 * @returns The draft.
 */
function newDraft(): ScheduleDraft {
  return {
    name: "",
    kind: "instruction",
    targetType: "none",
    channelId: "",
    conversationId: "",
    cron: "0 9 * * 1",
    timeZone: viewerTimeZone(),
    instruction: "",
    guard: "",
    catchUp: "latest",
  };
}

/**
 * A schedule as its draft.
 * @param s - The schedule.
 * @returns The draft.
 */
function draftOf(s: Schedule): ScheduleDraft {
  return {
    name: s.name,
    kind: s.kind,
    targetType: s.targetType,
    channelId: s.channelId ? String(s.channelId) : "",
    conversationId: s.conversationId ? String(s.conversationId) : "",
    cron: s.cron,
    timeZone: s.timeZone,
    instruction: s.instruction,
    guard: s.guard ?? "",
    catchUp: s.catchUp,
  };
}

/**
 * When a bot works without being asked: cron schedules that wake it with an
 * instruction, in a channel, in one conversation, or nowhere. A schedule the
 * bot proposed waits here, disabled and badged, until a person enables it.
 * @param props - See {@link SchedulesSectionProps}.
 * @returns The section.
 */
export function SchedulesSection({
  projectId,
  bot,
  denied,
}: SchedulesSectionProps) {
  const { busy, error, notice, setError, setNotice, save } = useSectionSave();
  const [list, setList] = useState<Schedule[] | null>(null);
  const [draft, setDraft] = useState<ScheduleDraft>(newDraft);
  const channels = useRead<{ channels: ChannelOption[] }>(
    `/project/${projectId}/channels?botId=${bot.id}&limit=100`,
  );
  const channelOptions = (channels.data?.channels ?? []).filter(
    (c) =>
      SCHEDULE_CHANNEL_TYPES.includes(c.type) &&
      (c.type === "web" || c.binding?.enabled),
  );

  const reload = useCallback(async () => {
    try {
      const res = await apiFetch<ActionResponse<ScheduleList>>(
        `/project/${projectId}/bot/${bot.id}/schedules?limit=100`,
      );
      setList(res.schedules);
    } catch (err) {
      setList((current) => current ?? []);
      setError(
        err instanceof Error ? err.message : "Could not load schedules.",
      );
    }
  }, [projectId, bot.id, setError]);

  useEffect(() => {
    reload();
  }, [reload]);

  /** Add the drafted schedule. */
  async function onAdd() {
    const ok = await save(
      () =>
        apiFetch(`/project/${projectId}/bot/${bot.id}/schedule`, {
          method: "PUT",
          body: JSON.stringify(scheduleBody(draft)),
        }),
      `Added "${draft.name.trim()}".`,
    );
    if (ok) {
      setDraft(newDraft());
      await reload();
    }
  }

  const proposed = list?.filter((s) => s.proposedByBot && !s.enabled) ?? [];

  return (
    <SectionCard
      title="Schedules"
      testId="bot-schedules"
      idPrefix="bot"
      intro={
        <>
          When {bot.name} works without being asked. At each slot it wakes with
          the instruction and its goals, and decides whether anything is worth
          saying — it may end silently. A guard, checked by its fast model
          first, can skip a slot.
        </>
      }
      error={error}
      notice={notice}
      onDismissError={() => setError(null)}
      onDismissNotice={() => setNotice(null)}
      loading={list === null && error === null}
      loadingBlocks={2}
    >
      {list?.length === 0 && (
        <p className="text-muted" data-testid="bot-schedules-empty">
          {bot.name} has no schedules yet.
        </p>
      )}
      {proposed.length > 0 && (
        <Alert variant="info" data-testid="bot-schedules-proposed">
          {bot.name} proposed{" "}
          {proposed.length === 1
            ? "a schedule"
            : `${proposed.length} schedules`}
          . A proposal never runs until a person enables it.
        </Alert>
      )}
      <ul className="schedule-list" data-testid="bot-schedule-list">
        {list?.map((s) => (
          <ScheduleRow
            key={s.id}
            projectId={projectId}
            bot={bot}
            schedule={s}
            channelName={
              channels.data?.channels.find((c) => c.id === s.channelId)?.name
            }
            channelOptions={channelOptions}
            denied={denied}
            reload={reload}
          />
        ))}
      </ul>

      <Form
        className="schedule-new"
        onSubmit={(e) => {
          e.preventDefault();
          onAdd();
        }}
      >
        <h3 className="schedule-new-title">Add a schedule</h3>
        <ScheduleFields
          id="schedule-new"
          projectId={projectId}
          draft={draft}
          channelOptions={channelOptions}
          disabled={busy || denied !== undefined}
          title={denied}
          onChange={(next) => {
            setDraft(next);
            setNotice(null);
          }}
        />
        <div>
          <GatedButton
            size="sm"
            type="submit"
            variant="outline-primary"
            disabled={
              busy || draft.name.trim() === "" || draft.cron.trim() === ""
            }
            deniedReason={denied}
            data-testid="schedule-new-submit"
          >
            Add schedule
          </GatedButton>
        </div>
      </Form>
    </SectionCard>
  );
}

/**
 * The fields of a schedule, with a live preview of the cron: what it means
 * in words and its next five slots in the viewer's own zone.
 * @param props - The draft, its change handler, and where it may post.
 * @returns The fields.
 */
function ScheduleFields({
  id,
  projectId,
  draft,
  channelOptions,
  disabled,
  title,
  onChange,
}: {
  id: string;
  projectId: number;
  draft: ScheduleDraft;
  channelOptions: ChannelOption[];
  disabled: boolean;
  title?: string;
  onChange: (draft: ScheduleDraft) => void;
}) {
  const set = (patch: Partial<ScheduleDraft>) =>
    onChange({ ...draft, ...patch });
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const viewerZone = viewerTimeZone();

  useEffect(() => {
    const cron = draft.cron.trim();
    if (cron.split(/\s+/).length !== 5) {
      setPreview(null);
      setPreviewError(
        "Five fields: minute hour day-of-month month day-of-week.",
      );
      return;
    }
    let live = true;
    const timer = setTimeout(async () => {
      try {
        const q = new URLSearchParams({
          cron,
          timeZone: draft.timeZone.trim() || "UTC",
        });
        const res = await apiFetch<{ preview: Preview }>(
          `/project/${projectId}/schedule-preview?${q}`,
        );
        if (live) {
          setPreview(res.preview);
          setPreviewError(null);
        }
      } catch (err) {
        if (live) {
          setPreview(null);
          setPreviewError(
            err instanceof Error ? err.message : "That does not parse.",
          );
        }
      }
    }, 300);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [projectId, draft.cron, draft.timeZone]);

  return (
    <>
      <div className="schedule-fields-row">
        <Form.Group controlId={`${id}-name`} className="mb-0">
          <Form.Label>Name</Form.Label>
          <Form.Control
            size="sm"
            value={draft.name}
            maxLength={100}
            placeholder="Monday issue summary"
            disabled={disabled}
            title={title}
            onChange={(e) => set({ name: e.target.value })}
            data-testid={`${id}-name`}
          />
        </Form.Group>
        <Form.Group controlId={`${id}-kind`} className="mb-0">
          <Form.Label>Kind</Form.Label>
          <Form.Select
            size="sm"
            value={draft.kind}
            disabled={disabled}
            title={title}
            onChange={(e) => set({ kind: e.target.value })}
            data-testid={`${id}-kind`}
          >
            <option value="instruction">Follow an instruction</option>
            <option value="goal-review">Review its goals</option>
          </Form.Select>
        </Form.Group>
      </div>
      <div className="schedule-fields-row">
        <Form.Group controlId={`${id}-cron`} className="mb-0">
          <Form.Label>When (cron)</Form.Label>
          <Form.Control
            size="sm"
            className="schedule-cron"
            value={draft.cron}
            maxLength={200}
            disabled={disabled}
            title={title}
            onChange={(e) => set({ cron: e.target.value })}
            data-testid={`${id}-cron`}
          />
          <Form.Text className="text-meta">
            {CRON_EXAMPLES.map((ex, i) => (
              <span key={ex.cron}>
                {i > 0 && " · "}
                <button
                  type="button"
                  className="schedule-example"
                  disabled={disabled}
                  onClick={() => set({ cron: ex.cron })}
                >
                  {ex.label}
                </button>
              </span>
            ))}
          </Form.Text>
        </Form.Group>
        <Form.Group controlId={`${id}-zone`} className="mb-0">
          <Form.Label>Time zone</Form.Label>
          <Form.Control
            size="sm"
            value={draft.timeZone}
            maxLength={64}
            placeholder="UTC"
            disabled={disabled}
            title={title}
            onChange={(e) => set({ timeZone: e.target.value })}
            data-testid={`${id}-zone`}
          />
        </Form.Group>
      </div>
      <div className="schedule-preview" data-testid={`${id}-preview`}>
        {preview ? (
          <>
            <span className="schedule-preview-when">
              {preview.description} ({preview.timeZone})
            </span>
            <span className="text-meta">
              Next, in your time ({viewerZone}):{" "}
              {preview.nextSlots.map((ms) => formatSlot(ms)).join(" · ")}
            </span>
          </>
        ) : (
          <span className="text-meta" data-testid={`${id}-preview-error`}>
            {previewError ?? "Checking…"}
          </span>
        )}
      </div>
      <div className="schedule-fields-row">
        <Form.Group controlId={`${id}-target`} className="mb-0">
          <Form.Label>Where</Form.Label>
          <Form.Select
            size="sm"
            value={draft.targetType}
            disabled={disabled}
            title={title}
            onChange={(e) => set({ targetType: e.target.value })}
            data-testid={`${id}-target`}
          >
            {Object.entries(TARGET_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Form.Select>
        </Form.Group>
        {draft.targetType === "channel" && (
          <Form.Group controlId={`${id}-channel`} className="mb-0">
            <Form.Label>Channel</Form.Label>
            <Form.Select
              size="sm"
              value={draft.channelId}
              disabled={disabled}
              title={title}
              onChange={(e) => set({ channelId: e.target.value })}
              data-testid={`${id}-channel`}
            >
              <option value="">Choose a bound channel…</option>
              {channelOptions.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.type === "web" ? c.name : `#${c.name}`} ({c.type})
                </option>
              ))}
            </Form.Select>
          </Form.Group>
        )}
        {draft.targetType === "conversation" && (
          <Form.Group controlId={`${id}-conversation`} className="mb-0">
            <Form.Label>Conversation id</Form.Label>
            <Form.Control
              size="sm"
              inputMode="numeric"
              value={draft.conversationId}
              disabled={disabled}
              title={title}
              onChange={(e) =>
                set({ conversationId: e.target.value.replace(/\D/g, "") })
              }
              data-testid={`${id}-conversation`}
            />
          </Form.Group>
        )}
        <Form.Group controlId={`${id}-catch-up`} className="mb-0">
          <Form.Label>After downtime</Form.Label>
          <Form.Select
            size="sm"
            value={draft.catchUp}
            disabled={disabled}
            title={title}
            onChange={(e) => set({ catchUp: e.target.value })}
            data-testid={`${id}-catch-up`}
          >
            <option value="latest">Run the latest missed slot once</option>
            <option value="none">Skip missed slots</option>
          </Form.Select>
        </Form.Group>
      </div>
      <Form.Group controlId={`${id}-instruction`} className="mb-0">
        <Form.Label>
          Instruction{" "}
          {draft.kind === "goal-review" && (
            <span className="text-meta">optional</span>
          )}
        </Form.Label>
        <Form.Control
          as="textarea"
          rows={2}
          size="sm"
          value={draft.instruction}
          maxLength={4_000}
          placeholder={
            draft.kind === "goal-review"
              ? "Review your goals and update their notes."
              : "Post a summary of the open P0 and P1 issues."
          }
          disabled={disabled}
          title={title}
          onChange={(e) => set({ instruction: e.target.value })}
          data-testid={`${id}-instruction`}
        />
      </Form.Group>
      <Form.Group controlId={`${id}-guard`} className="mb-0">
        <Form.Label>
          Guard <span className="text-meta">optional</span>
        </Form.Label>
        <Form.Control
          size="sm"
          value={draft.guard}
          maxLength={500}
          placeholder="Only if there are new P0 issues"
          disabled={disabled}
          title={title}
          onChange={(e) => set({ guard: e.target.value })}
          data-testid={`${id}-guard`}
        />
        <Form.Text className="text-meta">
          Checked once per slot by the bot's fast model; a no skips the slot and
          posts nothing.
        </Form.Text>
      </Form.Group>
    </>
  );
}

/**
 * One schedule: its name, when it runs, where, and whether it is enabled or
 * proposed; Enable or Disable, Run now, Edit, and Delete; and its run
 * history, opened.
 * @param props - The schedule and the section's context.
 * @returns The row.
 */
function ScheduleRow({
  projectId,
  bot,
  schedule,
  channelName,
  channelOptions,
  denied,
  reload,
}: {
  projectId: number;
  bot: Bot;
  schedule: Schedule;
  channelName: string | undefined;
  channelOptions: ChannelOption[];
  denied: string | undefined;
  reload: () => Promise<void>;
}) {
  const { busy, error, notice, setError, setNotice, save } = useSectionSave();
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [showRuns, setShowRuns] = useState(false);
  const [draft, setDraft] = useState<ScheduleDraft>(() => draftOf(schedule));
  const path = `/project/${projectId}/schedule/${schedule.id}`;
  const testId = `schedule-${schedule.id}`;
  const runs = useRead<{ runs: Run[] }>(
    showRuns ? `${path}/runs?limit=10` : null,
  );

  /**
   * Send a change.
   * @param fields - What changed.
   * @param said - The notice on success.
   */
  async function edit(fields: Record<string, unknown>, said: string) {
    const ok = await save(
      () => apiFetch(path, { method: "POST", body: JSON.stringify(fields) }),
      said,
    );
    if (ok) {
      setEditing(false);
      await reload();
    }
  }

  /** Fire it now. */
  async function onRunNow() {
    const ok = await save(
      () => apiFetch(`${path}/run`, { method: "POST" }),
      `Started. ${bot.name} wakes in a moment.`,
    );
    if (ok) {
      setShowRuns(true);
      await runs.reload();
    }
  }

  /** Delete it. */
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
      className="schedule"
      data-enabled={schedule.enabled}
      data-testid={testId}
    >
      <div className="schedule-head">
        <span className="schedule-name" data-testid={`${testId}-name`}>
          {schedule.name}
        </span>
        <Chip data-testid={`${testId}-state`}>
          {schedule.enabled ? "Enabled" : "Disabled"}
        </Chip>
        {schedule.kind === "goal-review" && <Chip>Goal review</Chip>}
        {schedule.proposedByBot && (
          <Chip
            className="schedule-chip-proposed"
            title={`${bot.name} proposed this schedule; it runs only once a person enables it.`}
            data-testid={`${testId}-proposed`}
          >
            Proposed by {bot.name}
          </Chip>
        )}
        <span className="schedule-actions">
          {schedule.enabled ? (
            <GatedButton
              size="sm"
              variant="outline-secondary"
              disabled={busy}
              deniedReason={denied}
              onClick={() => edit({ enabled: false }, "Disabled.")}
              data-testid={`${testId}-disable`}
            >
              Disable
            </GatedButton>
          ) : (
            <GatedButton
              size="sm"
              variant="outline-primary"
              disabled={busy}
              deniedReason={denied}
              onClick={() => edit({ enabled: true }, "Enabled.")}
              data-testid={`${testId}-enable`}
            >
              Enable
            </GatedButton>
          )}
          <GatedButton
            size="sm"
            variant="outline-secondary"
            disabled={busy}
            deniedReason={denied}
            onClick={onRunNow}
            data-testid={`${testId}-run-now`}
          >
            Run now
          </GatedButton>
          <GatedButton
            size="sm"
            variant="outline-secondary"
            disabled={busy || editing}
            deniedReason={denied}
            onClick={() => {
              setDraft(draftOf(schedule));
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
            aria-label={`Delete the schedule ${schedule.name}`}
            onClick={() => setDeleting(true)}
            data-testid={`${testId}-delete`}
          >
            Delete
          </GatedButton>
        </span>
      </div>
      <p className="text-meta schedule-when" data-testid={`${testId}-when`}>
        {schedule.description} ({schedule.timeZone}) ·{" "}
        {targetSummary(schedule, channelName)}
        {schedule.nextRunAt !== null &&
          ` · next ${formatSlot(schedule.nextRunAt)}`}
      </p>
      {schedule.guard && (
        <p className="schedule-guard" data-testid={`${testId}-guard`}>
          <span className="text-meta">Guard</span> {schedule.guard}
        </p>
      )}
      {schedule.instruction && !editing && (
        <p className="schedule-instruction">{schedule.instruction}</p>
      )}
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
      {notice && (
        <Alert
          variant="success"
          dismissible
          onClose={() => setNotice(null)}
          data-testid={`${testId}-notice`}
        >
          {notice}
        </Alert>
      )}
      {editing && (
        <div className="schedule-editor">
          <ScheduleFields
            id={`${testId}-input`}
            projectId={projectId}
            draft={draft}
            channelOptions={channelOptions}
            disabled={busy}
            onChange={setDraft}
          />
          <div className="d-flex gap-2">
            <GatedButton
              size="sm"
              variant="primary"
              disabled={busy || draft.name.trim() === ""}
              deniedReason={denied}
              onClick={() => edit(scheduleBody(draft), "Saved.")}
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
      )}
      <div>
        <Button
          size="sm"
          variant="link"
          className="px-0"
          onClick={() => setShowRuns((v) => !v)}
          aria-expanded={showRuns}
          data-testid={`${testId}-runs-toggle`}
        >
          {showRuns ? "Hide runs" : "Show runs"}
        </Button>
      </div>
      {showRuns && (
        <ul className="schedule-runs" data-testid={`${testId}-runs`}>
          {runs.data?.runs.length === 0 && (
            <li className="text-muted">No runs yet.</li>
          )}
          {runs.error && <li className="text-muted">{runs.error}</li>}
          {runs.data?.runs.map((run) => (
            <li
              key={run.id}
              className="schedule-run"
              data-tone={runTone(run.status)}
              data-testid={`schedule-run-${run.id}`}
            >
              <span className="schedule-run-dot" aria-hidden="true" />
              <span className="schedule-run-slot">{formatSlot(run.slot)}</span>
              <span className="schedule-run-status">
                {RUN_STATUS_LABELS[run.status] ?? run.status}
                {run.trigger === "manual" && " · run now"}
              </span>
              {run.reason && (
                <span className="text-meta schedule-run-reason">
                  {run.reason}
                </span>
              )}
              {run.conversationId !== null && (
                <Link
                  to={`/conversations/${run.conversationId}`}
                  className="schedule-run-link"
                >
                  Conversation
                </Link>
              )}
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        show={deleting}
        title={`Delete "${schedule.name}"?`}
        confirmLabel="Delete schedule"
        busy={busy}
        onConfirm={onDelete}
        onCancel={() => setDeleting(false)}
        testId={`${testId}-delete`}
      >
        It stops waking {bot.name} and its run history goes with it. A
        conversation it already started keeps going. To pause it instead,
        disable it.
      </ConfirmDialog>
    </li>
  );
}
