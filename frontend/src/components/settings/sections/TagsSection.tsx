import type { TagList } from "@backend/actions/tag/tag-list";
import type { ActionResponse } from "keryx";
import { Lock } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useFirstLoad } from "../../../hooks/useFirstLoad";
import { Button, Form, Table } from "../../../ui";
import { apiFetch } from "../../../utils/client";
import { GatedButton } from "../../GatedButton";
import { SkeletonRows } from "../../SkeletonRows";
import { SectionCard } from "../../sections/SectionCard";
import { useSectionSave } from "../../sections/useSectionSave";
import { useProjectSettings } from "../context";

/** A tag as `tag:list` serializes it, `reserved` included. */
type ProjectTag = ActionResponse<TagList>["tags"][number];

/** What the reserved tag's locked controls say. */
export const RESERVED_TAG_REASON =
  "The admin tag is reserved: holding it is what makes someone an admin, so it cannot be renamed or deleted.";

/**
 * The project's tags: the roles below `admin`. An admin creates, renames, and
 * deletes them; everyone else sees the same controls disabled. The reserved
 * `admin` tag is listed with a lock, and its controls say why they are locked.
 * @returns The section.
 */
export function TagsSection() {
  const { projectId, reason } = useProjectSettings();
  const { busy, error, notice, setError, setNotice, save } = useSectionSave();
  const [tags, setTags] = useState<ProjectTag[]>([]);
  const [newTagName, setNewTagName] = useState("");
  const [editing, setEditing] = useState<{ id: number; name: string } | null>(
    null,
  );
  const { loading, begin, done } = useFirstLoad();
  const createDenied = reason("tag:create");
  const editDenied = reason("tag:edit");
  const deleteDenied = reason("tag:delete");

  const load = useCallback(async () => {
    begin();
    try {
      const res = await apiFetch<ActionResponse<TagList>>(
        `/project/${projectId}/tags?limit=100`,
      );
      setTags(res.tags);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load tags.");
    } finally {
      done();
    }
  }, [projectId, setError, begin, done]);

  useEffect(() => {
    load();
  }, [load]);

  /** Create a tag. */
  async function onAdd() {
    const name = newTagName.trim();
    if (!name) return;
    const ok = await save(
      () =>
        apiFetch(`/project/${projectId}/tag`, {
          method: "PUT",
          body: JSON.stringify({ name }),
        }),
      `Added the ${name} tag.`,
    );
    if (!ok) return;
    setNewTagName("");
    await load();
  }

  /** Save the rename in progress. */
  async function onRename() {
    if (!editing) return;
    const name = editing.name.trim();
    const ok = await save(
      () =>
        apiFetch(`/project/${projectId}/tag/${editing.id}`, {
          method: "POST",
          body: JSON.stringify({ name }),
        }),
      `Renamed the tag to ${name}.`,
    );
    if (!ok) return;
    setEditing(null);
    await load();
  }

  /**
   * Delete a tag. The server refuses one an access list still names, and says
   * which — that message lands in this card.
   * @param tag - The tag to delete.
   */
  async function onDelete(tag: ProjectTag) {
    const ok = await save(
      () =>
        apiFetch(`/project/${projectId}/tag/${tag.id}`, { method: "DELETE" }),
      `Deleted the ${tag.name} tag.`,
    );
    if (ok) await load();
  }

  return (
    <SectionCard
      title="Tags"
      testId="tags"
      idPrefix="settings"
      cardTestId="tags-card"
      intro={
        <>
          Tags are the roles below admin: name them for the groups you have —{" "}
          <code>support</code>, <code>eng</code> — and grant them in Members.
          Holding the reserved <code>admin</code> tag is what makes someone an
          admin.
        </>
      }
      error={error}
      notice={notice}
      onDismissError={() => setError(null)}
      onDismissNotice={() => setNotice(null)}
    >
      <Table size="sm" responsive data-testid="tag-list">
        <thead>
          <tr>
            <th scope="col">Tag</th>
            <th scope="col" className="text-end">
              <span className="visually-hidden">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {loading && (
            <SkeletonRows
              columns={2}
              rows={2}
              testId="tags-skeleton"
              label="Loading tags"
            />
          )}
          {!loading &&
            tags.map((t) => {
              const locked = t.reserved ? RESERVED_TAG_REASON : undefined;
              const isEditing = editing?.id === t.id;
              return (
                <tr key={t.id} data-testid={`tag-row-${t.name}`}>
                  <td>
                    {isEditing ? (
                      <Form
                        className="d-flex gap-2"
                        onSubmit={(e) => {
                          e.preventDefault();
                          onRename();
                        }}
                      >
                        <Form.Label visuallyHidden htmlFor={`rename-${t.id}`}>
                          New name for {t.name}
                        </Form.Label>
                        <Form.Control
                          id={`rename-${t.id}`}
                          size="sm"
                          className="w-auto"
                          value={editing.name}
                          autoFocus
                          disabled={busy}
                          onChange={(e) =>
                            setEditing({ id: t.id, name: e.target.value })
                          }
                          data-testid={`rename-tag-input-${t.name}`}
                        />
                        <Button
                          size="sm"
                          type="submit"
                          variant="primary"
                          disabled={
                            busy ||
                            editing.name.trim() === "" ||
                            editing.name.trim() === t.name
                          }
                          data-testid={`rename-tag-save-${t.name}`}
                        >
                          Save
                        </Button>
                        <Button
                          size="sm"
                          variant="outline-secondary"
                          onClick={() => setEditing(null)}
                        >
                          Cancel
                        </Button>
                      </Form>
                    ) : (
                      <span className="tag-name">
                        {t.reserved && (
                          <Lock
                            size={12}
                            aria-label="Reserved"
                            data-testid="reserved-tag-lock"
                          />
                        )}
                        <span className="mono">{t.name}</span>
                        {t.reserved && (
                          <span className="text-meta">reserved</span>
                        )}
                      </span>
                    )}
                  </td>
                  <td className="text-end">
                    {!isEditing && (
                      <div className="d-inline-flex gap-2">
                        <GatedButton
                          size="sm"
                          variant="outline-secondary"
                          disabled={busy}
                          deniedReason={locked ?? editDenied}
                          data-testid={`rename-tag-${t.name}`}
                          onClick={() => setEditing({ id: t.id, name: t.name })}
                        >
                          Rename
                        </GatedButton>
                        <GatedButton
                          size="sm"
                          variant="outline-danger"
                          disabled={busy}
                          deniedReason={locked ?? deleteDenied}
                          aria-label={`Delete the ${t.name} tag`}
                          data-testid={`delete-tag-${t.name}`}
                          onClick={() => onDelete(t)}
                        >
                          Delete
                        </GatedButton>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
        </tbody>
      </Table>

      <Form
        className="d-flex gap-2 flex-wrap align-items-end"
        onSubmit={(e) => {
          e.preventDefault();
          onAdd();
        }}
      >
        <Form.Group controlId="new-tag-name" className="mb-0">
          <Form.Label>New tag</Form.Label>
          <Form.Control
            size="sm"
            placeholder="support"
            value={newTagName}
            disabled={busy || createDenied !== undefined}
            title={createDenied}
            onChange={(e) => setNewTagName(e.target.value)}
            data-testid="new-tag-name"
          />
        </Form.Group>
        <GatedButton
          size="sm"
          type="submit"
          variant="outline-primary"
          disabled={busy}
          deniedReason={createDenied}
          data-testid="new-tag-submit"
        >
          Add tag
        </GatedButton>
      </Form>
    </SectionCard>
  );
}
