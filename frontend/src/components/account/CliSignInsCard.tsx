import type { CliTokenList } from "@backend/actions/cli-token/cli-token-list";
import type { ActionResponse } from "keryx";
import { useCallback, useEffect, useState } from "react";
import { useFirstLoad } from "../../hooks/useFirstLoad";
import { Alert, Badge, Button, Card, Table } from "../../ui";
import { apiFetch } from "../../utils/client";
import SkeletonRows from "../SkeletonRows";

type CliSignIn = ActionResponse<CliTokenList>["cliTokens"][number];

/**
 * Format an epoch-ms time for the table, or a dash.
 * @param ms - Epoch milliseconds, or null.
 * @returns A short local date and time.
 */
function when(ms: number | null): string {
  return ms === null
    ? "—"
    : new Date(ms).toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      });
}

/**
 * Account → CLI sign-ins: every `hypotenuse` CLI signed in as you, with when it
 * was last used and a Revoke button. Revoking takes effect on that CLI's next
 * request. Whether a sign-in has expired is the server's answer (`status`),
 * not a comparison against this browser's clock.
 * @returns The card.
 */
export function CliSignInsCard() {
  const [rows, setRows] = useState<CliSignIn[]>([]);
  const [error, setError] = useState<string | null>(null);
  const { loading, begin, done } = useFirstLoad();

  const load = useCallback(async () => {
    begin();
    try {
      const res = await apiFetch<ActionResponse<CliTokenList>>(
        "/cli-tokens?limit=100",
      );
      setRows(res.cliTokens);
      setError(null);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not load CLI sign-ins.",
      );
    } finally {
      done();
    }
  }, [begin, done]);

  useEffect(() => {
    load();
  }, [load]);

  /**
   * Revoke one sign-in, then re-read the list.
   * @param id - The sign-in to revoke.
   */
  async function revoke(id: number) {
    try {
      await apiFetch("/cli-token", {
        method: "DELETE",
        body: JSON.stringify({ cliTokenId: id }),
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not revoke.");
    }
  }

  return (
    <Card className="page-narrow" data-testid="cli-sign-ins">
      <Card.Header as="h2">CLI sign-ins</Card.Header>
      <Card.Body>
        {error && (
          <Alert variant="danger" data-testid="cli-sign-ins-error">
            {error}
          </Alert>
        )}
        {!loading && rows.length === 0 ? (
          <p className="text-muted mb-0" data-testid="cli-sign-ins-empty">
            No CLI is signed in as you. Run <code>hypotenuse login</code> in a
            terminal to add one.
          </p>
        ) : (
          <Table size="sm" responsive data-testid="cli-sign-ins-table">
            <thead>
              <tr>
                <th scope="col">Device</th>
                <th scope="col">Signed in</th>
                <th scope="col">Last used</th>
                <th scope="col">Expires</th>
                <th scope="col" />
              </tr>
            </thead>
            <tbody>
              {loading && (
                <SkeletonRows
                  columns={5}
                  rows={2}
                  testId="cli-sign-ins-loading"
                />
              )}
              {rows.map((row) => (
                <tr key={row.id} data-testid={`cli-sign-in-${row.id}`}>
                  <td>
                    {row.device}{" "}
                    <span className="text-muted">…{row.lastFour}</span>{" "}
                    {row.status === "expired" && (
                      <Badge bg="secondary">Expired</Badge>
                    )}
                  </td>
                  <td>{when(row.createdAt)}</td>
                  <td>{when(row.lastUsedAt)}</td>
                  <td>{when(row.expiresAt)}</td>
                  <td>
                    <Button
                      size="sm"
                      variant="outline-danger"
                      onClick={() => revoke(row.id)}
                      data-testid={`revoke-cli-sign-in-${row.id}`}
                    >
                      Revoke
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card.Body>
    </Card>
  );
}
