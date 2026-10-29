import type { InviteListPending } from "@backend/actions/invite/invite-list-pending";
import type { ActionResponse } from "keryx";
import { Building2, FolderKanban } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { SkeletonBlocks } from "../components/SkeletonBlocks";
import { PageHeader } from "../components/shell/PageHeader";
import { useAuth } from "../context/AuthContext";
import { useFirstLoad } from "../hooks/useFirstLoad";
import { Alert, Button, Card, ListGroup } from "../ui";
import { apiFetch } from "../utils/client";

/** An invitation addressed to the signed-in person. */
type PendingInvite = ActionResponse<InviteListPending>["invites"][number];

/**
 * What an invite brings someone into, in words.
 * @param invite - The invite.
 * @returns "Support in Acme", or "Acme" for an organization invite.
 */
export function inviteTarget(invite: {
  kind: "project" | "organization";
  projectName: string | null;
  organizationName: string;
}): string {
  return invite.kind === "project" && invite.projectName
    ? `${invite.projectName} in ${invite.organizationName}`
    : invite.organizationName;
}

/**
 * `/invites` — the invitations addressed to your email, of both kinds: into
 * an organization (as a member, with no project), or into one of its projects
 * (which brings you into the organization too). Accepting one makes what it
 * opened the active organization and project.
 *
 * Until the person confirms their address the server lists nothing, and says
 * so; the page then explains why rather than claiming nothing was sent.
 * @returns The page.
 */
export function InvitesPage() {
  const { refresh, setActiveOrganization, setActiveProject } = useAuth();
  const [pending, setPending] = useState<PendingInvite[]>([]);
  const [emailVerified, setEmailVerified] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const { loading, begin, done } = useFirstLoad();

  const load = useCallback(async () => {
    begin();
    try {
      const res = await apiFetch<ActionResponse<InviteListPending>>(
        "/invites/pending?limit=100",
      );
      setPending(res.invites);
      setEmailVerified(res.emailVerified);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not load your invites.",
      );
    } finally {
      done();
    }
  }, [begin, done]);

  useEffect(() => {
    load();
  }, [load]);

  /**
   * Accept or reject one invitation.
   * @param invite - The invite to answer.
   * @param answer - Which way.
   */
  async function respond(invite: PendingInvite, answer: "accept" | "reject") {
    setError(null);
    setNotice(null);
    setBusy(invite.id);
    try {
      await apiFetch(`/invite/${invite.id}/${answer}`, { method: "POST" });
      await load();
      if (answer === "accept") {
        await refresh();
        await setActiveOrganization(invite.organizationId);
        if (invite.projectId) setActiveProject(invite.projectId);
        setNotice(`You joined ${inviteTarget(invite)}.`);
      } else {
        setNotice(`Declined the invitation to ${inviteTarget(invite)}.`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "That did not work.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="page" data-testid="invites-page">
      <PageHeader title="Invites" />
      {error && (
        <Alert
          variant="danger"
          dismissible
          onClose={() => setError(null)}
          data-testid="invites-error"
        >
          {error}
        </Alert>
      )}
      {notice && (
        <Alert
          variant="success"
          dismissible
          onClose={() => setNotice(null)}
          data-testid="invites-notice"
        >
          {notice}
        </Alert>
      )}
      <Card className="page-narrow">
        <Card.Header as="h2">Waiting for you</Card.Header>
        <ListGroup variant="flush" data-testid="pending-invites">
          {loading && (
            <ListGroup.Item>
              <SkeletonBlocks
                count={2}
                testId="pending-invites-skeleton"
                label="Loading your invitations"
              />
            </ListGroup.Item>
          )}
          {!loading &&
            pending.map((invite) => {
              const Icon = invite.kind === "project" ? FolderKanban : Building2;
              return (
                <ListGroup.Item
                  key={invite.id}
                  className="invite-row"
                  data-testid={`pending-invite-${invite.id}`}
                >
                  <Icon size={16} aria-hidden="true" className="invite-icon" />
                  <span className="invite-body">
                    <strong>{inviteTarget(invite)}</strong>
                    <span className="text-meta">
                      {invite.kind === "project"
                        ? "Project invite"
                        : "Organization invite"}{" "}
                      from {invite.inviterEmail} · expires{" "}
                      {new Date(invite.expiresAt).toLocaleDateString()}
                    </span>
                  </span>
                  <span className="d-flex gap-2">
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={busy !== null}
                      onClick={() => respond(invite, "accept")}
                      data-testid={`accept-invite-${invite.id}`}
                    >
                      Accept
                    </Button>
                    <Button
                      size="sm"
                      variant="outline-secondary"
                      disabled={busy !== null}
                      onClick={() => respond(invite, "reject")}
                      data-testid={`reject-invite-${invite.id}`}
                    >
                      Decline
                    </Button>
                  </span>
                </ListGroup.Item>
              );
            })}
          {!loading && !emailVerified && (
            <ListGroup.Item
              className="text-muted"
              data-testid="invites-unverified"
            >
              Invitations sent to your email appear here once you confirm it.
              Follow the link we mailed you, or send a new one from the banner
              above.
            </ListGroup.Item>
          )}
          {!loading && emailVerified && pending.length === 0 && (
            <ListGroup.Item
              className="text-muted"
              data-testid="no-pending-invites"
            >
              No invitations are waiting for you. One sent to your email appears
              here.
            </ListGroup.Item>
          )}
        </ListGroup>
      </Card>
    </div>
  );
}
