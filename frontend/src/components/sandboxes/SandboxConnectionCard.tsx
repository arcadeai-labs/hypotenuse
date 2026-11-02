import { useEffect, useState } from "react";
import {
  Button,
  CompleteGlyph,
  FailedGlyph,
  Form,
  ProvisioningGlyph,
} from "../../ui";
import { apiFetch } from "../../utils/client";
import {
  type ConnectionDraft,
  type ConnectionKindInfo,
  connectionProbeLabel,
  maskedToken,
  type ProjectConnection,
  parseConnectionDraft,
} from "../../utils/sandboxProviders";
import { ConfirmDialog } from "../ConfirmDialog";
import { GatedButton } from "../GatedButton";
import { SectionCard } from "../sections/SectionCard";
import { useSectionSave } from "../sections/useSectionSave";

/** See {@link SandboxConnectionCard}. */
export interface SandboxConnectionCardProps {
  projectId: number;
  /** The kind of connection, with the fields it takes. */
  kind: ConnectionKindInfo;
  /** The project's connection of this kind, or `null` when it has none. */
  connection: ProjectConnection | null;
  /** Re-read the connections (and the settings that depend on them). */
  reload: () => Promise<void>;
  /** `useMay().reason`, for the admin-only controls. */
  reason: (actionName: string) => string | undefined;
}

/**
 * A blank form, or one holding a saved connection's non-secret fields. The
 * token is never pre-filled: the server does not have it to give.
 * @param kind - The connection kind.
 * @param connection - The saved connection, or `null`.
 * @returns The form's text.
 */
function draftOf(
  kind: ConnectionKindInfo,
  connection: ProjectConnection | null,
): ConnectionDraft {
  const config: Record<string, string> = {};
  for (const field of kind.fields) {
    const value = connection?.config[field.key];
    config[field.key] = typeof value === "string" ? value : "";
  }
  return { name: connection?.name ?? "", config, token: "" };
}

/**
 * A connection's last probe as a glyph: a dotted ring before it is tested, a
 * disc with a check when it worked, a disc with a cross when it did not. The
 * shape carries the meaning; the words beside it say it again.
 * @param props - The connection's `status`.
 * @returns The glyph.
 */
function ProbeGlyph({ status }: { status: string }) {
  const props = {
    label: connectionProbeLabel(status),
    "data-status": status,
  };
  if (status === "ok") return <CompleteGlyph {...props} />;
  if (status === "error") return <FailedGlyph {...props} />;
  return <ProvisioningGlyph {...props} />;
}

/**
 * The project's account on a sandbox provider that runs on the customer's own
 * account (a Vercel team and project): its non-secret fields, the last four
 * characters of its token, and whether its last probe worked. Every member
 * reads it; an admin connects one (probed before it is saved), tests it,
 * replaces its token or fields, and deletes it. The token goes up once and
 * never comes back.
 * @param props - See {@link SandboxConnectionCardProps}.
 * @returns The card.
 */
