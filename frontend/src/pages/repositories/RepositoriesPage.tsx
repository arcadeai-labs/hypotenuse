import { ExternalLink } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { type BotRow, useRead } from "../../components/bots/data";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { CopyButton } from "../../components/CopyButton";
import { GatedButton } from "../../components/GatedButton";
import { SkeletonRows } from "../../components/SkeletonRows";
import { SectionCard } from "../../components/sections/SectionCard";
import { PageHeader } from "../../components/shell/PageHeader";
import { useAuth } from "../../context/AuthContext";
import { useMay } from "../../hooks/useMay";
import { Alert, Badge, BotBadge, Button, Chip, Form, Table } from "../../ui";
import { apiFetch } from "../../utils/client";
import {
  BRANCH_PREFIX_PLACEHOLDER,
  EMPTY_GRANT_DRAFT,
  type GithubInstallation,
  type GrantDraft,
  grantAccessWords,
  grantBotsWords,
  grantCreateBody,
  grantDraftOf,
  grantEditBody,
  INSTALLATION_STATUS_TONE,
  type InstallUrl,
  installationStatusLabel,
  installNotice,
  type RepositoryGrant,
  repositoryUrl,
  rulesetJson,
} from "../../utils/repositories";

/** What the grant form is doing: adding a grant, or changing one. */
type FormMode = { kind: "create" } | { kind: "edit"; grant: RepositoryGrant };

/**
 * The attached GitHub App installations: the account each is on, its status,
 * and — for an admin — the way to detach it, which also deletes every grant
 * made through it.
 * @param props.projectId - The project.
 * @param props.installations - The installations, or `null` while loading.
 * @param props.error - Why the read failed.
 * @param props.denied - Why the reader may not detach, or `undefined`.
 * @param props.onDetached - Read the page again.
 * @returns The card.
 */
