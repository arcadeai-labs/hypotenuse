import { useEffect, useState } from "react";
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

  if (error) {
    return (
      <main>
        <h1>Server status</h1>
        <p role="alert">The server did not answer: {error}</p>
      </main>
    );
  }
  if (!status) {
    return (
      <main>
        <h1>Server status</h1>
        <p>Asking the server…</p>
      </main>
    );
  }

  return (
    <main>
      <h1>Server status</h1>
      <p>
        {status.name} {status.version} is{" "}
        <strong>{status.healthy ? "healthy" : "unhealthy"}</strong>.
      </p>
      <table>
        <tbody>
          {statusChecks(status).map((check) => (
            <tr key={check.label}>
              <th scope="row">{check.label}</th>
              <td>{checkLabel(check.ok)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
