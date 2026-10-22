import type { RunnerList } from "@backend/actions/runner/runner-list";
import type { TelemetryExporterList } from "@backend/actions/telemetry/telemetry-exporter-list";
import type { TelemetryExporterTest } from "@backend/actions/telemetry/telemetry-exporter-test";
import type { ActionResponse } from "keryx";
import {
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  useCallback,
  useEffect,
  useState,
} from "react";
import { useFirstLoad } from "../../../hooks/useFirstLoad";
import {
  Badge,
  Button,
  Chip,
  CompleteGlyph,
  ErrorGlyph,
  Form,
  Modal,
  Property,
  Table,
} from "../../../ui";
import { apiFetch } from "../../../utils/client";
import type { ListedRunner } from "../../../utils/runners";
import {
  CONTENT_LEVEL_LABELS,
  CONTENT_LEVELS,
  type ContentLevel,
  draftFromExporter,
  type ExporterDraft,
  emptyDraft,
  NATIVE_SUPPORT_LABELS,
  nativeSupport,
  PROTOCOLS,
  type Protocol,
  payloadFromDraft,
  SIGNALS,
  showLastError,
  type TelemetryExporter,
} from "../../../utils/telemetry";
import { relativeTime } from "../../NotificationBell";
import SkeletonRows from "../../SkeletonRows";
import SectionCard from "../../sections/SectionCard";
import { useSectionSave } from "../../sections/useSectionSave";
import { useProjectSettings } from "../context";

/** What `telemetry-exporter:test` answers. */
type TestResult = ActionResponse<TelemetryExporterTest>;

/** Which exporter the form is editing: `new`, an id, or none. */
type Editing = "new" | number | null;

/**
 * Settings → Telemetry: the OpenTelemetry collectors this project's work is
 * exported to, and which runners' agents add their own telemetry. Every
 * member reads both; adding, editing, testing, and deleting an exporter are
 * gated per control through `may()`.
 * @returns The rendered section.
 */
export default function TelemetrySection() {
  return (
    <>
      <ExportersCard />
      <RunnerTelemetryCard />
    </>
  );
}

/**
 * The exporter list with its form, its Test results, and its delete
 * confirmation.
 * @returns The card.
 */
