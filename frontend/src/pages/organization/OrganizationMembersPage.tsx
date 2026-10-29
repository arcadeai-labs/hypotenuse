import type { OrganizationInviteList } from "@backend/actions/organization/organization-invite-list";
import type { OrganizationMembershipList } from "@backend/actions/organization-membership/organization-membership-list";
import type { ActionResponse } from "keryx";
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { GatedButton } from "../../components/GatedButton";
import { InviteStatusBadge } from "../../components/InviteStatusBadge";
import { useOrganization } from "../../components/organization/context";
import { SkeletonRows } from "../../components/SkeletonRows";
import { SectionCard } from "../../components/sections/SectionCard";
import { useSectionSave } from "../../components/sections/useSectionSave";
import { useAuth } from "../../context/AuthContext";
import { useFirstLoad } from "../../hooks/useFirstLoad";
import { Badge, Button, Form, Table } from "../../ui";
import { apiFetch } from "../../utils/client";

/** One organization member, as `organization-membership:list` serializes it. */
type OrganizationMember =
  ActionResponse<OrganizationMembershipList>["memberships"][number];
/** An invite into the organization or one of its projects. */
type OrganizationInvite =
  ActionResponse<OrganizationInviteList>["invites"][number];

/**
 * `/organization/members` — who is in the organization and in what role. An
 * owner promotes, demotes, and removes; anyone may leave; an owner invites
 * someone into the organization by email. Removing someone also removes them
 * from every project of the organization.
 * @returns The page.
 */
