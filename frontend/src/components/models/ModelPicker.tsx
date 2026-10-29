import type { ModelConnectionModels } from "@backend/actions/model-connection/model-connection-models";
import type { ActionResponse } from "keryx";
import { useEffect, useId, useState } from "react";
import { Form } from "../../ui";
import { apiFetch } from "../../utils/client";

/** One model a provider reported. */
type ListedModel = ActionResponse<ModelConnectionModels>["models"][number];

/** What asking the provider came to. */
type Listing =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "listed"; models: ListedModel[] }
  | { state: "unlisted"; message: string };

/** See {@link ModelPicker}. */
export interface ModelPickerProps {
  projectId: number;
  /** The connection to ask, or `null` before one is chosen. */
  connectionId: number | null;
  /** The model id typed or chosen. */
  value: string;
  onChange: (modelId: string) => void;
  disabled?: boolean;
  /** Whether the caller may ask the provider (`model-connection:models`). */
  canList: boolean;
  /** The input's id, for its label. */
  id: string;
  testId: string;
}

/**
 * A model id field fed by the provider's own list.
 *
 * It is always a text field, with the provider's models offered as
 * suggestions: a provider that lists gives a person something to pick from,
 * one that does not (`model-connection:models` refuses, saying to type the id)
 * leaves the same field to type in, and an id the list does not yet know —
 * a model released this morning — can still be typed. Asking spends the
 * project's key, so it is asked once per connection chosen.
 * @param props - See {@link ModelPickerProps}.
 * @returns The field and a line saying where its suggestions came from.
 */
export function ModelPicker({
  projectId,
  connectionId,
  value,
  onChange,
  disabled,
  canList,
  id,
  testId,
}: ModelPickerProps) {
  const [listing, setListing] = useState<Listing>({ state: "idle" });
  const listId = useId();

  useEffect(() => {
    if (connectionId === null || !canList) {
      setListing({ state: "idle" });
      return;
    }
    let current = true;
    setListing({ state: "loading" });
    apiFetch<ActionResponse<ModelConnectionModels>>(
      `/project/${projectId}/model-connection/${connectionId}/models`,
    )
      .then((res) => {
        if (current) setListing({ state: "listed", models: res.models });
      })
      .catch((err: unknown) => {
        if (current)
          setListing({
            state: "unlisted",
            message:
              err instanceof Error
                ? err.message
                : "The provider did not list its models. Type the model id instead.",
          });
      });
    return () => {
      current = false;
    };
  }, [projectId, connectionId, canList]);

  return (
    <>
      <Form.Control
        id={id}
        size="sm"
        placeholder="claude-sonnet-4-5"
        value={value}
        disabled={disabled}
        list={listing.state === "listed" ? listId : undefined}
        autoComplete="off"
        onChange={(e) => onChange(e.target.value)}
        data-testid={testId}
      />
      {listing.state === "listed" && (
        <datalist id={listId}>
          {listing.models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name ?? m.id}
            </option>
          ))}
        </datalist>
      )}
      <Form.Text className="text-meta" data-testid={`${testId}-hint`}>
        {listing.state === "loading" && "Asking the provider for its models…"}
        {listing.state === "listed" &&
          (listing.models.length === 0
            ? "The provider listed no models. Type the model id."
            : `${listing.models.length} models from the provider; type to filter, or type any id.`)}
        {listing.state === "unlisted" && listing.message}
        {listing.state === "idle" && "The provider's model id."}
      </Form.Text>
    </>
  );
}