function ExportersCard() {
  const { projectId, may, markDirty } = useProjectSettings();
  const { busy, error, notice, setError, setNotice, save } = useSectionSave();
  const [exporters, setExporters] = useState<TelemetryExporter[]>([]);
  const [editing, setEditing] = useState<Editing>(null);
  const [draft, setDraft] = useState<ExporterDraft>(emptyDraft);
  const [deleting, setDeleting] = useState<TelemetryExporter | null>(null);
  const [tests, setTests] = useState<Record<number, TestResult>>({});
  const [testing, setTesting] = useState<number | null>(null);
  const { loading, begin, done } = useFirstLoad();
  const mayCreate = may("telemetry-exporter:create");
  const mayEdit = may("telemetry-exporter:edit");
  const mayDelete = may("telemetry-exporter:delete");
  const mayTest = may("telemetry-exporter:test");
  const hasActions = mayEdit || mayDelete || mayTest;

  const load = useCallback(async () => {
    begin();
    try {
      setExporters(
        (
          await apiFetch<ActionResponse<TelemetryExporterList>>(
            `/telemetry-exporters?projectId=${projectId}&limit=100`,
          )
        ).telemetryExporters,
      );
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not load the exporters.",
      );
    } finally {
      done();
    }
  }, [projectId, setError, begin, done]);

  useEffect(() => {
    load();
  }, [load]);

  // An open form is unsaved edits as far as the settings shell is concerned.
  useEffect(() => {
    markDirty("telemetry", editing !== null);
  }, [editing, markDirty]);
  useEffect(() => () => markDirty("telemetry", false), [markDirty]);

  /** Open the form for a new exporter. */
  function onNew() {
    setDraft(emptyDraft());
    setEditing("new");
  }

  /**
   * Open the form on an exporter.
   * @param exporter - The exporter to edit.
   */
  function onEdit(exporter: TelemetryExporter) {
    setDraft(draftFromExporter(exporter));
    setEditing(exporter.id);
  }

  /** Submit the form as a create or an edit. */
  async function onSubmit() {
    if (editing === null) return;
    const isEdit = editing !== "new";
    const parsed = payloadFromDraft(draft, isEdit);
    if ("error" in parsed) return setError(parsed.error);
    const ok = await save(
      () =>
        isEdit
          ? apiFetch(`/telemetry-exporter/${editing}`, {
              method: "POST",
              body: JSON.stringify({ projectId, ...parsed.body }),
            })
          : apiFetch("/telemetry-exporter", {
              method: "PUT",
              body: JSON.stringify({ projectId, ...parsed.body }),
            }),
      isEdit
        ? `Saved the ${draft.name.trim()} exporter.`
        : `Added the ${draft.name.trim()} exporter.`,
    );
    if (!ok) return;
    setEditing(null);
    await load();
  }

  /** Delete the exporter awaiting confirmation. */
  async function onDelete() {
    const target = deleting;
    setDeleting(null);
    if (!target) return;
    const ok = await save(
      () =>
        apiFetch(`/telemetry-exporter/${target.id}`, {
          method: "DELETE",
          body: JSON.stringify({ projectId }),
        }),
      `Deleted the ${target.name} exporter.`,
    );
    if (!ok) return;
    if (editing === target.id) setEditing(null);
    await load();
  }

  /**
   * Send an exporter's collector a probe and keep what it answered.
   * @param exporter - The exporter to test.
   */
  async function onTest(exporter: TelemetryExporter) {
    setTesting(exporter.id);
    setError(null);
    try {
      const result = await apiFetch<TestResult>(
        `/telemetry-exporter/${exporter.id}/test`,
        { method: "POST", body: JSON.stringify({ projectId }) },
      );
      setTests((t) => ({ ...t, [exporter.id]: result }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "The test did not run.");
    } finally {
      setTesting(null);
    }
  }

  const columns = hasActions ? 7 : 6;

  return (
    <SectionCard
      title="Telemetry"
      testId="telemetry"
      idPrefix="settings"
      cardTestId="telemetry-card"
      error={error}
      notice={notice}
      onDismissError={() => setError(null)}
      onDismissNotice={() => setNotice(null)}
      intro={
        <>
          <p className="mb-2">
            Export every turn's traces, metrics, and logs — from the server, the
            runner's daemon, and the coding agent itself — to an OpenTelemetry
            collector over OTLP/HTTP. Each exporter chooses how much leaves:
          </p>
          <dl className="ui-properties-list mb-0" data-testid="content-levels">
            {CONTENT_LEVELS.map((level) => (
              <Property key={level} label={<code>{level}</code>}>
                {CONTENT_LEVEL_LABELS[level]}
              </Property>
            ))}
          </dl>
          <p className="mb-0 mt-2">
            A runner's owner can lower what their machine sends; a turn is
            exported at the lower of the two.
          </p>
        </>
      }
    >
      <Table size="sm" responsive data-testid="telemetry-exporters">
        <thead>
          <tr>
            <th scope="col">Exporter</th>
            <th scope="col">Content</th>
            <th scope="col">Signals</th>
            <th scope="col">Sample</th>
            <th scope="col">Headers</th>
            <th scope="col">Last export</th>
            {hasActions && <th scope="col">Actions</th>}
          </tr>
        </thead>
        <tbody>
          {loading && (
            <SkeletonRows
              columns={columns}
              rows={2}
              testId="telemetry-skeleton"
              label="Loading exporters"
            />
          )}
          {!loading && exporters.length === 0 && (
            <tr>
              <td
                colSpan={columns}
                className="text-muted"
                data-testid="telemetry-empty"
              >
                Nothing is exported.{" "}
                {mayCreate
                  ? "Add an exporter to send this project's telemetry to a collector."
                  : "A project admin adds an exporter."}
              </td>
            </tr>
          )}
          {!loading &&
            exporters.map((x) => (
              <ExporterRows
                key={x.id}
                exporter={x}
                columns={columns}
                test={tests[x.id] ?? null}
                actions={
                  hasActions && (
                    <div className="d-flex gap-1 flex-wrap">
                      {mayTest && (
                        <Button
                          size="sm"
                          variant="outline-secondary"
                          disabled={busy || testing !== null}
                          onClick={() => onTest(x)}
                          data-testid={`telemetry-test-${x.id}`}
                        >
                          {testing === x.id ? "Testing…" : "Test"}
                        </Button>
                      )}
                      {mayEdit && (
                        <Button
                          size="sm"
                          variant="outline-secondary"
                          disabled={busy}
                          onClick={() => onEdit(x)}
                          data-testid={`telemetry-edit-${x.id}`}
                        >
                          Edit
                        </Button>
                      )}
                      {mayDelete && (
                        <Button
                          size="sm"
                          variant="outline-danger"
                          disabled={busy}
                          onClick={() => setDeleting(x)}
                          data-testid={`telemetry-delete-${x.id}`}
                        >
                          Delete
                        </Button>
                      )}
                    </div>
                  )
                }
              />
            ))}
        </tbody>
      </Table>

      {editing !== null ? (
        <ExporterForm
          draft={draft}
          setDraft={setDraft}
          existing={
            editing === "new"
              ? null
              : (exporters.find((x) => x.id === editing) ?? null)
          }
          busy={busy}
          onSubmit={onSubmit}
          onCancel={() => setEditing(null)}
        />
      ) : (
        mayCreate && (
          <Button
            variant="outline-primary"
            size="sm"
            disabled={busy}
            onClick={onNew}
            data-testid="telemetry-new"
          >
            Add exporter
          </Button>
        )
      )}

      <Modal
        show={deleting !== null}
        onHide={() => setDeleting(null)}
        data-testid="telemetry-delete-modal"
      >
        <Modal.Header closeButton>
          <Modal.Title>Delete {deleting?.name}?</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          Nothing more is sent to <code>{deleting?.endpoint}</code>, and its
          headers are forgotten.
        </Modal.Body>
        <Modal.Footer>
          <Button
            variant="outline-secondary"
            onClick={() => setDeleting(null)}
            data-testid="telemetry-delete-cancel"
          >
            Keep it
          </Button>
          <Button
            variant="danger"
            onClick={onDelete}
            data-testid="telemetry-delete-confirm"
          >
            Delete
          </Button>
        </Modal.Footer>
      </Modal>
    </SectionCard>
  );
}

