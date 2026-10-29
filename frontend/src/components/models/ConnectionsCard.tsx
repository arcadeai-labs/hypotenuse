import type { ModelConnectionList } from "@backend/actions/model-connection/model-connection-list";
import type { ActionResponse } from "keryx";
import { type ReactNode, useState } from "react";
import { Button, Form, Table } from "../../ui";
import { apiFetch } from "../../utils/client";
import {
  type ModelProviderKind,
  maskedKey,
  PROVIDER_OPTIONS,
  providerOption,
} from "../../utils/models";
import { ConfirmDialog } from "../ConfirmDialog";
import { GatedButton } from "../GatedButton";
import { SkeletonRows } from "../SkeletonRows";
import { SectionCard } from "../sections/SectionCard";
import { useSectionSave } from "../sections/useSectionSave";
import { ConnectionStatusGlyph } from "./ConnectionStatusGlyph";

/** A connection as `model-connection:list` serializes it — never with its key. */
export type ModelConnection =
  ActionResponse<ModelConnectionList>["modelConnections"][number];

/** See {@link ConnectionsCard}. */
export interface ConnectionsCardProps {
  projectId: number;
  /** The project's connections, or `null` before the first answer. */
  connections: ModelConnection[] | null;
  /** Re-read the connections after a change. */
  reload: () => Promise<void>;
  /** `useMay().reason`, for the admin-only controls. */
  reason: (actionName: string) => string | undefined;
}

/**
 * A project's model connections: a provider and the key that pays for it.
 * Every member reads the list; an admin adds one, rotates its key, tests it,
 * and deletes it. A key goes up once and never comes back: the list shows its
 * last four characters and nothing else.
 * @param props - See {@link ConnectionsCardProps}.
 * @returns The card.
 */
