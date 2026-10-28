import { useEffect, useState } from "react";
import { PageHeader } from "../components/shell/PageHeader";
import { Alert, Table } from "../ui";
import { apiFetch } from "../utils/client";
import { checkLabel, type StatusResponse, statusChecks } from "../utils/status";

/**
 * The backend's health, as `GET /api/status` reports it. Its type comes from
 * the action through the `@backend` alias, so a renamed field fails the build
 * here rather than rendering blank.
 * @returns The status page.
 */
export function StatusPage() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<StatusResponse>("/status")
      .then(setStatus)
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : String(e)),
      );
  }, []);

  return (
    <div className="page" data-testid="status-page">
      <PageHeader title="Server status" />
      {error ? (
        <Alert variant="danger" role="alert">
          The server did not answer: {error}
        </Alert>
      ) : !status ? (
        <p className="text-meta">Asking the server…</p>
      ) : (
        <>
          <p>
            {status.name} {status.version} is{" "}
            <strong>{status.healthy ? "healthy" : "unhealthy"}</strong>.
          </p>
          <Table size="sm">
            <tbody>
              {statusChecks(status).map((check) => (
                <tr key={check.label}>
                  <th scope="row">{check.label}</th>
                  <td>{checkLabel(check.ok)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </>
      )}
    </div>
  );
}
