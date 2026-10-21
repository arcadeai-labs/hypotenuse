import type { ExternalIdentityList } from "@backend/actions/external-identity/external-identity-list";
import type { ActionResponse } from "keryx";
import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../../context/AuthContext";
import { useFirstLoad } from "../../hooks/useFirstLoad";
import { Alert, Badge, Button, Card, Table } from "../../ui";
import { apiFetch } from "../../utils/client";
import SkeletonRows from "../SkeletonRows";

type LinkedIdentity =
  ActionResponse<ExternalIdentityList>["externalIdentities"][number];

/** How each link was made, in words. */
const LINKED_VIA: Record<string, string> = {
  email: "E-mail match",
  oauth: "Linear sign-in",
  admin: "Linked by an admin",
};

/**
 * Account → Linked Linear accounts: the people in the selected project's
 * Linear workspace who are you, as far as routing knows. Work they start
 * prefers your runners. A preference, never a permission — so removing a link
 * is always safe, and an e-mail match comes back the next time that person
 * starts a session.
 * @returns The card, or nothing without a selected project.
 */
export function LinkedIdentitiesCard() {
  const { user, activeProjectId } = useAuth();
  const [rows, setRows] = useState<LinkedIdentity[]>([]);
  const [error, setError] = useState<string | null>(null);
  const { loading, begin, done } = useFirstLoad();

  const load = useCallback(async () => {
    if (!user || activeProjectId === null) return;
    begin();
    try {
      const res = await apiFetch<ActionResponse<ExternalIdentityList>>(
        `/external-identities?projectId=${activeProjectId}&userId=${user.id}&limit=100`,
      );
      setRows(res.externalIdentities);
      setError(null);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not load linked accounts.",
      );
    } finally {
      done();
    }
  }, [user, activeProjectId, begin, done]);

  useEffect(() => {
    load();
  }, [load]);

  /**
   * Remove one link, then re-read the list.
   * @param id - The identity.
   */
  async function unlink(id: number) {
    try {
      await apiFetch(`/external-identity/${id}`, {
        method: "DELETE",
        body: JSON.stringify({ projectId: activeProjectId }),
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not unlink.");
    }
  }

  if (activeProjectId === null) return null;

  return (
    <Card className="page-narrow" data-testid="linked-identities">
      <Card.Header as="h2">Linked Linear accounts</Card.Header>
      <Card.Body>
        {error && (
          <Alert variant="danger" data-testid="linked-identities-error">
            {error}
          </Alert>
        )}
        <p className="text-muted mb-3">
          Sessions these people start in Linear prefer your runners. Linear
          users whose e-mail matches yours are linked automatically; an admin
          can link others.
        </p>
        {!loading && rows.length === 0 ? (
          <p className="text-muted mb-0" data-testid="linked-identities-empty">
            No Linear account is linked to you in this project yet.
          </p>
        ) : (
          <Table size="sm" responsive data-testid="linked-identities-table">
            <thead>
              <tr>
                <th scope="col">Linear user</th>
                <th scope="col">How</th>
                <th scope="col" />
              </tr>
            </thead>
            <tbody>
              {loading && (
                <SkeletonRows
                  columns={3}
                  rows={1}
                  testId="linked-identities-loading"
                />
              )}
              {rows.map((row) => (
                <tr key={row.id} data-testid={`linked-identity-${row.id}`}>
                  <td>
                    {row.externalName ?? row.externalUserId}{" "}
                    {row.externalEmail && (
                      <span className="text-muted">{row.externalEmail}</span>
                    )}
                  </td>
                  <td>
                    <Badge bg="secondary">
                      {LINKED_VIA[row.linkedVia] ?? row.linkedVia}
                    </Badge>
                  </td>
                  <td>
                    <Button
                      size="sm"
                      variant="outline-danger"
                      onClick={() => unlink(row.id)}
                      data-testid={`unlink-identity-${row.id}`}
                    >
                      Unlink
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
