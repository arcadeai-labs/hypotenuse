import { useState } from "react";
import { Link } from "react-router-dom";
import { Chip, Form, Pagination, Table } from "../../ui";
import { apiFetch } from "../../utils/client";
import { jobStatusLabel } from "../../utils/sandboxJobs";
import {
  isLiveSandbox,
  type LedgerSandbox,
  resourceWords,
  sandboxStatusLabel,
} from "../../utils/sandboxProviders";
import { useRead } from "../bots/data";
import { ConfirmDialog } from "../ConfirmDialog";
import { GatedButton } from "../GatedButton";
import { SkeletonRows } from "../SkeletonRows";
import { SectionCard } from "../sections/SectionCard";
import { useSectionSave } from "../sections/useSectionSave";
import { relativeTime } from "../shell/NotificationBell";

/** Why a sandbox whose job is still alive is not destroyed from the ledger. */
const JOB_STILL_RUNS =
  "Its job is still running: cancel the job instead, so the conversation hears that it ended.";

/** See {@link SandboxLedgerCard}. */
export interface SandboxLedgerCardProps {
  projectId: number;
  /** `useMay().reason`, for the admin-only destroy. */
  reason: (actionName: string) => string | undefined;
}

/**
 * The sandbox ledger: every sandbox the project asked a provider for, newest
 * first — live ones by default, every one with the switch — each with the
 * job it ran (linked), its provider and provider-side id, what it was given,
 * and when. An admin destroys a live sandbox whose job has ended; one whose
 * job still runs is the job's to end, and the server says so.
 * @param props - See {@link SandboxLedgerCardProps}.
 * @returns The card.
 */
