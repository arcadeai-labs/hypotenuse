import type { ProjectSettingsView } from "@backend/actions/project/project-settings-view";
import type { ActionResponse } from "keryx";
import { useCallback, useEffect, useState } from "react";
import { Form } from "../../../ui";
import { apiFetch } from "../../../utils/client";
import { RoutingRulesCard } from "../../routing/RuleTable";
import SectionCard from "../../sections/SectionCard";
import { useSectionSave } from "../../sections/useSectionSave";
import { useProjectSettings } from "../context";
import {
  settingsFromTimers,
  type TimerDraft,
  timersFromSettings,
} from "../routing";

/**
 * Settings → Routing: the rules that decide whether a new Linear session is
 * answered by a manager or a worker (the same card the Routing page shows),
 * and the timers routing waits by.
 * @returns The rendered section.
 */
export default function RoutingSection() {
  const { projectId, may, markDirty } = useProjectSettings();
  const onEditingChange = useCallback(
    (editing: boolean) => markDirty("routing", editing),
    [markDirty],
  );
  return (
    <>
      <RoutingRulesCard
        projectId={projectId}
        may={may}
        onEditingChange={onEditingChange}
      />
      <RoutingTimersCard />
    </>
  );
}

/**
 * The routing timers: how long work waits for a runner, for the runner
 * holding its worktree, for an offer to be claimed, and for a stopped run to
 * confirm — and how sure Linear must be of a repository.
 * @returns The card.
 */
function RoutingTimersCard() {
  const { projectId, may } = useProjectSettings();
  const timers = useSectionSave();
  const mayEdit = may("project:settings-edit");
  const [saved, setSaved] = useState<TimerDraft | null>(null);
  const [draft, setDraft] = useState<TimerDraft | null>(null);

  const load = useCallback(async () => {
    try {
      const { settings } = await apiFetch<ActionResponse<ProjectSettingsView>>(
        `/project/settings?projectId=${projectId}`,
      );
      const seeded = timersFromSettings(settings.routing);
      setSaved(seeded);
      setDraft(seeded);
    } catch (err) {
      timers.setError(
        err instanceof Error ? err.message : "Could not load the timers.",
      );
    }
  }, [projectId, timers.setError]);

  useEffect(() => {
    load();
  }, [load]);

  /** Save the timers. */
  async function onSave() {
    if (!draft) return;
    const parsed = settingsFromTimers(draft);
    if ("error" in parsed) return timers.setError(parsed.error);
    const ok = await timers.save(
      () =>
        apiFetch("/project/settings", {
          method: "POST",
          body: JSON.stringify({ projectId, routing: parsed.routing }),
        }),
      "Saved the routing timers.",
    );
    if (ok) await load();
  }

  /**
   * One timer field.
   * @param key - Which draft field.
   * @param label - Its label.
   * @param help - What it means.
   * @returns The field.
   */
  const field = (key: keyof TimerDraft, label: string, help: string) => (
    <Form.Group className="mb-2" controlId={`routing-${key}`}>
      <Form.Label className="text-meta">{label}</Form.Label>
      {mayEdit ? (
        <Form.Control
          inputMode="decimal"
          value={draft?.[key] ?? ""}
          disabled={timers.busy || !draft}
          onChange={(e) =>
            setDraft((d) => (d ? { ...d, [key]: e.target.value } : d))
          }
          data-testid={`routing-${key}`}
        />
      ) : (
        <div data-testid={`routing-${key}`}>{draft?.[key] ?? "…"}</div>
      )}
      <Form.Text className="text-muted">{help}</Form.Text>
    </Form.Group>
  );

  const changed =
    draft !== null &&
    saved !== null &&
    JSON.stringify(draft) !== JSON.stringify(saved);

  return (
    <SectionCard
      title="Routing timers"
      testId="routing-timers"
      idPrefix="settings"
      cardTestId="routing-timers-card"
      error={timers.error}
      notice={timers.notice}
      onDismissError={() => timers.setError(null)}
      onDismissNotice={() => timers.setNotice(null)}
      onSave={mayEdit ? onSave : undefined}
      saveLabel="Save timers"
      canSave={changed}
      busy={timers.busy}
    >
      {field(
        "queueTimeoutMinutes",
        "Queue timeout (minutes)",
        "Work no runner takes within this long ends with an error saying why.",
      )}
      {field(
        "stickyTimeoutMinutes",
        "Sticky timeout (minutes)",
        "How long a follow-up waits for the runner holding its worktree before any runner may take it, fresh. 0 never waits.",
      )}
      {field(
        "offerTtlSeconds",
        "Offer (seconds)",
        "How long a runner has to claim work offered to it before the offer goes to the next.",
      )}
      {field(
        "stopGraceSeconds",
        "Stop grace (seconds)",
        "How long a stopped run's runner has to confirm before Hypotenuse says it stopped.",
      )}
      {field(
        "repositoryConfidence",
        "Repository confidence (0–1)",
        "How sure Linear's top repository suggestion must be before it is taken without asking.",
      )}
    </SectionCard>
  );
}