/**
 * One exporter's row, and under it the last Test's per-signal results.
 * @param props - The exporter, the table's column count, its last test, and its action buttons.
 * @returns The rows.
 */
function ExporterRows({
  exporter: x,
  columns,
  test,
  actions,
}: {
  exporter: TelemetryExporter;
  columns: number;
  test: TestResult | null;
  actions: ReactNode;
}) {
  return (
    <>
      <tr data-testid={`telemetry-exporter-${x.id}`}>
        <td>
          <div className="d-flex align-items-center gap-2 flex-wrap">
            <strong>{x.name}</strong>
            {!x.enabled && <Chip data-testid="telemetry-paused">paused</Chip>}
          </div>
          <div className="mono text-muted">{x.endpoint}</div>
          <div className="text-meta">{x.protocol}</div>
        </td>
        <td>
          <code>{x.content}</code>
          {x.agentNative && <div className="text-meta">+ agent</div>}
        </td>
        <td>{x.signals.join(", ")}</td>
        <td className="tabular">{Math.round(x.traceSampleRatio * 100)}%</td>
        <td data-testid={`telemetry-headers-${x.id}`}>
          {x.headerNames.length === 0 ? (
            <span className="text-muted">none</span>
          ) : (
            <div className="d-flex flex-wrap gap-1">
              {x.headerNames.map((h) => (
                <Badge key={h} bg="secondary">
                  {h}
                </Badge>
              ))}
            </div>
          )}
        </td>
        <td data-testid={`telemetry-last-${x.id}`}>
          <span className="tabular">
            {x.lastExportAt === null ? "never" : relativeTime(x.lastExportAt)}
          </span>
          {showLastError(x) && (
            <div
              className="d-flex align-items-start gap-1 text-meta"
              data-testid={`telemetry-error-${x.id}`}
            >
              <ErrorGlyph label="Failing" />
              <span>
                {x.lastError}
                {x.lastErrorAt !== null && ` · ${relativeTime(x.lastErrorAt)}`}
              </span>
            </div>
          )}
        </td>
        {actions && <td>{actions}</td>}
      </tr>
      {test && (
        <tr data-testid={`telemetry-test-result-${x.id}`}>
          <td colSpan={columns}>
            <div className="d-flex flex-wrap gap-3 text-meta">
              <span className="text-muted">Test</span>
              {test.results.map((r) => (
                <span
                  key={r.signal}
                  className="d-inline-flex align-items-center gap-1"
                  data-testid={`telemetry-test-${x.id}-${r.signal}`}
                >
                  {r.ok ? (
                    <CompleteGlyph label="Accepted" />
                  ) : (
                    <ErrorGlyph label="Refused" />
                  )}
                  {r.signal}
                  {r.status > 0 && <span className="tabular">{r.status}</span>}
                  {r.error && <span className="text-muted">{r.error}</span>}
                </span>
              ))}
              {test.results.length === 0 && <span>No signals to test.</span>}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

/**
 * The exporter form. Header values are write-only: an edit shows the names
 * the exporter holds and keeps them unless the person replaces or clears
 * them; no value is ever filled in.
 * @param props - The draft and its setter, the exporter being edited (null for a new one), and the submit and cancel handlers.
 * @returns The form.
 */
function ExporterForm({
  draft,
  setDraft,
  existing,
  busy,
  onSubmit,
  onCancel,
}: {
  draft: ExporterDraft;
  setDraft: Dispatch<SetStateAction<ExporterDraft>>;
  existing: TelemetryExporter | null;
  busy: boolean;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  /**
   * Set one field of the draft.
   * @param patch - The fields to change.
   */
  const set = (patch: Partial<ExporterDraft>) =>
    setDraft((d) => ({ ...d, ...patch }));
  const showRows = existing === null || draft.headerMode === "replace";

  return (
    <Form
      className="mt-3 d-flex flex-column gap-2"
      data-testid="telemetry-form"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <h3 className="text-meta mb-0">
        {existing ? `Edit ${existing.name}` : "New exporter"}
      </h3>
      <Form.Group controlId="telemetry-name">
        <Form.Label className="text-meta">Name</Form.Label>
        <Form.Control
          value={draft.name}
          disabled={busy}
          onChange={(e) => set({ name: e.target.value })}
          data-testid="telemetry-name"
        />
      </Form.Group>
      <Form.Group controlId="telemetry-endpoint">
        <Form.Label className="text-meta">Endpoint</Form.Label>
        <Form.Control
          className="mono"
          placeholder="https://otlp.example.com"
          value={draft.endpoint}
          disabled={busy}
          onChange={(e) => set({ endpoint: e.target.value })}
          data-testid="telemetry-endpoint"
        />
        <Form.Text className="text-muted">
          The collector's OTLP/HTTP base URL; <code>/v1/traces</code> and the
          others are added per signal. It must be public <code>https</code>.
        </Form.Text>
      </Form.Group>
      <div className="d-flex gap-3 flex-wrap">
        <Form.Group controlId="telemetry-protocol">
          <Form.Label className="text-meta">Protocol</Form.Label>
          <Form.Select
            value={draft.protocol}
            disabled={busy}
            onChange={(e) => set({ protocol: e.target.value as Protocol })}
            data-testid="telemetry-protocol"
          >
            {PROTOCOLS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </Form.Select>
        </Form.Group>
        <Form.Group controlId="telemetry-content">
          <Form.Label className="text-meta">Content</Form.Label>
          <Form.Select
            value={draft.content}
            disabled={busy}
            onChange={(e) => set({ content: e.target.value as ContentLevel })}
            data-testid="telemetry-content"
          >
            {CONTENT_LEVELS.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Form.Select>
        </Form.Group>
        <Form.Group controlId="telemetry-sample">
          <Form.Label className="text-meta">
            Trace sample ratio (0–1)
          </Form.Label>
          <Form.Control
            inputMode="decimal"
            value={draft.traceSampleRatio}
            disabled={busy}
            onChange={(e) => set({ traceSampleRatio: e.target.value })}
            data-testid="telemetry-sample"
          />
        </Form.Group>
      </div>
      <Form.Text className="text-muted" data-testid="telemetry-content-help">
        {CONTENT_LEVEL_LABELS[draft.content]}
      </Form.Text>

      <div role="group" aria-labelledby="telemetry-signals-label">
        <div id="telemetry-signals-label" className="text-meta mb-1">
          Signals
        </div>
        {SIGNALS.map((s) => (
          <Form.Check
            key={s}
            inline
            label={s}
            checked={draft.signals.includes(s)}
            disabled={busy}
            onChange={(e) =>
              set({
                signals: SIGNALS.filter((x) =>
                  x === s ? e.target.checked : draft.signals.includes(x),
                ),
              })
            }
            data-testid={`telemetry-signal-${s}`}
          />
        ))}
      </div>

      <div className="d-flex gap-3 flex-wrap">
        <Form.Check
          type="switch"
          label="Capture the coding agent's own telemetry"
          checked={draft.agentNative}
          disabled={busy}
          onChange={(e) => set({ agentNative: e.target.checked })}
          data-testid="telemetry-agent-native"
        />
        <Form.Check
          type="switch"
          label="Enabled"
          checked={draft.enabled}
          disabled={busy}
          onChange={(e) => set({ enabled: e.target.checked })}
          data-testid="telemetry-enabled"
        />
      </div>

      <Form.Group controlId="telemetry-attributes">
        <Form.Label className="text-meta">Resource attributes</Form.Label>
        <Form.Control
          as="textarea"
          rows={2}
          className="mono"
          placeholder="deployment.environment=production"
          value={draft.resourceAttributes}
          disabled={busy}
          onChange={(e) => set({ resourceAttributes: e.target.value })}
          data-testid="telemetry-attributes"
        />
        <Form.Text className="text-muted">
          One <code>key=value</code> per line, stamped on everything sent.
        </Form.Text>
      </Form.Group>

      <div
        role="group"
        aria-labelledby="telemetry-headers-label"
        data-testid="telemetry-headers-field"
      >
        <div id="telemetry-headers-label" className="text-meta mb-1">
          Headers
        </div>
        {existing && (
          <div className="d-flex flex-column gap-1 mb-2">
            <div className="text-muted" data-testid="telemetry-header-names">
              {existing.headerNames.length === 0
                ? "It sends no headers."
                : `It sends ${existing.headerNames.join(", ")}. Values are never shown.`}
            </div>
            <div className="d-flex gap-3 flex-wrap">
              {(
                [
                  ["keep", "Keep them"],
                  ["replace", "Replace them all"],
                  ["clear", "Clear them"],
                ] as const
              ).map(([mode, label]) => (
                <Form.Check
                  key={mode}
                  type="radio"
                  inline
                  name="telemetry-header-mode"
                  label={label}
                  checked={draft.headerMode === mode}
                  disabled={busy}
                  onChange={() => set({ headerMode: mode })}
                  data-testid={`telemetry-header-mode-${mode}`}
                />
              ))}
            </div>
          </div>
        )}
        {showRows && (
          <div className="d-flex flex-column gap-1">
            {draft.headers.map((row, i) => (
              // Rows have no identity beyond their place; a removed row
              // re-keys the ones after it, which is harmless for plain inputs.
              // biome-ignore lint/suspicious/noArrayIndexKey: see above
              <div key={i} className="d-flex gap-2 flex-wrap">
                <Form.Control
                  size="sm"
                  className="w-auto mono"
                  placeholder="Header name"
                  aria-label={`Header ${i + 1} name`}
                  value={row.name}
                  disabled={busy}
                  onChange={(e) =>
                    set({
                      headers: draft.headers.map((h, j) =>
                        j === i ? { ...h, name: e.target.value } : h,
                      ),
                    })
                  }
                  data-testid={`telemetry-header-name-${i}`}
                />
                <Form.Control
                  size="sm"
                  type="password"
                  autoComplete="off"
                  className="w-auto mono"
                  placeholder="Value"
                  aria-label={`Header ${i + 1} value`}
                  value={row.value}
                  disabled={busy}
                  onChange={(e) =>
                    set({
                      headers: draft.headers.map((h, j) =>
                        j === i ? { ...h, value: e.target.value } : h,
                      ),
                    })
                  }
                  data-testid={`telemetry-header-value-${i}`}
                />
                <Button
                  size="sm"
                  variant="link"
                  disabled={busy}
                  aria-label={`Remove header ${i + 1}`}
                  onClick={() =>
                    set({ headers: draft.headers.filter((_, j) => j !== i) })
                  }
                >
                  Remove
                </Button>
              </div>
            ))}
            <div>
              <Button
                size="sm"
                variant="outline-secondary"
                disabled={busy}
                onClick={() =>
                  set({ headers: [...draft.headers, { name: "", value: "" }] })
                }
                data-testid="telemetry-header-add"
              >
                Add header
              </Button>
            </div>
            <Form.Text className="text-muted">
              Sent with every export, e.g. a vendor API key. Write-only: once
              saved, only the names are shown.
            </Form.Text>
          </div>
        )}
      </div>

      <div className="d-flex gap-2 mt-2">
        <Button
          type="submit"
          variant="primary"
          disabled={busy}
          data-testid="telemetry-submit"
        >
          {existing ? "Save exporter" : "Add exporter"}
        </Button>
        <Button
          variant="outline-secondary"
          disabled={busy}
          onClick={onCancel}
          data-testid="telemetry-cancel"
        >
          Cancel
        </Button>
      </div>
    </Form>
  );
}

/**
 * Which runners' coding agents add their own telemetry: each runner's owner
 * cap, and per agent whether its preset emits OpenTelemetry natively.
 * @returns The card.
 */
function RunnerTelemetryCard() {
  const { projectId } = useProjectSettings();
  const [runners, setRunners] = useState<ListedRunner[]>([]);
  const [error, setError] = useState<string | null>(null);
  const { loading, begin, done } = useFirstLoad();

  const load = useCallback(async () => {
    begin();
    try {
      setRunners(
        (
          await apiFetch<ActionResponse<RunnerList>>(
            `/runners?projectId=${projectId}&limit=100`,
          )
        ).runners,
      );
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not load the runners.",
      );
    } finally {
      done();
    }
  }, [projectId, begin, done]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <SectionCard
      title="Runners and native telemetry"
      testId="telemetry-runners"
      idPrefix="settings"
      cardTestId="telemetry-runners-card"
      error={error}
      onDismissError={() => setError(null)}
      intro={
        <>
          What each runner's owner allows to leave their machine, and whether
          each of its agents adds its own telemetry. Claude Code, Codex, Gemini
          CLI, and Qwen Code emit it natively; goose and OpenCode only if they
          read the standard <code>OTEL_*</code> variables.
        </>
      }
    >
      <Table size="sm" responsive data-testid="telemetry-runners">
        <thead>
          <tr>
            <th scope="col">Runner</th>
            <th scope="col">Owner's cap</th>
            <th scope="col">Agents</th>
          </tr>
        </thead>
        <tbody>
          {loading && (
            <SkeletonRows
              columns={3}
              rows={2}
              testId="telemetry-runners-skeleton"
              label="Loading runners"
            />
          )}
          {!loading && runners.length === 0 && (
            <tr>
              <td
                colSpan={3}
                className="text-muted"
                data-testid="telemetry-runners-empty"
              >
                No runners yet. Register one with{" "}
                <code>hypotenuse runner register</code>.
              </td>
            </tr>
          )}
          {!loading &&
            runners.map((r) => (
              <tr key={r.id} data-testid={`telemetry-runner-${r.id}`}>
                <td>{r.name}</td>
                <td data-testid={`telemetry-runner-cap-${r.id}`}>
                  {r.telemetry === null ? (
                    <span className="text-muted">reports no telemetry cap</span>
                  ) : !r.telemetry.enabled ? (
                    "sends none"
                  ) : (
                    <>
                      up to <code>{r.telemetry.maxContent}</code>
                      {!r.telemetry.agentNative && (
                        <div className="text-meta">no agent telemetry</div>
                      )}
                    </>
                  )}
                </td>
                <td>
                  {r.agents.length === 0 ? (
                    <span className="text-muted">none</span>
                  ) : (
                    <div className="d-flex flex-column gap-1">
                      {r.agents.map((a) => (
                        <span
                          key={a.id}
                          data-testid={`telemetry-agent-${r.id}-${a.id}`}
                        >
                          <code>{a.id}</code>
                          {a.preset !== a.id && (
                            <span className="text-muted"> ({a.preset})</span>
                          )}
                          {" · "}
                          {NATIVE_SUPPORT_LABELS[nativeSupport(a.preset)]}
                        </span>
                      ))}
                    </div>
                  )}
                </td>
              </tr>
            ))}
        </tbody>
      </Table>
    </SectionCard>
  );
}