export function SandboxLedgerCard({
  projectId,
  reason,
}: SandboxLedgerCardProps) {
  const { busy, error, notice, setError, setNotice, save } = useSectionSave();
  const [showAll, setShowAll] = useState(false);
  const [page, setPage] = useState(1);
  const [destroying, setDestroying] = useState<LedgerSandbox | null>(null);
  const list = useRead<{
    sandboxes: LedgerSandbox[];
    pagination: { total: number; pages: number };
  }>(
    `/project/${projectId}/sandboxes?limit=25&page=${page}${showAll ? "" : "&live=true"}`,
  );
  const destroyDenied = reason("sandbox-ledger:destroy");
  const rows = list.data?.sandboxes ?? null;
  const pages = list.data?.pagination.pages ?? 0;

  /** Destroy the sandbox under confirmation, then read the ledger again. */
  async function onDestroy() {
    const target = destroying;
    if (!target) return;
    setDestroying(null);
    const ok = await save(
      () =>
        apiFetch(`/project/${projectId}/sandbox/${target.id}`, {
          method: "DELETE",
        }),
      `Destroyed sandbox ${target.id}.`,
    );
    if (ok) await list.reload();
  }

  return (
    <SectionCard
      title={showAll ? "Every sandbox" : "Live sandboxes"}
      testId="sandbox-ledger"
      idPrefix="settings"
      intro={
        <>
          Every sandbox Hypotenuse asks a provider for is written here before it
          is created, and marked when it is destroyed — so what may still be
          running, and costing, is never a guess. A sandbox ends with its job;
          one left behind is collected by a sweep, or destroyed here.
        </>
      }
      error={error ?? list.error}
      notice={notice}
      onDismissError={() => setError(null)}
      onDismissNotice={() => setNotice(null)}
    >
      <Form.Check
        type="switch"
        id="sandbox-ledger-all"
        label="Show destroyed and failed sandboxes too"
        checked={showAll}
        onChange={(e) => {
          setShowAll(e.target.checked);
          setPage(1);
          setNotice(null);
        }}
        data-testid="sandbox-ledger-all"
      />
      <Table size="sm" responsive data-testid="sandbox-ledger-list">
        <thead>
          <tr>
            <th scope="col">Sandbox</th>
            <th scope="col">Job</th>
            <th scope="col">Provider</th>
            <th scope="col">Resources</th>
            <th scope="col">Created</th>
            <th scope="col" className="text-end">
              <span className="visually-hidden">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows === null && (
            <SkeletonRows
              columns={6}
              rows={2}
              testId="sandbox-ledger-skeleton"
              label="Loading sandboxes"
            />
          )}
          {rows?.length === 0 && (
            <tr>
              <td colSpan={6} className="text-muted" data-testid="no-sandboxes">
                {showAll
                  ? "No sandbox has been created for this project yet."
                  : "No sandbox is running for this project."}
              </td>
            </tr>
          )}
          {rows?.map((s) => (
            <tr
              key={s.id}
              data-testid={`sandbox-ledger-row-${s.id}`}
              data-status={s.status}
            >
              <td>
                <span className="sandbox-ledger-id">
                  <span className="tabular">#{s.id}</span>
                  <Chip data-testid={`sandbox-ledger-status-${s.id}`}>
                    {sandboxStatusLabel(s.status)}
                  </Chip>
                </span>
                {s.error && (
                  <div className="text-danger sandbox-ledger-error">
                    {s.error}
                  </div>
                )}
              </td>
              <td>
                {s.job ? (
                  <Link
                    to={`/sandboxes/${s.job.id}`}
                    data-testid={`sandbox-ledger-job-${s.id}`}
                  >
                    {s.job.title ?? `Job #${s.job.id}`}
                  </Link>
                ) : (
                  <span className="text-meta">No job</span>
                )}
                {s.job?.status && (
                  <div className="text-meta">
                    {jobStatusLabel(s.job.status)}
                  </div>
                )}
              </td>
              <td>
                {s.provider}
                {s.externalId && (
                  <div
                    className="text-meta mono sandbox-ledger-external"
                    title={s.externalId}
                  >
                    {s.externalId}
                  </div>
                )}
              </td>
              <td
                className="tabular"
                data-testid={`sandbox-ledger-resources-${s.id}`}
              >
                {resourceWords(s.resources) ?? (
                  <span className="text-meta">Not recorded</span>
                )}
              </td>
              <td className="tabular">
                <span title={new Date(s.createdAt).toLocaleString()}>
                  {relativeTime(s.createdAt)}
                </span>
                {s.destroyedAt && (
                  <div className="text-meta">
                    destroyed {relativeTime(s.destroyedAt)}
                  </div>
                )}
              </td>
              <td className="text-end">
                {isLiveSandbox(s.status) && (
                  <GatedButton
                    size="sm"
                    variant="outline-danger"
                    disabled={busy}
                    deniedReason={
                      destroyDenied ??
                      (s.destroyable ? undefined : JOB_STILL_RUNS)
                    }
                    aria-label={`Destroy sandbox ${s.id}`}
                    onClick={() => setDestroying(s)}
                    data-testid={`sandbox-ledger-destroy-${s.id}`}
                  >
                    Destroy
                  </GatedButton>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
      {pages > 1 && (
        <Pagination size="sm" data-testid="sandbox-ledger-pages">
          <Pagination.Prev
            disabled={page <= 1}
            onClick={() => setPage(page - 1)}
          />
          <Pagination.Item active>
            {page} of {pages}
          </Pagination.Item>
          <Pagination.Next
            disabled={page >= pages}
            onClick={() => setPage(page + 1)}
          />
        </Pagination>
      )}

      <ConfirmDialog
        show={destroying !== null}
        title={`Destroy sandbox ${destroying?.id ?? ""}?`}
        confirmLabel="Destroy sandbox"
        busy={busy}
        onConfirm={onDestroy}
        onCancel={() => setDestroying(null)}
        testId="sandbox-ledger-destroy"
      >
        The provider is asked to destroy it now, and whatever it holds is gone.
        A sandbox whose job is still running is the job's: cancel the job
        instead, so the conversation hears that it ended.
      </ConfirmDialog>
    </SectionCard>
  );
}
