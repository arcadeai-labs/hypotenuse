import type { ExternalIdentityList } from "@backend/actions/external-identity/external-identity-list";
import type { MembershipList } from "@backend/actions/membership/membership-list";
import type { ActionResponse } from "keryx";
import { useCallback, useEffect, useState } from "react";
import { useFirstLoad } from "../../hooks/useFirstLoad";
import { Alert, Badge, Button, Card, Form, Table } from "../../ui";
import { apiFetch } from "../../utils/client";
import SkeletonRows from "../SkeletonRows";
import { LINKED_VIA } from "./LinkedIdentitiesCard";

type LinkedIdentity =
  ActionResponse<ExternalIdentityList>["externalIdentities"][number];
type Member = ActionResponse<MembershipList>["memberships"][number];

/**
 * Every link in the project between a Linear user and a member — what routing
 * reads to prefer the issuer's own runners — with Unlink on each, and a form
 * to link a Linear user (by id) to a member. Rendered only for those `can()`
 * allows `external-identity:link`.
 * @param props - The project.
 * @returns The card.
 */
export function AllIdentitiesCard({ projectId }: { projectId: number }) {
  const [rows, setRows] = useState<LinkedIdentity[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [userId, setUserId] = useState("");
  const [externalUserId, setExternalUserId] = useState("");
  const [externalName, setExternalName] = useState("");
  const [busy, setBusy] = useState(false);
  const { loading, begin, done } = useFirstLoad();

  const load = useCallback(async () => {
    begin();
    try {
      const [identities, roster] = await Promise.all([
        apiFetch<ActionResponse<ExternalIdentityList>>(
          `/external-identities?projectId=${projectId}&limit=100`,
        ),
        apiFetch<ActionResponse<MembershipList>>(
          `/memberships?projectId=${projectId}&limit=100`,
        ),
      ]);
      setRows(identities.externalIdentities);
      setMembers(roster.memberships);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load links.");
    } finally {
      done();
    }
  }, [projectId, begin, done]);

  useEffect(() => {
    load();
  }, [load]);

  /** Link the Linear user in the form to the chosen member. */
  async function link() {
    if (!userId || !externalUserId.trim()) {
      return setError("Choose a member and give the Linear user's id.");
    }
    setBusy(true);
    try {
      await apiFetch("/external-identity", {
        method: "PUT",
        body: JSON.stringify({
          projectId,
          userId: Number(userId),
          externalUserId: externalUserId.trim(),
          ...(externalName.trim() ? { externalName: externalName.trim() } : {}),
        }),
      });
      setExternalUserId("");
      setExternalName("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not link.");
    } finally {
      setBusy(false);
    }
  }

  /**
   * Remove one link.
   * @param id - The identity.
   */
  async function unlink(id: number) {
    setBusy(true);
    try {
      await apiFetch(`/external-identity/${id}`, {
        method: "DELETE",
        body: JSON.stringify({ projectId }),
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not unlink.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card data-testid="all-identities">
      <Card.Header as="h2">Every link in this project</Card.Header>
      <Card.Body>
        {error && (
          <Alert
            variant="danger"
            dismissible
            onClose={() => setError(null)}
            data-testid="all-identities-error"
          >
            {error}
          </Alert>
        )}
        <Table size="sm" responsive data-testid="all-identities-table">
          <thead>
            <tr>
              <th scope="col">Linear user</th>
              <th scope="col">Member</th>
              <th scope="col">How</th>
              <th scope="col" />
            </tr>
          </thead>
          <tbody>
            {loading && (
              <SkeletonRows
                columns={4}
                rows={2}
                testId="all-identities-loading"
              />
            )}
            {!loading && rows.length === 0 && (
              <tr>
                <td
                  colSpan={4}
                  className="text-muted"
                  data-testid="all-identities-empty"
                >
                  No links yet.
                </td>
              </tr>
            )}
            {rows.map((row) => (
              <tr key={row.id} data-testid={`identity-${row.id}`}>
                <td>
                  {row.externalName ?? row.externalUserId}{" "}
                  {row.externalEmail && (
                    <span className="text-muted">{row.externalEmail}</span>
                  )}
                </td>
                <td>{row.user?.name ?? `user ${row.userId}`}</td>
                <td>
                  <Badge bg="secondary">
                    {LINKED_VIA[row.linkedVia] ?? row.linkedVia}
                  </Badge>
                </td>
                <td>
                  <Button
                    size="sm"
                    variant="outline-danger"
                    disabled={busy}
                    onClick={() => unlink(row.id)}
                    data-testid={`admin-unlink-${row.id}`}
                  >
                    Unlink
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
        <Form
          className="identity-link-form"
          data-testid="identity-link-form"
          onSubmit={(e) => {
            e.preventDefault();
            void link();
          }}
        >
          <Form.Group controlId="identity-member">
            <Form.Label className="text-meta">Member</Form.Label>
            <Form.Select
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              data-testid="identity-member"
            >
              <option value="">Choose a member</option>
              {members.map((m) => (
                <option key={m.user.id} value={String(m.user.id)}>
                  {m.user.name} ({m.user.email})
                </option>
              ))}
            </Form.Select>
          </Form.Group>
          <Form.Group controlId="identity-external-id">
            <Form.Label className="text-meta">Linear user id</Form.Label>
            <Form.Control
              value={externalUserId}
              onChange={(e) => setExternalUserId(e.target.value)}
              data-testid="identity-external-id"
            />
          </Form.Group>
          <Form.Group controlId="identity-external-name">
            <Form.Label className="text-meta">
              Their Linear name (optional)
            </Form.Label>
            <Form.Control
              value={externalName}
              onChange={(e) => setExternalName(e.target.value)}
              data-testid="identity-external-name"
            />
          </Form.Group>
          <Button
            type="submit"
            size="sm"
            variant="primary"
            disabled={busy}
            data-testid="identity-link"
          >
            Link
          </Button>
        </Form>
      </Card.Body>
    </Card>
  );
}