export function ConnectionsCard({
  projectId,
  connections,
  reload,
  reason,
}: ConnectionsCardProps) {
  const { busy, error, notice, setError, setNotice, save } = useSectionSave();
  const [name, setName] = useState("");
  const [provider, setProvider] = useState<ModelProviderKind>("anthropic");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [rotating, setRotating] = useState<{ id: number; key: string } | null>(
    null,
  );
  const [deleting, setDeleting] = useState<ModelConnection | null>(null);
  const createDenied = reason("model-connection:create");
  const editDenied = reason("model-connection:edit");
  const testDenied = reason("model-connection:test");
  const deleteDenied = reason("model-connection:delete");
  const option = providerOption(provider);

  /** Add the connection the form describes. */
  async function onAdd() {
    const trimmedUrl = baseUrl.trim();
    if (option.needsBaseUrl && !trimmedUrl) {
      setError(`An ${option.label} connection needs its base URL.`);
      return;
    }
    const ok = await save(
      () =>
        apiFetch(`/project/${projectId}/model-connection`, {
          method: "PUT",
          body: JSON.stringify({
            name: name.trim(),
            provider,
            apiKey,
            ...(trimmedUrl ? { baseUrl: trimmedUrl } : {}),
          }),
        }),
      `Added ${name.trim()}. Test it to check the key.`,
    );
    if (!ok) return;
    setName("");
    setBaseUrl("");
    setApiKey("");
    await reload();
  }

  /**
   * Ask the provider whether the key works. A failed probe is still an
   * answer: the row turns to its error glyph and shows what the provider said.
   * @param connection - The connection to test.
   */
  async function onTest(connection: ModelConnection) {
    let result: ModelConnection | null = null;
    const ok = await save(async () => {
      const res = await apiFetch<{ modelConnection: ModelConnection }>(
        `/project/${projectId}/model-connection/${connection.id}/test`,
        { method: "POST" },
      );
      result = res.modelConnection;
    }, `Tested ${connection.name}.`);
    if (!ok) return;
    const tested = result as ModelConnection | null;
    if (tested?.status === "ok") {
      setNotice(`${connection.name} works.`);
    } else if (tested) {
      setNotice(null);
      setError(
        `${connection.name} did not answer as expected: ${tested.lastError ?? "no reason given"}.`,
      );
    }
    await reload();
  }

  /** Replace the stored key of the connection being rotated. */
  async function onRotate() {
    if (!rotating) return;
    const target = connections?.find((c) => c.id === rotating.id);
    const ok = await save(
      () =>
        apiFetch(`/project/${projectId}/model-connection/${rotating.id}`, {
          method: "POST",
          body: JSON.stringify({ apiKey: rotating.key }),
        }),
      `Replaced the key of ${target?.name ?? "the connection"}. Test it to check the new one.`,
    );
    if (!ok) return;
    setRotating(null);
    await reload();
  }

  /**
   * Delete the connection under confirmation. The server refuses while a
   * model name uses it, and names which; that lands in this card.
   */
  async function onDelete() {
    const target = deleting;
    if (!target) return;
    setDeleting(null);
    const ok = await save(
      () =>
        apiFetch(`/project/${projectId}/model-connection/${target.id}`, {
          method: "DELETE",
        }),
      `Deleted ${target.name}.`,
    );
    if (ok) await reload();
  }

  return (
    <SectionCard
      title="Connections"
      testId="model-connections"
      idPrefix="settings"
      cardTestId="model-connections-card"
      intro={
        <>
          A connection is a model provider and the API key that pays for it. The
          key is encrypted when it is saved and never shown again — only its
          last four characters. Model names below choose a model through a
          connection.
        </>
      }
      error={error}
      notice={notice}
      onDismissError={() => setError(null)}
      onDismissNotice={() => setNotice(null)}
    >
      <Table size="sm" responsive data-testid="model-connection-list">
        <thead>
          <tr>
            <th scope="col">
              <span className="visually-hidden">Status</span>
            </th>
            <th scope="col">Name</th>
            <th scope="col">Provider</th>
            <th scope="col">Endpoint</th>
            <th scope="col">Key</th>
            <th scope="col" className="text-end">
              <span className="visually-hidden">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {connections === null && (
            <SkeletonRows
              columns={6}
              rows={2}
              testId="model-connections-skeleton"
              label="Loading connections"
            />
          )}
          {connections?.length === 0 && (
            <tr>
              <td
                colSpan={6}
                className="text-muted"
                data-testid="no-model-connections"
              >
                No connections yet. An admin adds one with a provider's API key.
              </td>
            </tr>
          )}
          {connections?.map((c) => {
            const isRotating = rotating?.id === c.id;
            return (
              <ConnectionRows
                key={c.id}
                connection={c}
                actions={
                  isRotating ? (
                    <Form
                      className="d-inline-flex gap-2"
                      onSubmit={(e) => {
                        e.preventDefault();
                        onRotate();
                      }}
                    >
                      <Form.Label visuallyHidden htmlFor={`rotate-key-${c.id}`}>
                        New API key for {c.name}
                      </Form.Label>
                      <Form.Control
                        id={`rotate-key-${c.id}`}
                        type="password"
                        size="sm"
                        className="w-auto"
                        autoComplete="off"
                        placeholder="New API key"
                        value={rotating.key}
                        autoFocus
                        disabled={busy}
                        onChange={(e) =>
                          setRotating({ id: c.id, key: e.target.value })
                        }
                        data-testid={`rotate-key-input-${c.name}`}
                      />
                      <Button
                        size="sm"
                        type="submit"
                        variant="primary"
                        disabled={busy || rotating.key.trim() === ""}
                        data-testid={`rotate-key-save-${c.name}`}
                      >
                        Save
                      </Button>
                      <Button
                        size="sm"
                        variant="outline-secondary"
                        onClick={() => setRotating(null)}
                      >
                        Cancel
                      </Button>
                    </Form>
                  ) : (
                    <div className="d-inline-flex gap-2">
                      <GatedButton
                        size="sm"
                        variant="outline-secondary"
                        disabled={busy}
                        deniedReason={testDenied}
                        onClick={() => onTest(c)}
                        data-testid={`test-connection-${c.name}`}
                      >
                        Test
                      </GatedButton>
                      <GatedButton
                        size="sm"
                        variant="outline-secondary"
                        disabled={busy}
                        deniedReason={editDenied}
                        onClick={() => setRotating({ id: c.id, key: "" })}
                        data-testid={`rotate-connection-${c.name}`}
                      >
                        Rotate key
                      </GatedButton>
                      <GatedButton
                        size="sm"
                        variant="outline-danger"
                        disabled={busy}
                        deniedReason={deleteDenied}
                        aria-label={`Delete the ${c.name} connection`}
                        onClick={() => setDeleting(c)}
                        data-testid={`delete-connection-${c.name}`}
                      >
                        Delete
                      </GatedButton>
                    </div>
                  )
                }
              />
            );
          })}
        </tbody>
      </Table>

      <Form
        className="model-connection-form"
        onSubmit={(e) => {
          e.preventDefault();
          onAdd();
        }}
        data-testid="new-connection-form"
      >
        <Form.Group controlId="new-connection-name" className="mb-0">
          <Form.Label>Name</Form.Label>
          <Form.Control
            size="sm"
            placeholder="Anthropic (production)"
            value={name}
            disabled={busy || createDenied !== undefined}
            title={createDenied}
            onChange={(e) => setName(e.target.value)}
            data-testid="new-connection-name"
          />
        </Form.Group>
        <Form.Group controlId="new-connection-provider" className="mb-0">
          <Form.Label>Provider</Form.Label>
          <Form.Select
            size="sm"
            value={provider}
            disabled={busy || createDenied !== undefined}
            title={createDenied}
            onChange={(e) => setProvider(e.target.value as ModelProviderKind)}
            data-testid="new-connection-provider"
          >
            {PROVIDER_OPTIONS.map((p) => (
              <option key={p.kind} value={p.kind}>
                {p.label}
              </option>
            ))}
          </Form.Select>
        </Form.Group>
        <Form.Group controlId="new-connection-base-url" className="mb-0">
          <Form.Label>
            Base URL{" "}
            <span className="text-meta">
              {option.needsBaseUrl ? "required" : "optional"}
            </span>
          </Form.Label>
          <Form.Control
            size="sm"
            type="url"
            placeholder={option.placeholder}
            value={baseUrl}
            required={option.needsBaseUrl}
            disabled={busy || createDenied !== undefined}
            title={createDenied}
            onChange={(e) => setBaseUrl(e.target.value)}
            data-testid="new-connection-base-url"
          />
        </Form.Group>
        <Form.Group controlId="new-connection-key" className="mb-0">
          <Form.Label>API key</Form.Label>
          <Form.Control
            size="sm"
            type="password"
            autoComplete="off"
            value={apiKey}
            disabled={busy || createDenied !== undefined}
            title={createDenied}
            onChange={(e) => setApiKey(e.target.value)}
            data-testid="new-connection-key"
          />
        </Form.Group>
        <GatedButton
          size="sm"
          type="submit"
          variant="outline-primary"
          disabled={busy || name.trim() === "" || apiKey.trim() === ""}
          deniedReason={createDenied}
          data-testid="new-connection-submit"
        >
          Add connection
        </GatedButton>
      </Form>

      <ConfirmDialog
        show={deleting !== null}
        title={`Delete ${deleting?.name ?? "this connection"}?`}
        confirmLabel="Delete connection"
        busy={busy}
        onConfirm={onDelete}
        onCancel={() => setDeleting(null)}
        testId="delete-connection"
      >
        Its key is erased and cannot be recovered. A connection that a model
        name still uses cannot be deleted: point those names at another
        connection first.
      </ConfirmDialog>
    </SectionCard>
  );
}

