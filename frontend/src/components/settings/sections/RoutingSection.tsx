import type { ProjectSettingsView } from "@backend/actions/project/project-settings-view";
import type { RoutingRuleList } from "@backend/actions/routing-rule/routing-rule-list";
import type { ActionResponse } from "keryx";
import { useCallback, useEffect, useState } from "react";
import { useFirstLoad } from "../../../hooks/useFirstLoad";
import { Badge, Button, Form, Table } from "../../../ui";
import { apiFetch } from "../../../utils/client";
import SkeletonRows from "../../SkeletonRows";
import SectionCard from "../../sections/SectionCard";
import { useSectionSave } from "../../sections/useSectionSave";
import { useProjectSettings } from "../context";
import {
  describeMatch,
  draftFromRule,
  EMPTY_RULE_DRAFT,
  matchFromDraft,
  moveRule,
  type RuleDraft,
  settingsFromTimers,
  type TimerDraft,
  timersFromSettings,
} from "../routing";

/** A rule as `routing-rule:list` serializes it. */
type RoutingRule = ActionResponse<RoutingRuleList>["routingRules"][number];

/**
 * Settings → Routing: the rules that decide whether a new Linear session is
 * answered by a manager or a worker, in the order they are evaluated, and the
 * timers routing waits by. Every member reads them; only those `can()` allow
 * add, edit, reorder, or change the timers.
 * @returns The rendered section.
 */
