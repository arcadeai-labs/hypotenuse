import { useCallback, useEffect, useState } from "react";
import { Alert, Form } from "../../../ui";
import { apiFetch } from "../../../utils/client";
import {
  durationWords,
  parseSandboxSettings,
  type SandboxSettingsDraft,
  sandboxDraftOf,
} from "../../../utils/sandboxJobs";
import {
  type ConnectionKindInfo,
  canHoldAllowlist,
  maskedToken,
  memoryFor,
  memoryWords,
  type ProjectConnection,
  type ProjectSettingsAnswer,
  providerFor,
  providerOptionLabel,
  type SandboxProviderInfo,
} from "../../../utils/sandboxProviders";
import { useRead } from "../../bots/data";
import { SandboxConnectionCard } from "../../sandboxes/SandboxConnectionCard";
import { SandboxLedgerCard } from "../../sandboxes/SandboxLedgerCard";
import { SectionCard } from "../../sections/SectionCard";
import { useSectionSave } from "../../sections/useSectionSave";
import { useProjectSettings } from "../context";

/** The form before the settings arrive. */
const BLANK_DRAFT: SandboxSettingsDraft = {
  provider: "",
  image: "",
  runtime: "",
  vcpus: "",
  egressMode: "",
  concurrency: "",
  maxMinutes: "",
};

/**
 * Settings → Sandboxes: where the project's sandbox jobs run and under what
 * limits, the account a provider on the project's own account runs on, and
 * the ledger of sandboxes that may still be running. Every member reads all
 * of it; an admin changes it.
 * @returns The section.
 */
export function SandboxesSection() {
  const { projectId, reason } = useProjectSettings();
  const read = useRead<ProjectSettingsAnswer>(`/project/${projectId}/settings`);
  const connectionsRead = useRead<{ connections: ProjectConnection[] }>(
    `/project/${projectId}/connections?limit=100`,
  );
  const [chosen, setChosen] = useState<string | null>(null);
  const providers = read.data?.providers ?? [];
  const kinds = read.data?.connectionKinds ?? [];
  const connections = connectionsRead.data?.connections ?? null;
  const settings = read.data?.settings ?? null;
  const provider = providerFor(
    providers,
    chosen ?? settings?.sandboxProvider ?? "",
    read.data?.defaultProvider ?? null,
  );

  // A connection card for the kind the chosen provider runs on, and for any
  // kind the project already holds, so a connection left behind can be
  // deleted.
  const shownKinds = kinds.filter(
    (k) =>
      provider?.connectionKind === k.kind ||
      connections?.some((c) => c.kind === k.kind),
  );

  const { reload: reloadSettings } = read;
  const { reload: reloadConnections } = connectionsRead;
  const reloadAll = useCallback(async () => {
    await Promise.all([reloadConnections(), reloadSettings()]);
  }, [reloadConnections, reloadSettings]);

  return (
    <div data-testid="settings-sandboxes">
      <SandboxSettingsCard
        projectId={projectId}
        answer={read.data}
        loadError={read.error}
        reload={read.reload}
        connections={connections}
        kinds={kinds}
        provider={provider}
        providers={providers}
        onProviderChange={setChosen}
        denied={reason("project:settings-edit")}
      />
      {connections !== null &&
        shownKinds.map((kind) => (
          <SandboxConnectionCard
            key={kind.kind}
            projectId={projectId}
            kind={kind}
            connection={connections.find((c) => c.kind === kind.kind) ?? null}
            reload={reloadAll}
            reason={reason}
          />
        ))}
      {connectionsRead.error && (
        <Alert variant="danger" data-testid="sandbox-connections-error">
          {connectionsRead.error}
        </Alert>
      )}
      <SandboxLedgerCard projectId={projectId} reason={reason} />
    </div>
  );
}

/** See {@link SandboxSettingsCard}. */
interface SandboxSettingsCardProps {
  projectId: number;
  /** `project:settings-view`'s answer, or `null` before it. */
  answer: ProjectSettingsAnswer | null;
  loadError: string | null;
  reload: () => Promise<void>;
  /** The project's connections, or `null` before they are read. */
  connections: ProjectConnection[] | null;
  kinds: ConnectionKindInfo[];
  /** The provider the form describes, or `null` when it is not known here. */
  provider: SandboxProviderInfo | null;
  providers: SandboxProviderInfo[];
  /** Tell the section which provider the menu shows, so its connection card follows. */
  onProviderChange: (kind: string) => void;
  /** Why the caller may not save, or `undefined`. */
  denied: string | undefined;
}

