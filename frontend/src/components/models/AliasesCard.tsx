import type { ModelAliasList } from "@backend/actions/model-alias/model-alias-list";
import type { ActionResponse } from "keryx";
import { useCallback, useEffect, useState } from "react";
import { useFirstLoad } from "../../hooks/useFirstLoad";
import { Button, Form, Table } from "../../ui";
import { apiFetch } from "../../utils/client";
import { optionalNumber } from "../../utils/models";
import { ConfirmDialog } from "../ConfirmDialog";
import { GatedButton } from "../GatedButton";
import { SkeletonRows } from "../SkeletonRows";
import { SectionCard } from "../sections/SectionCard";
import { useSectionSave } from "../sections/useSectionSave";
import type { ModelConnection } from "./ConnectionsCard";
import { ModelPicker } from "./ModelPicker";

/** A model name as `model-alias:list` serializes it. */
export type ModelAlias = ActionResponse<ModelAliasList>["modelAliases"][number];

/**
 * The one name memory embeds with. An alias of this name is of kind
 * `embedding`, and no other name may be; without it, memory search matches
 * words only.
 */
export const EMBEDDING_ALIAS = "embedding";

/**
 * The kind `model-alias:create` takes for a name: `embedding` for the
 * embedding alias, `language` for every other.
 * @param name - The alias name.
 * @returns The kind.
 */
export function aliasKindFor(name: string): "embedding" | "language" {
  return name.trim() === EMBEDDING_ALIAS ? "embedding" : "language";
}

/** The alias form's fields, as typed. */
interface Draft {
  /** The alias being edited, or `null` for a new one. */
  aliasId: number | null;
  /** Whether the name is one of the two required ones, which cannot be renamed. */
  reserved: boolean;
  name: string;
  connectionId: number | null;
  modelId: string;
  temperature: string;
  maxOutputTokens: string;
  /** Options the form does not show, kept as they were. */
  providerOptions?: ModelAlias["options"]["providerOptions"];
}

/** See {@link AliasesCard}. */
export interface AliasesCardProps {
  projectId: number;
  /** The connections an alias may call through, or `null` before they load. */
  connections: ModelConnection[] | null;
  /** `useMay().reason`, for the admin-only controls. */
  reason: (actionName: string) => string | undefined;
}

/**
 * A blank draft for a name.
 * @param name - The alias name to start from.
 * @param connections - The connections, whose first is preselected.
 * @returns The draft.
 */
function blankDraft(
  name: string,
  connections: ModelConnection[] | null,
): Draft {
  return {
    aliasId: null,
    reserved: name === "default" || name === "fast",
    name,
    connectionId: connections?.[0]?.id ?? null,
    modelId: "",
    temperature: "",
    maxOutputTokens: "",
  };
}

/**
 * A project's model names: what a bot asks for (`default`, `fast`, or any
 * other), each pointing at one model through one connection. `default` and
 * `fast` come first, and while either is missing it is listed as a row to
 * set, because no bot can run until both exist. Every member reads the list;
 * an admin changes it.
 * @param props - See {@link AliasesCardProps}.
 * @returns The card.
 */