export function SandboxConnectionCard({
  projectId,
  kind,
  connection,
  reload,
  reason,
}: SandboxConnectionCardProps) {
  const { busy, error, notice, setError, setNotice, save } = useSectionSave();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<ConnectionDraft>(() =>
    draftOf(kind, connection),
  );
  const [deleting, setDeleting] = useState(false);
  const createDenied = reason("connection:create");
  const editDenied = reason("connection:edit");
  const testDenied = reason("connection:test");
  const deleteDenied = reason("connection:delete");
  const testId = `sandbox-connection-${kind.kind}`;
  const formOpen = connection === null || editing;
  const formDenied = connection === null ? createDenied : editDenied;

  useEffect(() => {
    setDraft(draftOf(kind, connection));
  }, [kind, connection]);

  /**
   * Change one field of the form.
   * @param patch - The fields to change.
   */
  function set(patch: Partial<ConnectionDraft>) {
    setDraft((d) => ({ ...d, ...patch }));
    setNotice(null);
  }

  /** Connect, or save the edit; the server probes before it saves. */
  async function onSubmit() {
    const body = parseConnectionDraft(kind, draft, connection !== null);
    if (typeof body === "string") {
      setError(body);
      return;
    }
    const ok = await save(
      () =>
        connection === null
          ? apiFetch(`/project/${projectId}/connection`, {
              method: "PUT",
              body: JSON.stringify({ kind: kind.kind, ...body }),
            })
          : apiFetch(`/project/${projectId}/connection/${connection.id}`, {
              method: "POST",
              body: JSON.stringify(body),
            }),
      connection === null
        ? `Connected ${kind.label}: it answered, and the token is stored encrypted.`
        : `Saved the ${kind.label} connection.`,
    );
    if (!ok) return;
    setEditing(false);
    await reload();
  }

  /**
   * Ask the provider whether the stored token still works. A failed probe is
   * still an answer: the status turns to its error glyph and shows why.
   */
  async function onTest() {
    if (!connection) return;
    let tested: ProjectConnection | null = null;
    const ok = await save(async () => {
      const res = await apiFetch<{
        connection: ProjectConnection;
        message: string;
      }>(`/project/${projectId}/connection/${connection.id}/test`, {
        method: "POST",
      });
      tested = res.connection;
    }, `${kind.label} answered.`);
    if (!ok) return;
    const result = tested as ProjectConnection | null;
    if (result && result.status !== "ok") {
      setNotice(null);
      setError(
        `${kind.label} refused the connection: ${result.lastError ?? "no reason given"}.`,
      );
    }
    await reload();
  }

  /** Delete the connection; the server refuses while the project runs on it. */
  async function onDelete() {
    if (!connection) return;
    setDeleting(false);
    const ok = await save(
      () =>
        apiFetch(`/project/${projectId}/connection/${connection.id}`, {
          method: "DELETE",
        }),
      `Deleted the ${kind.label} connection; its token is erased.`,
    );
    if (ok) await reload();
  }

  return (
    <SectionCard
      title={`${kind.label} connection`}
      testId={testId}
      idPrefix="settings"
      intro={
        <>
          {kind.description} The token is encrypted when it is saved and never
          shown again — only its last four characters. Connecting probes the
          account first, so a wrong token, team, or project is refused here.
        </>
      }
      error={error}
      notice={notice}
      onDismissError={() => setError(null)}
      onDismissNotice={() => setNotice(null)}
    >
      {connection && (
        <>
          <dl
            className="settings-facts sandbox-connection-facts"
            data-testid={`${testId}-facts`}
          >
            <dt>Status</dt>
            <dd>
              <span
                className="conversation-state"
                data-testid={`${testId}-status`}
                data-status={connection.status}
              >
                <ProbeGlyph status={connection.status} />
                {connectionProbeLabel(connection.status)}
                {connection.lastCheckedAt && (
                  <span className="text-meta">
                    {" "}
                    · tested{" "}
                    {new Date(connection.lastCheckedAt).toLocaleString()}
                  </span>
                )}
              </span>
            </dd>
            {connection.status === "error" && connection.lastError && (
              <>
                <dt>Last error</dt>
                <dd className="text-danger" data-testid={`${testId}-error`}>
                  {connection.lastError}
                </dd>
              </>
            )}
            <dt>Name</dt>
            <dd>{connection.name}</dd>
            {kind.fields.map((field) => (
              <FieldFact
                key={field.key}
                label={field.label}
                value={connection.config[field.key]}
              />
            ))}
            <dt>{kind.secretLabel}</dt>
            <dd className="mono" data-testid={`${testId}-token`}>
              {maskedToken(connection.lastFour)}
            </dd>
          </dl>
          {!editing && (
            <div className="sandbox-connection-actions">
              <GatedButton
                size="sm"
                variant="outline-secondary"
                disabled={busy}
                deniedReason={testDenied}
                onClick={onTest}
                data-testid={`${testId}-test`}
              >
                Test
              </GatedButton>
              <GatedButton
                size="sm"
                variant="outline-secondary"
                disabled={busy}
                deniedReason={editDenied}
                onClick={() => {
                  setDraft(draftOf(kind, connection));
                  setEditing(true);
                  setNotice(null);
                }}
                data-testid={`${testId}-edit`}
              >
                Replace token or ids
              </GatedButton>
              <GatedButton
                size="sm"
                variant="outline-danger"
                disabled={busy}
                deniedReason={deleteDenied}
                onClick={() => setDeleting(true)}
                data-testid={`${testId}-delete`}
              >
                Delete
              </GatedButton>
            </div>
          )}
        </>
      )}

      {formOpen && (
        <Form
          className="sandbox-connection-form"
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit();
          }}
          data-testid={`${testId}-form`}
        >
          <div className="sandbox-fields">
            <Form.Group controlId={`${testId}-name`} className="mb-0">
              <Form.Label>
                Name <span className="text-meta">optional</span>
              </Form.Label>
              <Form.Control
                size="sm"
                className="settings-input"
                placeholder={kind.label}
                value={draft.name}
                disabled={busy || formDenied !== undefined}
                title={formDenied}
                onChange={(e) => set({ name: e.target.value })}
                data-testid={`${testId}-name`}
              />
            </Form.Group>
            {kind.fields.map((field) => (
              <Form.Group
                key={field.key}
                controlId={`${testId}-${field.key}`}
                className="mb-0"
              >
                <Form.Label>{field.label}</Form.Label>
                <Form.Control
                  size="sm"
                  className="settings-input mono"
                  autoComplete="off"
                  value={draft.config[field.key] ?? ""}
                  disabled={busy || formDenied !== undefined}
                  title={formDenied}
                  onChange={(e) =>
                    set({
                      config: { ...draft.config, [field.key]: e.target.value },
                    })
                  }
                  data-testid={`${testId}-${field.key}`}
                />
                <Form.Text className="text-muted">
                  {field.description}
                </Form.Text>
              </Form.Group>
            ))}
            <Form.Group controlId={`${testId}-token`} className="mb-0">
              <Form.Label>{kind.secretLabel}</Form.Label>
              <Form.Control
                size="sm"
                type="password"
                className="settings-input"
                autoComplete="off"
                placeholder={
                  connection
                    ? `Blank keeps ${maskedToken(connection.lastFour)}`
                    : ""
                }
                value={draft.token}
                disabled={busy || formDenied !== undefined}
                title={formDenied}
                onChange={(e) => set({ token: e.target.value })}
                data-testid={`${testId}-token-input`}
              />
              <Form.Text className="text-muted">
                {kind.secretDescription}
              </Form.Text>
            </Form.Group>
          </div>
          <div className="sandbox-connection-actions">
            <GatedButton
              size="sm"
              type="submit"
              variant="outline-primary"
              disabled={busy}
              deniedReason={formDenied}
              data-testid={`${testId}-submit`}
            >
              {connection ? "Save connection" : `Connect ${kind.label}`}
            </GatedButton>
            {editing && (
              <Button
                size="sm"
                variant="outline-secondary"
                disabled={busy}
                onClick={() => {
                  setEditing(false);
                  setDraft(draftOf(kind, connection));
                }}
              >
                Cancel
              </Button>
            )}
          </div>
        </Form>
      )}

      <ConfirmDialog
        show={deleting}
        title={`Delete the ${kind.label} connection?`}
        confirmLabel="Delete connection"
        busy={busy}
        onConfirm={onDelete}
        onCancel={() => setDeleting(false)}
        testId={`${testId}-delete`}
      >
        Its token is erased and cannot be recovered. While the project's
        sandboxes run on {kind.label}, the connection cannot be deleted: choose
        another provider first.
      </ConfirmDialog>
    </SectionCard>
  );
}

/**
 * One non-secret field of a saved connection.
 * @param props - The field's label and its saved value.
 * @returns The term and its description.
 */
function FieldFact({ label, value }: { label: string; value: unknown }) {
  return (
    <>
      <dt>{label}</dt>
      <dd className="mono">{typeof value === "string" ? value : "—"}</dd>
    </>
  );
}