/**
 * The provider, the options that provider takes, how egress is held, and the
 * limits — with the settings in effect beneath. A blank field is the
 * deployment's default. What a save leaves a bot unable to do comes back as
 * warnings, shown until the next change.
 * @param props - See {@link SandboxSettingsCardProps}.
 * @returns The card.
 */
function SandboxSettingsCard({
  projectId,
  answer,
  loadError,
  reload,
  connections,
  kinds,
  provider,
  providers,
  onProviderChange,
  denied,
}: SandboxSettingsCardProps) {
  const settings = answer?.settings ?? null;
  const { busy, error, notice, setError, setNotice, save } = useSectionSave();
  const [draft, setDraft] = useState<SandboxSettingsDraft>(BLANK_DRAFT);
  const [warnings, setWarnings] = useState<string[]>([]);
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
  const runtimes = provider?.options.runtimes ?? null;
  const vcpuRange = provider?.options.vcpus ?? null;
  const allowlistable = canHoldAllowlist(provider);
  const egressShown = allowlistable
    ? draft.egressMode || "open-world"
    : "open-world";
  const vcpusShown =
    Number(draft.vcpus.trim()) ||
    (effective?.provider === provider?.kind ? effective?.vcpus : null) ||
    vcpuRange?.min ||
    0;
  const memory = memoryFor(provider, vcpusShown);
  const kind = provider?.connectionKind
    ? (kinds.find((k) => k.kind === provider.connectionKind) ?? null)
    : null;
  const connection =
    kind && connections
      ? (connections.find((c) => c.kind === kind.kind) ?? null)
      : null;

  /** Save every field; a blank one returns to the deployment's default. */
  async function onSave() {
    const fields = parseSandboxSettings(draft, provider);
    if (typeof fields === "string") {
      setError(fields);
      return;
    }
    let answered: string[] = [];
    const ok = await save(async () => {
      const res = await apiFetch<{ warnings: string[] }>(
        `/project/${projectId}/settings`,
        { method: "POST", body: JSON.stringify(fields) },
      );
      answered = res.warnings ?? [];
    }, "Saved.");
    setWarnings(ok ? answered : []);
    if (ok) await reload();
  }

  /**
   * Change one field.
   * @param key - Which.
   * @param value - Its text.
   */
  function set(key: keyof SandboxSettingsDraft, value: string) {
    setDraft((d) => ({ ...d, [key]: value }));
    setNotice(null);
    setWarnings([]);
    if (key === "provider") onProviderChange(value);
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
      loading={answer === null && !loadError}
      error={error ?? loadError}
      notice={notice}
      onDismissError={() => setError(null)}
      onDismissNotice={() => setNotice(null)}
      onSave={onSave}
      canSave={changed}
      saveDeniedReason={denied}
      busy={busy}
    >
      {warnings.length > 0 && (
        <Alert variant="warning" data-testid="sandbox-warnings">
          <ul className="sandbox-warnings">
            {warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </Alert>
      )}
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
              <option
                key={p.kind}
                value={p.kind}
                disabled={!p.allowedHere && p.kind !== saved?.provider}
                data-testid={`sandbox-provider-${p.kind}`}
              >
                {providerOptionLabel(p)}
              </option>
            ))}
            {draft.provider &&
              !providers.some((p) => p.kind === draft.provider) && (
                <option value={draft.provider}>{draft.provider}</option>
              )}
          </Form.Select>
          <Form.Text
            className="text-muted"
            data-testid="sandbox-provider-about"
          >
            {provider
              ? provider.description
              : "The deployment's default provider."}
            {provider?.connectionKind && kind && (
              <>
                {" "}
                {connection ? (
                  <>
                    Runs on the project's {kind.label} connection (
                    <span className="mono">
                      {maskedToken(connection.lastFour)}
                    </span>
                    ).
                  </>
                ) : (
                  <>Connect a {kind.label} account below before saving.</>
                )}
              </>
            )}
          </Form.Text>
        </Form.Group>

        {provider?.options.image && (
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
        )}

        {runtimes && (
          <Form.Group controlId="sandbox-runtime" className="mb-0">
            <Form.Label>Runtime</Form.Label>
            <Form.Select
              size="sm"
              className="settings-input mono"
              value={draft.runtime}
              disabled={busy || locked}
              title={denied}
              onChange={(e) => set("runtime", e.target.value)}
              data-testid="sandbox-runtime"
            >
              <option value="">Default ({runtimes.default})</option>
              {runtimes.values.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </Form.Select>
            <Form.Text className="text-muted">
              The stock image a sandbox boots; the coding agent is installed on
              it.
            </Form.Text>
          </Form.Group>
        )}

        {vcpuRange && (
          <Form.Group controlId="sandbox-vcpus" className="mb-0">
            <Form.Label>vCPUs per sandbox</Form.Label>
            <Form.Control
              size="sm"
              type="number"
              min={vcpuRange.min}
              max={vcpuRange.max}
              step={1}
              className="settings-input tabular"
              placeholder={String(
                (effective?.provider === provider?.kind
                  ? effective?.vcpus
                  : null) ?? vcpuRange.default,
              )}
              value={draft.vcpus}
              disabled={busy || locked}
              title={denied}
              onChange={(e) => set("vcpus", e.target.value)}
              data-testid="sandbox-vcpus"
            />
            <Form.Text className="text-muted" data-testid="sandbox-memory">
              {vcpuRange.min}–{vcpuRange.max}, with{" "}
              {memoryWords(vcpuRange.mibPerVcpu)} of memory each
              {memory !== null && (
                <>
                  : <span className="tabular">{memoryWords(memory)}</span> for{" "}
                  {vcpusShown}
                </>
              )}
              .
            </Form.Text>
          </Form.Group>
        )}

        {!provider && (
          <Form.Text className="text-muted">
            Choose a provider to set the options it takes.
          </Form.Text>
        )}

        <Form.Group controlId="sandbox-egress" className="mb-0">
          <Form.Label>Network egress</Form.Label>
          <Form.Select
            size="sm"
            className="settings-input"
            value={egressShown}
            disabled={busy || locked || !allowlistable}
            title={
              denied ??
              (allowlistable
                ? undefined
                : `${provider?.label ?? "This provider"} cannot enforce an egress allowlist.`)
            }
            onChange={(e) => set("egressMode", e.target.value)}
            data-testid="sandbox-egress"
          >
            <option value="open-world">
              Open — the agent reaches the internet
            </option>
            <option value="allowlist">
              Allowlist — only what the job needs
            </option>
          </Form.Select>
          <Form.Text className="text-muted" data-testid="sandbox-egress-about">
            {!allowlistable
              ? `${provider?.label ?? "This provider"} cannot enforce an egress allowlist, so its sandboxes stay open. A bot that requires an allowlist cannot start jobs on it.`
              : egressShown === "allowlist"
                ? "Before the agent starts, its sandbox can reach only this API — which carries its models and MCP tools — and, for a repository job, GitHub. Package registries are open only while the sandbox installs its tools."
                : "The agent may reach any host. A repository job is still narrowed to this API and GitHub, since the provider can enforce it."}
          </Form.Text>
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
          <Form.Text className="text-muted">
            Can only lower the deployment's ceiling.
          </Form.Text>
        </Form.Group>
      </div>
      {denied && <Form.Text className="text-muted">{denied}</Form.Text>}
      {effective && (
        <dl className="settings-facts" data-testid="sandbox-effective">
          <dt>Runs on</dt>
          <dd data-testid="sandbox-effective-provider">
            {providers.find((p) => p.kind === effective.provider)?.label ??
              effective.provider}
          </dd>
          {effective.image && (
            <>
              <dt>Image</dt>
              <dd className="mono">{effective.image}</dd>
            </>
          )}
          {effective.runtime && (
            <>
              <dt>Runtime</dt>
              <dd className="mono" data-testid="sandbox-effective-runtime">
                {effective.runtime}
              </dd>
            </>
          )}
          {effective.vcpus !== null && (
            <>
              <dt>Size</dt>
              <dd className="tabular" data-testid="sandbox-effective-size">
                {effective.vcpus} vCPU{effective.vcpus === 1 ? "" : "s"}
                {effective.memoryMiB !== null &&
                  ` · ${memoryWords(effective.memoryMiB)}`}
              </dd>
            </>
          )}
          <dt>Egress</dt>
          <dd data-testid="sandbox-effective-egress">
            {effective.egressMode === "allowlist" ? "Allowlist" : "Open"}
          </dd>
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