export default function RoutingSection() {
  const { projectId, may, markDirty } = useProjectSettings();
  const rules = useSectionSave();
  const [list, setList] = useState<RoutingRule[]>([]);
  const [editing, setEditing] = useState<number | "new" | null>(null);
  const [draft, setDraft] = useState<RuleDraft>(EMPTY_RULE_DRAFT);
  const { loading, begin, done } = useFirstLoad();
  const mayCreate = may("routing-rule:create");
  const mayEdit = may("routing-rule:edit");
  const mayDelete = may("routing-rule:delete");
  const mayReorder = may("routing-rule:reorder");

  const load = useCallback(async () => {
    begin();
    try {
      setList(
        (
          await apiFetch<ActionResponse<RoutingRuleList>>(
            `/routing-rules?projectId=${projectId}&limit=100`,
          )
        ).routingRules,
      );
    } catch (err) {
      rules.setError(
        err instanceof Error ? err.message : "Could not load routing rules.",
      );
    } finally {
      done();
    }
  }, [projectId, rules.setError, begin, done]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    markDirty("routing", editing !== null);
    return () => markDirty("routing", false);
  }, [editing, markDirty]);

  /**
   * Open the form, empty for a new rule or seeded from an existing one.
   * @param rule - The rule to edit, or none for a new one.
   */
  function openForm(rule?: RoutingRule) {
    setDraft(rule ? draftFromRule(rule) : EMPTY_RULE_DRAFT);
    setEditing(rule ? rule.id : "new");
  }

  /**
   * Change some of the form's fields.
   * @param patch - The fields to change.
   */
  function update(patch: Partial<RuleDraft>) {
    setDraft((d) => ({ ...d, ...patch }));
  }

  /** Create or save the rule in the form. */
  async function onSubmit() {
    const name = draft.name.trim();
    if (!name) return rules.setError("A rule needs a name.");
    const body = {
      projectId,
      name,
      role: draft.role,
      match: matchFromDraft(draft),
      enabled: draft.enabled,
      ...(draft.repository.trim()
        ? { repository: draft.repository.trim() }
        : editing === "new"
          ? {}
          : { repository: null }),
    };
    const ok = await rules.save(
      () =>
        editing === "new"
          ? apiFetch("/routing-rule", {
              method: "PUT",
              body: JSON.stringify(body),
            })
          : apiFetch(`/routing-rule/${editing}`, {
              method: "POST",
              body: JSON.stringify(body),
            }),
      editing === "new" ? `Added the ${name} rule.` : `Saved the ${name} rule.`,
    );
    if (!ok) return;
    setEditing(null);
    await load();
  }

  /**
   * Delete a rule; the rules after it move up.
   * @param rule - The rule.
   */
  async function onDelete(rule: RoutingRule) {
    const ok = await rules.save(
      () =>
        apiFetch(`/routing-rule/${rule.id}`, {
          method: "DELETE",
          body: JSON.stringify({ projectId }),
        }),
      `Deleted the ${rule.name} rule.`,
    );
    if (ok) await load();
  }

  /**
   * Move a rule one place up or down.
   * @param rule - The rule.
   * @param direction - `-1` up, `1` down.
   */
  async function onMove(rule: RoutingRule, direction: -1 | 1) {
    const ids = moveRule(
      list.map((r) => r.id),
      rule.id,
      direction,
    );
    const ok = await rules.save(
      () =>
        apiFetch("/routing-rules/order", {
          method: "POST",
          body: JSON.stringify({ projectId, ids }),
        }),
      `Moved the ${rule.name} rule ${direction < 0 ? "up" : "down"}.`,
    );
    if (ok) await load();
  }

  return (
    <>
      <SectionCard
        title="Routing rules"
        testId="routing"
        idPrefix="settings"
        cardTestId="routing-rules-card"
        intro={
          <>
            Each new Linear session is checked against these rules from the top.
            The first enabled rule that matches decides whether a{" "}
            <strong>manager</strong> or a <strong>worker</strong> answers it,
            and may pin a repository. With no match, a worker answers. A role
            prefix such as <code>/manage</code> is removed before the agent
            reads the mention.
          </>
        }
        error={rules.error}
        notice={rules.notice}
        onDismissError={() => rules.setError(null)}
        onDismissNotice={() => rules.setNotice(null)}
      >
        <Table size="sm" responsive data-testid="routing-rules-table">
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">Rule</th>
              <th scope="col">Matches</th>
              <th scope="col">Role</th>
              <th scope="col">Repository</th>
              <th scope="col" />
            </tr>
          </thead>
          <tbody>
            {loading && (
              <SkeletonRows
                columns={6}
                rows={2}
                testId="routing-rules-loading"
              />
            )}
            {!loading &&
              list.map((rule, index) => (
                <tr key={rule.id} data-testid={`routing-rule-${rule.id}`}>
                  <td className="text-muted">{index + 1}</td>
                  <td>
                    {rule.name}{" "}
                    {!rule.enabled && (
                      <Badge bg="secondary" data-testid="rule-disabled">
                        Disabled
                      </Badge>
                    )}
                  </td>
                  <td>{describeMatch(rule.match)}</td>
                  <td>{rule.role}</td>
                  <td>
                    {rule.repository ? (
                      <code>{rule.repository}</code>
                    ) : (
                      <span className="text-muted">chosen per session</span>
                    )}
                  </td>
                  <td className="text-nowrap">
                    {mayReorder && (
                      <>
                        <Button
                          size="sm"
                          variant="link"
                          disabled={rules.busy || index === 0}
                          aria-label={`Move ${rule.name} up`}
                          onClick={() => onMove(rule, -1)}
                          data-testid={`rule-up-${rule.id}`}
                        >
                          ↑
                        </Button>
                        <Button
                          size="sm"
                          variant="link"
                          disabled={rules.busy || index === list.length - 1}
                          aria-label={`Move ${rule.name} down`}
                          onClick={() => onMove(rule, 1)}
                          data-testid={`rule-down-${rule.id}`}
                        >
                          ↓
                        </Button>
                      </>
                    )}
                    {mayEdit && (
                      <Button
                        size="sm"
                        variant="link"
                        disabled={rules.busy}
                        onClick={() => openForm(rule)}
                        data-testid={`rule-edit-${rule.id}`}
                      >
                        Edit
                      </Button>
                    )}
                    {mayDelete && (
                      <Button
                        size="sm"
                        variant="link"
                        className="text-danger"
                        disabled={rules.busy}
                        onClick={() => onDelete(rule)}
                        data-testid={`rule-delete-${rule.id}`}
                      >
                        Delete
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            {!loading && list.length === 0 && (
              <tr>
                <td colSpan={6} className="text-muted" data-testid="no-rules">
                  No rules: every session is answered by a worker.
                </td>
              </tr>
            )}
          </tbody>
        </Table>

        {editing === null && mayCreate && (
          <Button
            size="sm"
            variant="outline-primary"
            onClick={() => openForm()}
            data-testid="rule-add"
          >
            Add rule
          </Button>
        )}

        {editing !== null && (
          <RuleForm
            draft={draft}
            busy={rules.busy}
            isNew={editing === "new"}
            onChange={update}
            onSubmit={onSubmit}
            onCancel={() => setEditing(null)}
          />
        )}
      </SectionCard>

      <RoutingTimersCard />
    </>
  );
}

/** What {@link RuleForm} takes. */
interface RuleFormProps {
  draft: RuleDraft;
  busy: boolean;
  isNew: boolean;
  onChange: (patch: Partial<RuleDraft>) => void;
  onSubmit: () => void;
  onCancel: () => void;
}

/**
 * The add/edit form for one rule. Every match field is optional; the ones
 * left empty match anything.
 * @param props - The draft and its handlers.
 * @returns The form.
 */
function RuleForm({
  draft,
  busy,
  isNew,
  onChange,
  onSubmit,
  onCancel,
}: RuleFormProps) {
  return (
    <Form
      className="mt-3"
      data-testid="rule-form"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <Form.Group className="mb-2" controlId="rule-name">
        <Form.Label className="text-meta">Name</Form.Label>
        <Form.Control
          value={draft.name}
          disabled={busy}
          onChange={(e) => onChange({ name: e.target.value })}
          data-testid="rule-name"
        />
      </Form.Group>
      <Form.Group className="mb-2" controlId="rule-role">
        <Form.Label className="text-meta">Role</Form.Label>
        <Form.Select
          value={draft.role}
          disabled={busy}
          onChange={(e) =>
            onChange({ role: e.target.value as RuleDraft["role"] })
          }
          data-testid="rule-role"
        >
          <option value="worker">worker</option>
          <option value="manager">manager</option>
        </Form.Select>
      </Form.Group>
      <Form.Group className="mb-2" controlId="rule-prefix">
        <Form.Label className="text-meta">Prompt prefix</Form.Label>
        <Form.Control
          value={draft.promptPrefix}
          placeholder="/manage"
          disabled={busy}
          onChange={(e) => onChange({ promptPrefix: e.target.value })}
          data-testid="rule-prefix"
        />
        <Form.Text className="text-muted">
          The mention starts with this word. A delegation has no text, so a
          prefix rule never matches one.
        </Form.Text>
      </Form.Group>
      <Form.Group className="mb-2" controlId="rule-labels">
        <Form.Label className="text-meta">Labels (any of)</Form.Label>
        <Form.Control
          value={draft.labels}
          placeholder="PRD, spec"
          disabled={busy}
          onChange={(e) => onChange({ labels: e.target.value })}
          data-testid="rule-labels"
        />
      </Form.Group>
      <Form.Group className="mb-2" controlId="rule-teams">
        <Form.Label className="text-meta">Team keys</Form.Label>
        <Form.Control
          value={draft.teamKeys}
          placeholder="ENG, OPS"
          disabled={busy}
          onChange={(e) => onChange({ teamKeys: e.target.value })}
          data-testid="rule-teams"
        />
      </Form.Group>
      <Form.Group className="mb-2" controlId="rule-projects">
        <Form.Label className="text-meta">Linear project ids</Form.Label>
        <Form.Control
          value={draft.projectIds}
          disabled={busy}
          onChange={(e) => onChange({ projectIds: e.target.value })}
          data-testid="rule-projects"
        />
      </Form.Group>
      <Form.Group className="mb-2" controlId="rule-parent">
        <Form.Label className="text-meta">Sub-issues</Form.Label>
        <Form.Select
          value={draft.hasParent}
          disabled={busy}
          onChange={(e) => onChange({ hasParent: e.target.value })}
          data-testid="rule-parent"
        >
          <option value="">Any issue</option>
          <option value="true">Only sub-issues</option>
          <option value="false">Only top-level issues</option>
        </Form.Select>
      </Form.Group>
      <Form.Group className="mb-2" controlId="rule-origin">
        <Form.Label className="text-meta">Started by</Form.Label>
        <Form.Select
          value={draft.origin}
          disabled={busy}
          onChange={(e) => onChange({ origin: e.target.value })}
          data-testid="rule-origin"
        >
          <option value="">Delegation or mention</option>
          <option value="delegation">Delegation</option>
          <option value="mention">Mention</option>
        </Form.Select>
      </Form.Group>
      <Form.Group className="mb-2" controlId="rule-repository">
        <Form.Label className="text-meta">Pinned repository</Form.Label>
        <Form.Control
          value={draft.repository}
          placeholder="github.com/acme/web"
          disabled={busy}
          onChange={(e) => onChange({ repository: e.target.value })}
          data-testid="rule-repository"
        />
        <Form.Text className="text-muted">
          Leave empty to choose per session from the runners' checkouts and
          Linear's suggestions.
        </Form.Text>
      </Form.Group>
      <Form.Check
        type="switch"
        className="mb-3"
        label="Enabled"
        checked={draft.enabled}
        disabled={busy}
        onChange={(e) => onChange({ enabled: e.target.checked })}
        data-testid="rule-enabled"
      />
      <div className="d-flex gap-2">
        <Button
          size="sm"
          type="submit"
          variant="primary"
          disabled={busy}
          data-testid="rule-submit"
        >
          {isNew ? "Add rule" : "Save rule"}
        </Button>
        <Button
          size="sm"
          variant="outline-secondary"
          disabled={busy}
          onClick={onCancel}
          data-testid="rule-cancel"
        >
          Cancel
        </Button>
      </div>
    </Form>
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
