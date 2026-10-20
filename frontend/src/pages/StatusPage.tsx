import type { Status } from "@backend/actions/status";
import type { ActionResponse } from "keryx";
import { useEffect, useState } from "react";
import { apiFetch } from "../utils/client";

type StatusResponse = ActionResponse<Status>;

/**
 * The backend's health, typed straight from the `status` action — the proof
 * that backend response types reach the frontend without codegen.
 * @returns The status page.
 */
export function StatusPage() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<StatusResponse>("/status")
      .then(setStatus)
      .catch((e: Error) => setError(e.message));
  }, []);

  if (error)
    return <p data-testid="status-error">Backend unreachable: {error}</p>;
  if (!status) return <p>Checking…</p>;
  return (
    <dl data-testid="status">
      <dt>Healthy</dt>
      <dd>{String(status.healthy)}</dd>
      <dt>Version</dt>
      <dd>{status.version}</dd>
      <dt>Database</dt>
      <dd>{String(status.checks.database)}</dd>
      <dt>Redis</dt>
      <dd>{String(status.checks.redis)}</dd>
    </dl>
  );
}
