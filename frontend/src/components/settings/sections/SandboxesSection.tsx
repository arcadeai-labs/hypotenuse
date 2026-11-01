import { useEffect, useState } from "react";
import { Form } from "../../../ui";
import { apiFetch } from "../../../utils/client";
import {
  durationWords,
  type ProjectSettings,
  parseSandboxSettings,
  type SandboxSettingsDraft,
  sandboxDraftOf,
} from "../../../utils/sandboxJobs";
import { useRead } from "../../bots/data";
import { SectionCard } from "../../sections/SectionCard";
import { useSectionSave } from "../../sections/useSectionSave";
import { useProjectSettings } from "../context";

/** The sandbox providers this build knows, and what each is for. */
const PROVIDERS = [
  { value: "docker", label: "Docker — development only" },
] as const;

/**
 * Where the project's sandbox jobs run and under what limits: the provider,
 * the image, how many run at once, and the longest one may run. Every member
 * reads it, with the values in effect; an admin changes it. A blank field is
 * the deployment's default.
 * @returns The section.
 */
export function SandboxesSection() {
  const { projectId, reason } = useProjectSettings();
  const denied = reason("project:settings-edit");
  const read = useRead<{ settings: ProjectSettings }>(
    `/project/${projectId}/settings`,
  );
  const settings = read.data?.settings ?? null;
  const { busy, error, notice, setError, setNotice, save } = useSectionSave();
  const [draft, setDraft] = useState<SandboxSettingsDraft>({
    provider: "",
    image: "",
    concurrency: "",
    maxMinutes: "",
  });
  const locked = denied !== undefined;

  useEffect(() => {
    if (settings) setDraft(sandboxDraftOf(settings));
  }, [settings]);

  const saved = settings ? sandboxDraftOf(settings) : null;
  const changed =
    saved !== null &&
    (Object.keys(draft) as (keyof SandboxSettingsDraft)[]).some(
      (key) => draft[key].trim() !== saved[key],
    );
  const effective = settings?.effectiveSandbox;
  const providers = PROVIDERS.some((p) => p.value === draft.provider)
    ? PROVIDERS
    : draft.provider
      ? [...PROVIDERS, { value: draft.provider, label: draft.provider }]
      : PROVIDERS;

  /** Save every field; a blank one returns to the deployment's default. */
  async function onSave() {
    const fields = parseSandboxSettings(draft);
    if (typeof fields === "string") {
      setError(fields);
      return;
    }
    const ok = await save(
      () =>
        apiFetch(`/project/${projectId}/settings`, {
          method: "POST",
          body: JSON.stringify(fields),
        }),
      "Saved.",
    );
    if (ok) await read.reload();
  }

  /**
   * Change one field.
   * @param key - Which.
   * @param value - Its text.
   */
  function set(key: keyof SandboxSettingsDraft, value: string) {
    setDraft((d) => ({ ...d, [key]: value }));
    setNotice(null);
  }

  return (
    <SectionCard
      title="Sandboxes"
      testId="sandboxes"
      idPrefix="settings"
      intro={
        <>
          When a bot hands code work to a coding agent, the agent runs in an
          ephemeral sandbox that holds one credential — its job's token — and is
          destroyed when the job ends. Leave a field blank for the deployment's
          default.
        </>
      }
      loading={read.data === null && !read.error}
      error={error ?? read.error}
      notice={notice}
      onDismissError={() => setError(null)}
      onDismissNotice={() => setNotice(null)}
      onSave={onSave}
      canSave={changed}
      saveDeniedReason={denied}
      busy={busy}
    >
      <div className="sandbox-fields">
        <Form.Group controlId="sandbox-provider" className="mb-0">
          <Form.Label>Provider</Form.Label>
          <Form.Select
            size="sm"
            className="settings-input"
            value={draft.provider}
            disabled={busy || locked}
            title={denied}
            onChange={(e) => set("provider", e.target.value)}
            data-testid="sandbox-provider"
          >
            <option value="">The deployment's default</option>
            {providers.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </Form.Select>
        </Form.Group>
        <Form.Group controlId="sandbox-image" className="mb-0">
          <Form.Label>Image</Form.Label>
          <Form.Control
            size="sm"
            className="settings-input mono"
            placeholder="The provider's own"
            value={draft.image}
            disabled={busy || locked}
            title={denied}
            onChange={(e) => set("image", e.target.value)}
            data-testid="sandbox-image"
          />
        </Form.Group>
        <Form.Group controlId="sandbox-concurrency" className="mb-0">
          <Form.Label>Jobs at once</Form.Label>
          <Form.Control
            size="sm"
            type="number"
            min={1}
            max={50}
            step={1}
            className="settings-input tabular"
            placeholder={effective ? String(effective.concurrency) : ""}
            value={draft.concurrency}
            disabled={busy || locked}
            title={denied}
            onChange={(e) => set("concurrency", e.target.value)}
            data-testid="sandbox-concurrency"
          />
        </Form.Group>
        <Form.Group controlId="sandbox-max-minutes" className="mb-0">
          <Form.Label>Longest a job may run (min)</Form.Label>
          <Form.Control
            size="sm"
            type="number"
            min={1}
            step={1}
            className="settings-input tabular"
            placeholder={
              effective
                ? String(Math.round(effective.maxDurationMs / 60_000))
                : ""
            }
            value={draft.maxMinutes}
            disabled={busy || locked}
            title={denied}
            onChange={(e) => set("maxMinutes", e.target.value)}
            data-testid="sandbox-max-minutes"
          />
        </Form.Group>
      </div>
      <Form.Text className="text-muted">
        {denied ??
          "Docker runs jobs on the server's own Docker and is for development only; production refuses it. A duration can only lower the deployment's ceiling."}
      </Form.Text>
      {effective && (
        <dl className="settings-facts" data-testid="sandbox-effective">
          <dt>Runs on</dt>
          <dd data-testid="sandbox-effective-provider">
            {effective.provider}
            {effective.provider === "docker" && (
              <span className="text-meta"> (development only)</span>
            )}
          </dd>
          <dt>Image</dt>
          <dd className="mono">{effective.image ?? "The provider's own"}</dd>
          <dt>Jobs at once</dt>
          <dd className="tabular" data-testid="sandbox-effective-concurrency">
            {effective.concurrency}
          </dd>
          <dt>Longest run</dt>
          <dd className="tabular" data-testid="sandbox-effective-duration">
            {durationWords(effective.maxDurationMs)}
          </dd>
        </dl>
      )}
    </SectionCard>
  );
}