/**
 * One connection's row, and under it the provider's last refusal when its
 * last test failed — the sentence that says what to fix.
 * @param props - The connection and the actions cell's content.
 * @returns The rows.
 */
function ConnectionRows({
  connection: c,
  actions,
}: {
  connection: ModelConnection;
  actions: ReactNode;
}) {
  return (
    <>
      <tr data-testid={`connection-row-${c.name}`}>
        <td>
          <ConnectionStatusGlyph
            status={c.status}
            testId={`connection-status-${c.name}`}
          />
        </td>
        <td>{c.name}</td>
        <td>{c.providerLabel}</td>
        <td className="model-connection-url">
          {c.baseUrl ? (
            <span className="mono">{c.baseUrl}</span>
          ) : (
            <span className="text-meta" title={c.defaultBaseUrl ?? undefined}>
              Provider default
            </span>
          )}
        </td>
        <td className="mono" data-testid={`connection-key-${c.name}`}>
          {maskedKey(c.lastFour)}
        </td>
        <td className="text-end">{actions}</td>
      </tr>
      {c.status === "error" && c.lastError && (
        <tr className="model-connection-error-row">
          <td />
          <td
            colSpan={5}
            className="text-danger"
            data-testid={`connection-error-${c.name}`}
          >
            {c.lastError}
            {c.lastCheckedAt && (
              <span className="text-meta">
                {" "}
                · tested {new Date(c.lastCheckedAt).toLocaleString()}
              </span>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