export function OrganizationMembersPage() {
  const { organizationId, organization, may, reason } = useOrganization();
  const { user, refresh } = useAuth();
  const navigate = useNavigate();
  const { busy, error, notice, setError, setNotice, save } = useSectionSave();
  const [members, setMembers] = useState<OrganizationMember[]>([]);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const { loading, begin, done } = useFirstLoad();

  // `organization-membership:delete` is any member's (to leave); removing
  // someone else is an owner's, the same standing that changes roles.
  const manageDenied = reason("organization-membership:edit");
  const leaveDenied = reason("organization-membership:delete");

  const load = useCallback(async () => {
    begin();
    try {
      const res = await apiFetch<ActionResponse<OrganizationMembershipList>>(
        `/organization/${organizationId}/members?limit=100`,
      );
      setMembers(res.memberships);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load members.");
    } finally {
      done();
    }
  }, [organizationId, begin, done, setError]);

  useEffect(() => {
    load();
  }, [load]);

  /**
   * Change one member's role.
   * @param member - The member.
   * @param role - The new role.
   */
  async function setRole(member: OrganizationMember, role: "owner" | "member") {
    const ok = await save(
      () =>
        apiFetch(`/organization/${organizationId}/member/${member.userId}`, {
          method: "POST",
          body: JSON.stringify({ role }),
        }),
      role === "owner"
        ? `${member.user.name} is now an owner.`
        : `${member.user.name} is now a member.`,
    );
    if (!ok) return;
    await load();
    // Demoting yourself changes your own standing.
    if (member.userId === user?.id) await refresh();
  }

  /**
   * Remove a member, or leave when it is yourself.
   * @param member - The member.
   */
  async function remove(member: OrganizationMember) {
    const self = member.userId === user?.id;
    const ok = await save(
      () =>
        apiFetch(`/organization/${organizationId}/member/${member.userId}`, {
          method: "DELETE",
        }),
      self
        ? `You left ${organization.name}.`
        : `Removed ${member.user.name} from ${organization.name} and its projects.`,
    );
    if (!ok) return;
    if (self) {
      await refresh();
      navigate("/organization/projects");
      return;
    }
    await load();
  }

  return (
    <>
      <SectionCard
        title="Members"
        testId="organization-members"
        idPrefix="organization"
        cardTestId="organization-members-card"
        intro="Owners administer every project in the organization; members see only the projects they are added to."
        error={error}
        notice={notice}
        onDismissError={() => setError(null)}
        onDismissNotice={() => setNotice(null)}
      >
        <Table hover responsive size="sm" data-testid="organization-members">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Email</th>
              <th scope="col">Role</th>
              <th scope="col" className="text-end">
                <span className="visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <SkeletonRows
                columns={4}
                rows={3}
                testId="organization-members-skeleton"
                label="Loading members"
              />
            )}
            {!loading &&
              members.map((m) => {
                const self = m.userId === user?.id;
                return (
                  <tr
                    key={m.id}
                    data-testid={`organization-member-${m.userId}`}
                  >
                    <td>
                      {m.user.name}
                      {self && <span className="text-meta"> (you)</span>}
                    </td>
                    <td>{m.user.email}</td>
                    <td>
                      <Badge
                        bg={m.role === "owner" ? "info" : "secondary"}
                        data-testid="organization-member-role"
                      >
                        {m.role}
                      </Badge>
                    </td>
                    <td className="text-end">
                      <div className="d-inline-flex gap-2">
                        <GatedButton
                          size="sm"
                          variant="outline-secondary"
                          disabled={busy}
                          deniedReason={manageDenied}
                          data-testid={`organization-role-${m.userId}`}
                          onClick={() =>
                            setRole(m, m.role === "owner" ? "member" : "owner")
                          }
                        >
                          {m.role === "owner" ? "Make member" : "Make owner"}
                        </GatedButton>
                        {self ? (
                          confirmLeave ? (
                            <>
                              <Button
                                size="sm"
                                variant="danger"
                                disabled={busy}
                                onClick={() => remove(m)}
                                data-testid="organization-leave-confirm"
                              >
                                Leave {organization.name}
                              </Button>
                              <Button
                                size="sm"
                                variant="outline-secondary"
                                onClick={() => setConfirmLeave(false)}
                              >
                                Cancel
                              </Button>
                            </>
                          ) : (
                            <GatedButton
                              size="sm"
                              variant="outline-danger"
                              disabled={busy}
                              deniedReason={leaveDenied}
                              onClick={() => setConfirmLeave(true)}
                              data-testid="organization-leave"
                            >
                              Leave
                            </GatedButton>
                          )
                        ) : (
                          <GatedButton
                            size="sm"
                            variant="outline-danger"
                            disabled={busy}
                            deniedReason={manageDenied}
                            onClick={() => remove(m)}
                            data-testid={`organization-remove-${m.userId}`}
                          >
                            Remove
                          </GatedButton>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
          </tbody>
        </Table>
      </SectionCard>

      <OrganizationInviteCard
        organizationId={organizationId}
        deniedReason={
          may("invite:create")
            ? reason("organization:invite-list")
            : reason("invite:create")
        }
      />
    </>
  );
}

/**
 * Invite someone into the organization by email — as a member, with no
 * project — and every invite the organization and its projects have sent.
 * Both are an owner's; anyone else sees the controls disabled and is not
 * asked for the list.
 * @param props - The organization, and why inviting is refused when it is.
 * @returns The card.
 */
function OrganizationInviteCard({
  organizationId,
  deniedReason,
}: {
  organizationId: number;
  deniedReason?: string;
}) {
  const { busy, error, notice, setError, setNotice, save } = useSectionSave();
  const [email, setEmail] = useState("");
  const [invites, setInvites] = useState<OrganizationInvite[]>([]);
  const { loading, begin, done } = useFirstLoad();
  const allowed = deniedReason === undefined;

  const load = useCallback(async () => {
    if (!allowed) {
      done();
      return;
    }
    begin();
    try {
      const res = await apiFetch<ActionResponse<OrganizationInviteList>>(
        `/organization/${organizationId}/invites?limit=100`,
      );
      setInvites(res.invites);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load invites.");
    } finally {
      done();
    }
  }, [allowed, organizationId, begin, done, setError]);

  useEffect(() => {
    load();
  }, [load]);

  /** Send the invite, then re-read the list. */
  async function onInvite() {
    const invitee = email.trim();
    if (!invitee) return;
    const ok = await save(
      () =>
        apiFetch(`/organization/${organizationId}/invite`, {
          method: "PUT",
          body: JSON.stringify({ inviteeEmail: invitee }),
        }),
      `Invited ${invitee} to the organization. They will find it under Invites when they sign in with that address.`,
    );
    if (!ok) return;
    setEmail("");
    await load();
  }

  return (
    <SectionCard
      title="Invite to the organization"
      testId="organization-invite"
      idPrefix="organization"
      cardTestId="organization-invite-card"
      intro="An organization invite makes someone a member with no project. To bring someone into a project, invite them from that project's Members settings."
      error={error}
      notice={notice}
      onDismissError={() => setError(null)}
      onDismissNotice={() => setNotice(null)}
    >
      <Form
        className="d-flex gap-2 flex-wrap align-items-end"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          onInvite();
        }}
      >
        <Form.Group controlId="organization-invite-email" className="mb-0">
          <Form.Label>Email</Form.Label>
          <Form.Control
            size="sm"
            type="email"
            autoComplete="off"
            placeholder="name@example.com"
            value={email}
            disabled={busy || !allowed}
            title={deniedReason}
            onChange={(e) => setEmail(e.target.value)}
            data-testid="organization-invite-email"
          />
        </Form.Group>
        <GatedButton
          size="sm"
          type="submit"
          variant="primary"
          disabled={busy}
          deniedReason={deniedReason}
          data-testid="organization-invite-submit"
        >
          Send invite
        </GatedButton>
      </Form>

      <h3 className="settings-subheading">Invites sent</h3>
      {allowed ? (
        <Table hover responsive size="sm" data-testid="organization-invites">
          <thead>
            <tr>
              <th scope="col">Email</th>
              <th scope="col">Into</th>
              <th scope="col">Status</th>
              <th scope="col">Invited by</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <SkeletonRows
                columns={4}
                rows={2}
                testId="organization-invites-skeleton"
                label="Loading invites"
              />
            )}
            {!loading &&
              invites.map((invite) => (
                <tr key={invite.id}>
                  <td>{invite.inviteeEmail}</td>
                  <td>
                    {invite.kind === "organization"
                      ? "The organization"
                      : invite.projectName}
                  </td>
                  <td>
                    <InviteStatusBadge invite={invite} />
                  </td>
                  <td>{invite.inviterEmail}</td>
                </tr>
              ))}
            {!loading && invites.length === 0 && (
              <tr>
                <td colSpan={4} className="text-muted">
                  None yet. An invite sent here or from a project appears here.
                </td>
              </tr>
            )}
          </tbody>
        </Table>
      ) : (
        <p
          className="text-muted mb-0"
          data-testid="organization-invites-denied"
        >
          {deniedReason}
        </p>
      )}
    </SectionCard>
  );
}