export function AliasesCard({
  projectId,
  connections,
  reason,
}: AliasesCardProps) {
  const { busy, error, notice, setError, setNotice, save } = useSectionSave();
  const [aliases, setAliases] = useState<ModelAlias[]>([]);
  const [missing, setMissing] = useState<string[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [deleting, setDeleting] = useState<ModelAlias | null>(null);
  const { loading, begin, done } = useFirstLoad();
  const createDenied = reason("model-alias:create");
  const editDenied = reason("model-alias:edit");
  const deleteDenied = reason("model-alias:delete");
  const listDenied = reason("model-connection:models");

  const load = useCallback(async () => {
    begin();
    try {
      const res = await apiFetch<ActionResponse<ModelAliasList>>(
        `/project/${projectId}/model-aliases?limit=100`,
      );
      setAliases(res.modelAliases);
      setMissing(res.missingRequired);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not load model names.",
      );
    } finally {
      done();
    }
  }, [projectId, setError, begin, done]);

  useEffect(() => {
    load();
  }, [load]);

  /**
   * Open the form on an existing alias.
   * @param alias - The alias to edit.
   */
  function edit(alias: ModelAlias) {
    setDraft({
      aliasId: alias.id,
      reserved: alias.reserved,
      name: alias.name,
      connectionId: alias.connectionId,
      modelId: alias.modelId,
      temperature: alias.options.temperature?.toString() ?? "",
      maxOutputTokens: alias.options.maxOutputTokens?.toString() ?? "",
      providerOptions: alias.options.providerOptions,
    });
  }

  /** Save the draft: create a new alias or edit the one it was opened on. */
  async function onSave() {
    if (!draft) return;
    const temperature = optionalNumber(draft.temperature);
    const maxOutputTokens = optionalNumber(draft.maxOutputTokens);
    if (temperature === undefined || maxOutputTokens === undefined) {
      setError("Temperature and the output limit are numbers, or empty.");
      return;
    }
    const options = {
      ...(temperature !== null ? { temperature } : {}),
      ...(maxOutputTokens !== null ? { maxOutputTokens } : {}),
      ...(draft.providerOptions
        ? { providerOptions: draft.providerOptions }
        : {}),
    };
    const body = {
      ...(draft.aliasId === null || !draft.reserved
        ? { name: draft.name.trim() }
        : {}),
      ...(draft.aliasId === null ? { kind: aliasKindFor(draft.name) } : {}),
      connectionId: draft.connectionId,
      modelId: draft.modelId.trim(),
      options,
    };
    const ok = await save(
      () =>
        draft.aliasId === null
          ? apiFetch(`/project/${projectId}/model-alias`, {
              method: "PUT",
              body: JSON.stringify(body),
            })
          : apiFetch(`/project/${projectId}/model-alias/${draft.aliasId}`, {
              method: "POST",
              body: JSON.stringify(body),
            }),
      `Saved the ${draft.name.trim()} model name.`,
    );
    if (!ok) return;
    setDraft(null);
    await load();
  }

  /**
   * Delete the alias under confirmation. The server refuses while a bot names
   * it, and says which bots; that lands in this card.
   */
  async function onDelete() {
    const target = deleting;
    if (!target) return;
    setDeleting(null);
    const ok = await save(
      () =>
        apiFetch(`/project/${projectId}/model-alias/${target.id}`, {
          method: "DELETE",
        }),
      `Deleted the ${target.name} model name.`,
    );
    if (ok) await load();
  }

  const noConnections = connections !== null && connections.length === 0;
  const formDenied = draft?.aliasId === null ? createDenied : editDenied;
  const draftIsEmbedding =
    draft !== null && aliasKindFor(draft.name) === "embedding";
  const noEmbedding = !aliases.some((a) => a.name === EMBEDDING_ALIAS);

  return (
    <SectionCard
      title="Model names"
      testId="model-aliases"
      idPrefix="settings"
      cardTestId="model-aliases-card"
      intro={
        <>
          A bot never names a model directly; it names one of these. Change what{" "}
          <code>default</code> points at and every bot using it follows, with no
          bot edited. Every project needs <code>default</code> (a bot's main
          model) and <code>fast</code> (its quick, cheap one) before any bot can
          run. An optional <code>embedding</code> name, on an OpenAI, Vercel AI
          Gateway, or OpenAI-compatible connection, lets memory search find
          things by meaning as well as by their words.
        </>
      }
      error={error}
      notice={notice}
      onDismissError={() => setError(null)}
      onDismissNotice={() => setNotice(null)}
    >
      <Table size="sm" responsive data-testid="model-alias-list">
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">Connection</th>
            <th scope="col">Model</th>
            <th scope="col">Options</th>
            <th scope="col" className="text-end">
              <span className="visually-hidden">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {loading && (
            <SkeletonRows
              columns={5}
              rows={2}
              testId="model-aliases-skeleton"
              label="Loading model names"
            />
          )}
          {!loading &&
            missing.map((name) => (
              <tr key={`missing-${name}`} data-testid={`alias-missing-${name}`}>
                <td>
                  <span className="mono">{name}</span>{" "}
                  <span className="text-meta">required</span>
                </td>
                <td colSpan={3} className="text-warning">
                  Not set — no bot can run until it is.
                </td>
                <td className="text-end">
                  <GatedButton
                    size="sm"
                    variant="outline-primary"
                    disabled={busy || noConnections}
                    title={
                      noConnections ? "Add a connection first." : undefined
                    }
                    deniedReason={createDenied}
                    onClick={() => setDraft(blankDraft(name, connections))}
                    data-testid={`set-alias-${name}`}
                  >
                    Set
                  </GatedButton>
                </td>
              </tr>
            ))}
          {!loading &&
            aliases.map((a) => (
              <tr key={a.id} data-testid={`alias-row-${a.name}`}>
                <td>
                  <span className="mono">{a.name}</span>
                  {a.reserved && (
                    <>
                      {" "}
                      <span className="text-meta">required</span>
                    </>
                  )}
                  {a.kind === "embedding" && (
                    <>
                      {" "}
                      <span className="text-meta">memory search</span>
                    </>
                  )}
                </td>
                <td>{a.connectionName ?? "—"}</td>
                <td className="mono">{a.modelId}</td>
                <td className="text-meta tabular">
                  {[
                    a.options.temperature !== undefined
                      ? `temperature ${a.options.temperature}`
                      : null,
                    a.options.maxOutputTokens !== undefined
                      ? `${a.options.maxOutputTokens} tokens max`
                      : null,
                    a.options.providerOptions ? "provider options" : null,
                  ]
                    .filter(Boolean)
                    .join(" · ") || "—"}
                </td>
                <td className="text-end">
                  <div className="d-inline-flex gap-2">
                    <GatedButton
                      size="sm"
                      variant="outline-secondary"
                      disabled={busy}
                      deniedReason={editDenied}
                      onClick={() => edit(a)}
                      data-testid={`edit-alias-${a.name}`}
                    >
                      Edit
                    </GatedButton>
                    <GatedButton
                      size="sm"
                      variant="outline-danger"
                      disabled={busy}
                      deniedReason={deleteDenied}
                      aria-label={`Delete the ${a.name} model name`}
                      onClick={() => setDeleting(a)}
                      data-testid={`delete-alias-${a.name}`}
                    >
                      Delete
                    </GatedButton>
                  </div>
                </td>
              </tr>
            ))}
          {!loading && noEmbedding && (
            <tr data-testid="alias-missing-embedding">
              <td>
                <span className="mono">{EMBEDDING_ALIAS}</span>{" "}
                <span className="text-meta">optional</span>
              </td>
              <td colSpan={3} className="text-meta">
                Not set — memory search matches words only.
              </td>
              <td className="text-end">
                <GatedButton
                  size="sm"
                  variant="outline-secondary"
                  disabled={busy || noConnections}
                  title={noConnections ? "Add a connection first." : undefined}
                  deniedReason={createDenied}
                  onClick={() =>
                    setDraft(blankDraft(EMBEDDING_ALIAS, connections))
                  }
                  data-testid="set-alias-embedding"
                >
                  Set
                </GatedButton>
              </td>
            </tr>
          )}
        </tbody>
      </Table>

      {draft ? (
        <Form
          className="model-alias-form"
          onSubmit={(e) => {
            e.preventDefault();
            onSave();
          }}
          data-testid="alias-form"
        >
          <h3 className="settings-subheading">
            {draft.aliasId === null ? `New model name` : `Edit ${draft.name}`}
          </h3>
          {draftIsEmbedding && (
            <p className="text-meta" data-testid="alias-embedding-hint">
              Memory's embedding model: choose one that returns 1536-dimensional
              vectors, such as OpenAI's <code>text-embedding-3-small</code>. It
              is tried before it is saved, and changing it re-embeds the
              project's memory.
            </p>
          )}
          <div className="model-alias-fields">
            <Form.Group controlId="alias-name" className="mb-0">
              <Form.Label>Name</Form.Label>
              <Form.Control
                size="sm"
                className="mono"
                placeholder="reasoning"
                value={draft.name}
                disabled={busy || (draft.reserved && draft.aliasId !== null)}
                title={
                  draft.reserved && draft.aliasId !== null
                    ? "default and fast are required names, so they cannot be renamed."
                    : undefined
                }
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                data-testid="alias-name"
              />
            </Form.Group>
            <Form.Group controlId="alias-connection" className="mb-0">
              <Form.Label>Connection</Form.Label>
              <Form.Select
                size="sm"
                value={draft.connectionId ?? ""}
                disabled={busy}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    connectionId: e.target.value
                      ? Number(e.target.value)
                      : null,
                  })
                }
                data-testid="alias-connection"
              >
                {(connections ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} · {c.providerLabel}
                  </option>
                ))}
              </Form.Select>
            </Form.Group>
            <Form.Group className="mb-0">
              <Form.Label htmlFor="alias-model">Model</Form.Label>
              <ModelPicker
                id="alias-model"
                projectId={projectId}
                connectionId={draft.connectionId}
                value={draft.modelId}
                onChange={(modelId) => setDraft({ ...draft, modelId })}
                disabled={busy}
                canList={listDenied === undefined}
                testId="alias-model"
              />
            </Form.Group>
            {!draftIsEmbedding && (
              <>
                <Form.Group controlId="alias-temperature" className="mb-0">
                  <Form.Label>
                    Temperature <span className="text-meta">optional, 0–2</span>
                  </Form.Label>
                  <Form.Control
                    size="sm"
                    type="number"
                    min={0}
                    max={2}
                    step={0.1}
                    value={draft.temperature}
                    disabled={busy}
                    onChange={(e) =>
                      setDraft({ ...draft, temperature: e.target.value })
                    }
                    data-testid="alias-temperature"
                  />
                </Form.Group>
                <Form.Group controlId="alias-max-tokens" className="mb-0">
                  <Form.Label>
                    Output limit{" "}
                    <span className="text-meta">optional, tokens</span>
                  </Form.Label>
                  <Form.Control
                    size="sm"
                    type="number"
                    min={1}
                    step={1}
                    value={draft.maxOutputTokens}
                    disabled={busy}
                    onChange={(e) =>
                      setDraft({ ...draft, maxOutputTokens: e.target.value })
                    }
                    data-testid="alias-max-tokens"
                  />
                </Form.Group>
              </>
            )}
          </div>
          <div className="d-flex gap-2 mt-3">
            <GatedButton
              size="sm"
              type="submit"
              variant="primary"
              disabled={
                busy ||
                draft.name.trim() === "" ||
                draft.modelId.trim() === "" ||
                draft.connectionId === null
              }
              deniedReason={formDenied}
              data-testid="alias-save"
            >
              Save
            </GatedButton>
            <Button
              size="sm"
              variant="outline-secondary"
              onClick={() => setDraft(null)}
              data-testid="alias-cancel"
            >
              Cancel
            </Button>
          </div>
        </Form>
      ) : (
        <GatedButton
          size="sm"
          variant="outline-primary"
          disabled={busy || noConnections}
          title={noConnections ? "Add a connection first." : undefined}
          deniedReason={createDenied}
          onClick={() => setDraft(blankDraft("", connections))}
          data-testid="new-alias"
        >
          New model name
        </GatedButton>
      )}

      <ConfirmDialog
        show={deleting !== null}
        title={`Delete ${deleting?.name ?? "this model name"}?`}
        confirmLabel="Delete model name"
        busy={busy}
        onConfirm={onDelete}
        onCancel={() => setDeleting(null)}
        testId="delete-alias"
      >
        {deleting?.reserved
          ? `${deleting.name} is required: until it is set again, no bot can run. `
          : ""}
        A name a bot still uses cannot be deleted; point those bots at another
        name first.
      </ConfirmDialog>
    </SectionCard>
  );
}