function InstallationsCard({
  projectId,
  installations,
  error,
  denied,
  onDetached,
}: {
  projectId: number;
  installations: GithubInstallation[] | null;
  error: string | null;
  denied: string | undefined;
  onDetached: (message: string) => Promise<void>;
}) {
  const [confirm, setConfirm] = useState<GithubInstallation | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  /** Detach the chosen installation. */
  async function onDetach() {
    if (!confirm) return;
    setBusy(true);
    setFailure(null);
    try {
      const res = await apiFetch<{ removedGrants: number }>(
        `/project/${projectId}/github/installation/${confirm.id}`,
        { method: "DELETE" },
      );
      const grants =
        res.removedGrants === 1
          ? "1 grant"
          : `${res.removedGrants ?? 0} grants`;
      setConfirm(null);
      await onDetached(
        `Detached ${confirm.accountLogin}, and revoked ${grants} made through it.`,
      );
    } catch (err) {
      setFailure(err instanceof Error ? err.message : "Could not detach it.");
      setConfirm(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <SectionCard
      title="GitHub App"
      testId="installations"
      idPrefix="repositories"
      intro={
        <>
          Bots reach GitHub through this deployment's GitHub App, installed on a
          GitHub organization or account and attached here. GitHub decides which
          of that account's repositories the App may see; a grant below decides
          which of those your bots may use.
        </>
      }
      error={failure ?? error}
      onDismissError={() => setFailure(null)}
    >
      <Table size="sm" responsive data-testid="installation-list">
        <thead>
          <tr>
            <th scope="col">Account</th>
            <th scope="col">Status</th>
            <th scope="col">Installation</th>
            <th scope="col">Attached</th>
            <th scope="col" className="text-end">
              <span className="visually-hidden">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {installations === null && !error && (
            <SkeletonRows
              rows={2}
              columns={5}
              testId="installations-skeleton"
            />
          )}
          {installations?.length === 0 && (
            <tr>
              <td
                colSpan={5}
                className="text-meta"
                data-testid="no-installations"
              >
                No installation is attached yet. An admin installs the GitHub
                App on your organization to start.
              </td>
            </tr>
          )}
          {installations?.map((i) => (
            <tr key={i.id} data-testid={`installation-row-${i.id}`}>
              <td>
                <span className="mono">{i.accountLogin}</span>{" "}
                <span className="text-meta">
                  {i.accountType === "Organization"
                    ? "organization"
                    : "personal account"}
                </span>
              </td>
              <td>
                <Badge
                  bg={INSTALLATION_STATUS_TONE[i.status] ?? "secondary"}
                  data-testid={`installation-status-${i.id}`}
                >
                  {installationStatusLabel(i.status)}
                </Badge>
              </td>
              <td className="tabular">#{i.id}</td>
              <td className="tabular">
                {new Date(i.createdAt).toLocaleDateString()}
              </td>
              <td className="text-end">
                <GatedButton
                  size="sm"
                  variant="outline-danger"
                  deniedReason={denied}
                  disabled={busy}
                  onClick={() => setConfirm(i)}
                  data-testid={`detach-installation-${i.id}`}
                >
                  Detach
                </GatedButton>
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
      <ConfirmDialog
        show={confirm !== null}
        title={`Detach ${confirm?.accountLogin ?? "this installation"}?`}
        confirmLabel="Detach"
        busy={busy}
        onConfirm={onDetach}
        onCancel={() => setConfirm(null)}
        testId="detach-installation"
      >
        Every repository grant made through it is revoked, and bots can no
        longer reach its repositories. The App stays installed on GitHub, where
        the account's owners remove it.
      </ConfirmDialog>
    </SectionCard>
  );
}

/**
 * Pick which bots a grant covers: every bot in the project, or some.
 * @param props.draft - The form.
 * @param props.bots - The project's bots.
 * @param props.locked - Whether the form is read-only.
 * @param props.onChange - Change the form.
 * @returns The picker.
 */
function BotPicker({
  draft,
  bots,
  locked,
  onChange,
}: {
  draft: GrantDraft;
  bots: BotRow[];
  locked: boolean;
  onChange: (patch: Partial<GrantDraft>) => void;
}) {
  return (
    <fieldset className="repositories-bots" data-testid="grant-bots">
      <legend className="ui-form-label">Which bots</legend>
      <Form.Check
        type="radio"
        id="grant-all-bots"
        name="grant-bots"
        label="Every bot in the project, including ones made later"
        checked={draft.allBots}
        disabled={locked}
        onChange={() => onChange({ allBots: true })}
        data-testid="grant-all-bots"
      />
      <Form.Check
        type="radio"
        id="grant-some-bots"
        name="grant-bots"
        label="Only these bots"
        checked={!draft.allBots}
        disabled={locked}
        onChange={() => onChange({ allBots: false })}
        data-testid="grant-some-bots"
      />
      {!draft.allBots && (
        <div className="repositories-bot-list">
          {bots.length === 0 && (
            <span className="text-meta">This project has no bots yet.</span>
          )}
          {bots.map((b) => (
            <Form.Check
              key={b.id}
              id={`grant-bot-${b.id}`}
              label={<BotBadge name={b.name} />}
              checked={draft.botIds.includes(b.id)}
              disabled={locked}
              onChange={(e) =>
                onChange({
                  botIds: e.target.checked
                    ? [...draft.botIds, b.id]
                    : draft.botIds.filter((id) => id !== b.id),
                })
              }
              data-testid={`grant-bot-${b.id}`}
            />
          ))}
        </div>
      )}
    </fieldset>
  );
}

/**
 * Grant a repository, or change a grant: the installation it is reached
 * through, `owner/name`, whether jobs may push, the branch prefix, and which
 * bots. After a save it shows the server's warnings — a push grant without a
 * prefix says why that matters.
 * @param props.projectId - The project.
 * @param props.mode - Adding, or changing which grant.
 * @param props.installations - The attached installations.
 * @param props.bots - The project's bots.
 * @param props.denied - Why the reader may not save, or `undefined`.
 * @param props.onSaved - Read the grants again, and leave edit mode.
 * @param props.onCancelEdit - Leave edit mode without saving.
 * @returns The card.
 */
function GrantForm({
  projectId,
  mode,
  installations,
  bots,
  denied,
  onSaved,
  onCancelEdit,
}: {
  projectId: number;
  mode: FormMode;
  installations: GithubInstallation[];
  bots: BotRow[];
  denied: string | undefined;
  onSaved: () => Promise<void>;
  onCancelEdit: () => void;
}) {
  const editing = mode.kind === "edit" ? mode.grant : null;
  const [draft, setDraft] = useState<GrantDraft>(() =>
    editing ? grantDraftOf(editing) : EMPTY_GRANT_DRAFT,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ text: string; warnings: string[] }>({
    text: "",
    warnings: [],
  });
  const usable = installations.filter((i) => i.status === "active");
  const locked = denied !== undefined || busy;

  /**
   * Change the form.
   * @param patch - The fields to change.
   */
  function onChange(patch: Partial<GrantDraft>) {
    setDraft((d) => ({ ...d, ...patch }));
    setSaved({ text: "", warnings: [] });
  }

  /** Create or change the grant. */
  async function onSubmit() {
    setError(null);
    const body = editing
      ? grantEditBody(editing, draft)
      : grantCreateBody(draft);
    if (typeof body === "string") {
      setError(body);
      return;
    }
    setBusy(true);
    try {
      const res = await apiFetch<{
        repositoryGrant: RepositoryGrant;
        warnings: string[];
      }>(
        editing
          ? `/project/${projectId}/repository-grant/${editing.id}`
          : `/project/${projectId}/repository-grant`,
        {
          method: editing ? "POST" : "PUT",
          body: JSON.stringify(body),
        },
      );
      setSaved({
        text: editing
          ? `Saved ${res.repositoryGrant.fullName}.`
          : `Granted ${res.repositoryGrant.fullName}.`,
        warnings: res.warnings,
      });
      if (!editing)
        setDraft({
          ...EMPTY_GRANT_DRAFT,
          installationId: draft.installationId,
        });
      await onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save it.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="repositories-form" data-testid="grant-form">
      <h3 className="repositories-form-title">
        {editing ? (
          <>
            Change <span className="mono">{editing.fullName}</span>
          </>
        ) : (
          "Grant a repository"
        )}
      </h3>
      {error && (
        <Alert
          variant="danger"
          dismissible
          onClose={() => setError(null)}
          data-testid="grant-error"
        >
          {error}
        </Alert>
      )}
      {saved.text && (
        <Alert variant="success" data-testid="grant-notice">
          {saved.text}
        </Alert>
      )}
      {saved.warnings.map((w) => (
        <Alert key={w} variant="warning" data-testid="grant-warning">
          {w}
        </Alert>
      ))}
      <div className="sandbox-fields">
        <Form.Group controlId="grant-installation" className="mb-0">
          <Form.Label>Installation</Form.Label>
          <Form.Select
            size="sm"
            className="settings-input"
            value={draft.installationId}
            disabled={locked || editing !== null}
            title={denied}
            onChange={(e) => onChange({ installationId: e.target.value })}
            data-testid="grant-installation"
          >
            <option value="">
              {usable.length === 0
                ? "No active installation"
                : "Choose an installation"}
            </option>
            {(editing ? installations : usable).map((i) => (
              <option key={i.id} value={String(i.id)}>
                {i.accountLogin} (#{i.id})
              </option>
            ))}
          </Form.Select>
        </Form.Group>
        <Form.Group controlId="grant-repository" className="mb-0">
          <Form.Label>Repository</Form.Label>
          <Form.Control
            size="sm"
            className="settings-input mono"
            placeholder="owner/name"
            value={draft.repository}
            disabled={locked || editing !== null}
            title={denied}
            onChange={(e) => onChange({ repository: e.target.value })}
            data-testid="grant-repository"
          />
          <Form.Text className="text-muted">
            Owned by the installation's account, and visible to the App on
            GitHub.
          </Form.Text>
        </Form.Group>
        <Form.Group controlId="grant-branch-prefix" className="mb-0">
          <Form.Label>Branch prefix</Form.Label>
          <Form.Control
            size="sm"
            className="settings-input mono"
            placeholder={BRANCH_PREFIX_PLACEHOLDER}
            value={draft.branchPrefix}
            disabled={locked}
            title={denied}
            onChange={(e) => onChange({ branchPrefix: e.target.value })}
            data-testid="grant-branch-prefix"
          />
          <Form.Text className="text-muted">
            Where jobs push their branches. Blank asks each bot to use its own,{" "}
            <span className="mono">{BRANCH_PREFIX_PLACEHOLDER}</span>.
          </Form.Text>
        </Form.Group>
        <div className="repositories-push">
          <Form.Check
            type="switch"
            id="grant-push"
            label="Jobs may push branches and open pull requests"
            checked={draft.push}
            disabled={locked}
            title={denied}
            onChange={(e) => onChange({ push: e.target.checked })}
            data-testid="grant-push"
          />
          <Form.Text className="text-muted">
            Off, bots may read and run the code but push nothing.
          </Form.Text>
        </div>
      </div>
      <BotPicker
        draft={draft}
        bots={bots}
        locked={locked}
        onChange={onChange}
      />
      <div className="d-flex gap-2 mt-3">
        <GatedButton
          variant="primary"
          deniedReason={denied}
          disabled={busy || (!editing && usable.length === 0)}
          onClick={onSubmit}
          data-testid="grant-submit"
        >
          {editing ? "Save" : "Grant"}
        </GatedButton>
        {editing && (
          <Button
            variant="secondary"
            disabled={busy}
            onClick={onCancelEdit}
            data-testid="grant-cancel-edit"
          >
            Done
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * The ruleset that keeps the App inside a grant's branch prefix, as JSON to
 * copy into GitHub, with the one sentence that says why it is needed.
 * @param props.grant - A grant with a branch prefix.
 * @returns The fold.
 */
function RulesetFold({ grant }: { grant: RepositoryGrant }) {
  const json = rulesetJson(grant);
  if (!json) return null;
  return (
    <details
      className="tx-fold repositories-ruleset"
      data-testid={`grant-ruleset-${grant.id}`}
    >
      <summary className="text-meta">
        Recommended ruleset for <span className="mono">{grant.fullName}</span>
      </summary>
      <p className="repositories-ruleset-why">
        A token with <code>contents: write</code> reaches every branch, so the
        prefix is only a request until a ruleset on GitHub enforces it. Add this
        under the repository's <strong>Settings → Rules → Rulesets</strong> (or{" "}
        <code>POST /repos/{grant.fullName}/rulesets</code>), with the App as the
        only actor it applies to.
      </p>
      <div className="repositories-ruleset-body">
        <CopyButton text={json} label="Copy the ruleset" />
        <pre className="json-block-body">{json}</pre>
      </div>
    </details>
  );
}

/**
 * `/repositories` — the project's GitHub repositories: the GitHub App
 * installations attached to it, and the repositories its bots are granted,
 * each read-only or with push, for every bot or some, with the branch prefix
 * jobs push into and the ruleset that enforces it. Every member reads it; an
 * admin installs, grants, changes, and revokes. Arriving from GitHub's
 * install flow, it says how that went.
 * @returns The page.
 */
export function RepositoriesPage() {
  const { activeProjectId, activeOrganizationId } = useAuth();
  const { reason } = useMay();
  const [search, setSearch] = useSearchParams();
  const arrival = installNotice(search);
  const [notice, setNotice] = useState<string | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  const [missing, setMissing] = useState<string[]>([]);
  const [installing, setInstalling] = useState(false);
  const [mode, setMode] = useState<FormMode>({ kind: "create" });
  const [revoke, setRevoke] = useState<RepositoryGrant | null>(null);
  const [revoking, setRevoking] = useState(false);
  const base = activeProjectId === null ? null : `/project/${activeProjectId}`;
  const installations = useRead<{ installations: GithubInstallation[] }>(
    base && `${base}/github/installations?limit=100`,
  );
  const grants = useRead<{ repositoryGrants: RepositoryGrant[] }>(
    base && `${base}/repository-grants?limit=100`,
  );
  const bots = useRead<{ bots: BotRow[] }>(base && `${base}/bots?limit=100`);
  const botNames = useMemo(
    () => new Map((bots.data?.bots ?? []).map((b) => [b.id, b.name])),
    [bots.data],
  );

  const installDenied = reason("github:install-url");
  const detachDenied = reason("github:installation-detach");
  const grantDenied = reason("repository-grant:create");
  const editDenied = reason("repository-grant:edit");
  const revokeDenied = reason("repository-grant:delete");

  /** Ask for the install link, then open it — or say what the operator must set. */
  async function onInstall() {
    if (!base) return;
    setInstalling(true);
    setInstallError(null);
    try {
      const res = await apiFetch<InstallUrl>(`${base}/github/install-url`);
      if (res.url) {
        window.location.assign(res.url);
        return;
      }
      setMissing(res.missing);
    } catch (err) {
      setInstallError(
        err instanceof Error ? err.message : "Could not start the install.",
      );
    } finally {
      setInstalling(false);
    }
  }

  /** Revoke the chosen grant. */
  async function onRevoke() {
    if (!base || !revoke) return;
    setRevoking(true);
    try {
      await apiFetch(`${base}/repository-grant/${revoke.id}`, {
        method: "DELETE",
      });
      setNotice(`Revoked ${revoke.fullName}.`);
      if (mode.kind === "edit" && mode.grant.id === revoke.id) {
        setMode({ kind: "create" });
      }
      await grants.reload();
    } catch (err) {
      setInstallError(
        err instanceof Error ? err.message : "Could not revoke it.",
      );
    } finally {
      setRevoke(null);
      setRevoking(false);
    }
  }

  /** Clear the notice GitHub's install flow left in the address. */
  function dismissArrival() {
    const next = new URLSearchParams(search);
    next.delete("installed");
    next.delete("error");
    setSearch(next, { replace: true });
  }

  const header = (
    <PageHeader
      title="Repositories"
      actions={
        activeProjectId !== null && (
          <GatedButton
            size="sm"
            variant="primary"
            deniedReason={installDenied}
            disabled={installing}
            onClick={onInstall}
            data-testid="install-github-app"
          >
            Install the GitHub App
          </GatedButton>
        )
      }
    />
  );

  if (activeProjectId === null) {
    return (
      <div className="page" data-testid="repositories-page">
        {header}
        <Alert variant="info" data-testid="no-project">
          {activeOrganizationId ? (
            <>
              This organization shows you no projects yet. See the{" "}
              <Link to="/organization/projects">organization's projects</Link>.
            </>
          ) : (
            "Choose an organization, then a project, to see its repositories."
          )}
        </Alert>
      </div>
    );
  }

  const grantList = grants.data?.repositoryGrants ?? null;
  const installationStatus = new Map(
    (installations.data?.installations ?? []).map((i) => [i.id, i.status]),
  );
  /**
   * Why a grant cannot be used now: its installation's status, when not active.
   * @param g - The grant.
   * @returns `suspended` or `removed`, or `null` while it is usable (or unknown).
   */
  const unusable = (g: RepositoryGrant): string | null => {
    const status = installationStatus.get(g.githubInstallationId);
    return status && status !== "active" ? status : null;
  };
  const withRuleset = (grantList ?? []).filter((g) => g.recommendedRuleset);

  return (
    <div className="page" data-testid="repositories-page">
      {header}
      {arrival && (
        <Alert
          variant={arrival.tone}
          dismissible
          onClose={dismissArrival}
          data-testid="install-notice"
        >
          {arrival.text}
        </Alert>
      )}
      {notice && (
        <Alert
          variant="success"
          dismissible
          onClose={() => setNotice(null)}
          data-testid="repositories-notice"
        >
          {notice}
        </Alert>
      )}
      {installError && (
        <Alert
          variant="danger"
          dismissible
          onClose={() => setInstallError(null)}
          data-testid="repositories-error"
        >
          {installError}
        </Alert>
      )}
      {missing.length > 0 && (
        <Alert
          variant="warning"
          dismissible
          onClose={() => setMissing([])}
          data-testid="github-app-missing"
        >
          This deployment's GitHub App is not configured yet. Whoever runs
          Hypotenuse sets{" "}
          {missing.map((m, i) => (
            <span key={m}>
              {i > 0 && (i === missing.length - 1 ? " and " : ", ")}
              <code>{m}</code>
            </span>
          ))}
          , then the App can be installed here.
        </Alert>
      )}
      {grantDenied && (
        <Alert variant="info" data-testid="repositories-read-only">
          Only project admins install the App and grant repositories. You can
          see what is granted.
        </Alert>
      )}
      <InstallationsCard
        projectId={activeProjectId}
        installations={installations.data?.installations ?? null}
        error={installations.error}
        denied={detachDenied}
        onDetached={async (message) => {
          setNotice(message);
          setMode({ kind: "create" });
          await Promise.all([installations.reload(), grants.reload()]);
        }}
      />
      <SectionCard
        title="Granted repositories"
        testId="grants"
        idPrefix="repositories"
        intro={
          <>
            A grant lets bots read a repository — its files, code search, pull
            requests, and issues, and a checkout in a{" "}
            <Link to="/docs/sandboxes">sandbox</Link> — and, with push, push a
            branch and open a pull request. See{" "}
            <Link to="/docs/repositories">Repositories</Link> in the docs.
          </>
        }
        error={grants.error}
      >
        <Table size="sm" responsive data-testid="grant-list">
          <thead>
            <tr>
              <th scope="col">Repository</th>
              <th scope="col">Access</th>
              <th scope="col">Branch prefix</th>
              <th scope="col">Bots</th>
              <th scope="col" className="text-end">
                <span className="visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {grantList === null && !grants.error && (
              <SkeletonRows rows={2} columns={5} testId="grants-skeleton" />
            )}
            {grantList?.length === 0 && (
              <tr>
                <td colSpan={5} className="text-meta" data-testid="no-grants">
                  No repository is granted yet.
                </td>
              </tr>
            )}
            {grantList?.map((g) => (
              <tr
                key={g.id}
                data-testid={`grant-row-${g.id}`}
                data-editing={
                  mode.kind === "edit" && mode.grant.id === g.id
                    ? "true"
                    : undefined
                }
              >
                <td>
                  <a
                    href={repositoryUrl(g.fullName, g.host)}
                    target="_blank"
                    rel="noreferrer"
                    className="mono repositories-repo"
                  >
                    {g.fullName}
                    <ExternalLink size={12} aria-hidden="true" />
                  </a>
                  {unusable(g) && (
                    <span
                      className="repositories-unusable"
                      data-testid={`grant-unusable-${g.id}`}
                    >
                      Unusable while its installation is{" "}
                      {unusable(g) === "removed"
                        ? "removed from GitHub"
                        : "suspended on GitHub"}
                    </span>
                  )}
                </td>
                <td>
                  <Chip
                    tone={g.push ? "accent" : "subtle"}
                    data-testid={`grant-access-${g.id}`}
                  >
                    {grantAccessWords(g.push)}
                  </Chip>
                </td>
                <td>
                  {g.branchPrefix ? (
                    <span className="mono">{g.branchPrefix}</span>
                  ) : (
                    <span
                      className="text-meta"
                      title={`Each bot is asked to use ${BRANCH_PREFIX_PLACEHOLDER}`}
                    >
                      Per bot
                    </span>
                  )}
                </td>
                <td data-testid={`grant-bots-${g.id}`}>
                  {grantBotsWords(g, botNames)}
                </td>
                <td className="text-end">
                  <div className="d-inline-flex gap-2">
                    <GatedButton
                      size="sm"
                      variant="secondary"
                      deniedReason={editDenied}
                      onClick={() => setMode({ kind: "edit", grant: g })}
                      data-testid={`edit-grant-${g.id}`}
                    >
                      Edit
                    </GatedButton>
                    <GatedButton
                      size="sm"
                      variant="outline-danger"
                      deniedReason={revokeDenied}
                      onClick={() => setRevoke(g)}
                      data-testid={`revoke-grant-${g.id}`}
                    >
                      Revoke
                    </GatedButton>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
        {withRuleset.length > 0 && (
          <div className="repositories-rulesets" data-testid="grant-rulesets">
            {withRuleset.map((g) => (
              <RulesetFold key={g.id} grant={g} />
            ))}
          </div>
        )}
        <GrantForm
          key={mode.kind === "edit" ? `edit-${mode.grant.id}` : "create"}
          projectId={activeProjectId}
          mode={mode}
          installations={installations.data?.installations ?? []}
          bots={bots.data?.bots ?? []}
          denied={mode.kind === "edit" ? editDenied : grantDenied}
          onSaved={grants.reload}
          onCancelEdit={() => setMode({ kind: "create" })}
        />
      </SectionCard>
      <ConfirmDialog
        show={revoke !== null}
        title={`Revoke ${revoke?.fullName ?? "this grant"}?`}
        confirmLabel="Revoke"
        busy={revoking}
        onConfirm={onRevoke}
        onCancel={() => setRevoke(null)}
        testId="revoke-grant"
      >
        Bots can no longer read it or start jobs on it. A job already running on
        it keeps the checkout it has, and its next git command is refused.
      </ConfirmDialog>
    </div>
  );
}
