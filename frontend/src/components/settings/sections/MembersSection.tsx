import type { InviteList } from "@backend/actions/invite/invite-list";
import type { MembershipList } from "@backend/actions/membership/membership-list";
import type { TagList } from "@backend/actions/tag/tag-list";
import type { ActionResponse } from "keryx";
import { Lock, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { useAuth } from "../../../context/AuthContext";
import { useFirstLoad } from "../../../hooks/useFirstLoad";
import { Badge, Button, Dropdown, Form, Table } from "../../../ui";
import { apiFetch } from "../../../utils/client";
import { GatedButton } from "../../GatedButton";
import { InviteStatusBadge } from "../../InviteStatusBadge";
import { SkeletonRows } from "../../SkeletonRows";
import { SectionCard } from "../../sections/SectionCard";
import { useSectionSave } from "../../sections/useSectionSave";
import { useProjectSettings } from "../context";

/** One member with their tags, as `membership:list` serializes it. */
type Member = ActionResponse<MembershipList>["memberships"][number];
/** A tag as `tag:list` serializes it. */
type ProjectTag = ActionResponse<TagList>["tags"][number];
/** An invite as `invite:list` serializes it. */
type ProjectInvite = ActionResponse<InviteList>["invites"][number];

/**
 * Who is in the project and which tags each holds; adding an organization
 * member by email; and inviting someone by email, with the tags they get on
 * accepting, beside the invites this project has sent.
 *
 * Every control is drawn for every member and disabled, with the reason, for
 * whoever may not use it. The one read a plain member may not make — the
 * project's invites — is not made for them; its card says so instead.
 * @returns The section.
 */
export function MembersSection() {
  const { projectId, organizationId, project, may, reason } =
    useProjectSettings();
  const { user } = useAuth();
  const { busy, error, notice, setError, setNotice, save } = useSectionSave();
  const [members, setMembers] = useState<Member[]>([]);
  const [tags, setTags] = useState<ProjectTag[]>([]);
  const [newMemberEmail, setNewMemberEmail] = useState("");
  const { loading, begin, done } = useFirstLoad();

  const load = useCallback(async () => {
    begin();
    try {
      const [memberships, tagList] = await Promise.all([
        apiFetch<ActionResponse<MembershipList>>(
          `/project/${projectId}/members?limit=100`,
        ),
        apiFetch<ActionResponse<TagList>>(
          `/project/${projectId}/tags?limit=100`,
        ),
      ]);
      setMembers(memberships.memberships);
      setTags(tagList.tags);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load members.");
    } finally {
      done();
    }
  }, [projectId, setError, begin, done]);

  useEffect(() => {
    load();
  }, [load]);

  /**
   * Run one membership or tag change and re-read the table.
   * @param fn - The request.
   * @param success - What to say when it worked.
   * @returns Whether it worked.
   */
  async function change(
    fn: () => Promise<unknown>,
    success: string,
  ): Promise<boolean> {
    const ok = await save(fn, success);
    if (ok) await load();
    return ok;
  }

  const grantDenied = reason("user-tag:assign");
  const revokeDenied = reason("user-tag:remove");
  const removeDenied = reason("membership:delete");
  const addDenied = reason("membership:create");

  return (
    <>
      <SectionCard
        title="Members"
        testId="members"
        idPrefix="settings"
        cardTestId="members-card"
        error={error}
        notice={notice}
        onDismissError={() => setError(null)}
        onDismissNotice={() => setNotice(null)}
      >
        <Table hover responsive size="sm" data-testid="members-table">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Email</th>
              <th scope="col">Tags</th>
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
                testId="members-skeleton"
                label="Loading members"
              />
            )}
            {!loading &&
              members.map((m) => {
                const grantable = tags.filter(
                  (t) => !m.tags.some((held) => held.id === t.id),
                );
                return (
                  <tr key={m.id} data-testid={`member-row-${m.userId}`}>
                    <td>
                      {m.user.name}
                      {m.userId === user?.id && (
                        <span className="text-meta"> (you)</span>
                      )}
                    </td>
                    <td>{m.user.email}</td>
                    <td>
                      <div className="tag-chips">
                        {m.tags.map((t) => (
                          <Badge
                            key={t.id}
                            pill
                            bg="secondary"
                            className="tag-chip"
                            data-testid={`member-tag-${m.userId}-${t.name}`}
                          >
                            {t.reserved && <Lock size={10} aria-hidden />}
                            {t.name}
                            <button
                              type="button"
                              className="tag-chip-remove"
                              disabled={busy || revokeDenied !== undefined}
                              title={revokeDenied ?? `Revoke ${t.name}`}
                              aria-label={`Revoke ${t.name} from ${m.user.name}`}
                              onClick={() =>
                                change(
                                  () =>
                                    apiFetch(
                                      `/project/${projectId}/member/${m.userId}/tag/${t.id}`,
                                      { method: "DELETE" },
                                    ),
                                  `Revoked ${t.name} from ${m.user.name}.`,
                                )
                              }
                            >
                              <X size={10} aria-hidden />
                            </button>
                          </Badge>
                        ))}
                        {m.tags.length === 0 && (
                          <span className="text-muted">—</span>
                        )}
                      </div>
                    </td>
                    <td className="text-end">
                      <div className="d-inline-flex gap-2">
                        {grantDenied || grantable.length === 0 ? (
                          <Button
                            size="sm"
                            variant="outline-secondary"
                            disabled
                            title={grantDenied ?? "They hold every tag"}
                            data-testid={`grant-tag-${m.userId}`}
                          >
                            Grant tag
                          </Button>
                        ) : (
                          <Dropdown align="end">
                            <Dropdown.Toggle
                              as={Button}
                              size="sm"
                              variant="outline-secondary"
                              data-testid={`grant-tag-${m.userId}`}
                            >
                              Grant tag
                            </Dropdown.Toggle>
                            <Dropdown.Menu>
                              {grantable.map((t) => (
                                <Dropdown.Item
                                  key={t.id}
                                  data-testid={`grant-tag-${m.userId}-${t.name}`}
                                  onClick={() =>
                                    change(
                                      () =>
                                        apiFetch(
                                          `/project/${projectId}/member/${m.userId}/tag/${t.id}`,
                                          { method: "PUT" },
                                        ),
                                      `Granted ${t.name} to ${m.user.name}.`,
                                    )
                                  }
                                >
                                  {t.name}
                                </Dropdown.Item>
                              ))}
                            </Dropdown.Menu>
                          </Dropdown>
                        )}
                        <GatedButton
                          size="sm"
                          variant="outline-danger"
                          disabled={busy}
                          deniedReason={removeDenied}
                          data-testid={`remove-member-${m.userId}`}
                          onClick={() =>
                            change(
                              () =>
                                apiFetch(
                                  `/project/${projectId}/member/${m.userId}`,
                                  { method: "DELETE" },
                                ),
                              `Removed ${m.user.name} from ${project.name}.`,
                            )
                          }
                        >
                          Remove
                        </GatedButton>
                      </div>
                    </td>
                  </tr>
                );
              })}
          </tbody>
        </Table>

        <Form
          className="d-flex gap-2 flex-wrap align-items-end"
          onSubmit={(e) => {
            e.preventDefault();
            const email = newMemberEmail.trim();
            if (!email) return;
            change(
              () =>
                apiFetch(`/project/${projectId}/member`, {
                  method: "PUT",
                  body: JSON.stringify({ email }),
                }),
              `Added ${email}.`,
            ).then((ok) => {
              if (ok) setNewMemberEmail("");
            });
          }}
        >
          <Form.Group controlId="new-member-email" className="mb-0">
            <Form.Label>Add someone already in the organization</Form.Label>
            <Form.Control
              size="sm"
              type="email"
              placeholder="name@example.com"
              value={newMemberEmail}
              disabled={busy || addDenied !== undefined}
              title={addDenied}
              onChange={(e) => setNewMemberEmail(e.target.value)}
              data-testid="new-member-email"
            />
          </Form.Group>
          <GatedButton
            size="sm"
            type="submit"
            variant="outline-primary"
            disabled={busy}
            deniedReason={addDenied}
            data-testid="new-member-submit"
          >
            Add member
          </GatedButton>
        </Form>
        <p className="text-meta mt-2 mb-0">
          Someone outside the organization needs an invite first — below.
        </p>
      </SectionCard>

      <InviteCard
        projectId={projectId}
        organizationId={organizationId}
        tags={tags}
        deniedReason={
          may("invite:create") ? reason("invite:list") : reason("invite:create")
        }
      />
    </>
  );
}

/** See {@link InviteCard}. */
interface InviteCardProps {
  projectId: number;
  organizationId: number;
  /** The project's tags, to grant on acceptance. */
  tags: ProjectTag[];
  /** Why inviting into this project is refused, when it is. */
  deniedReason?: string;
}

/**
 * Invite someone to the project by email, granting tags on acceptance, and the
 * invites the project has sent. An invite into a project brings its invitee
 * into the organization as a member too.
 *
 * Reading the project's invites is a project admin's; for anyone else the card
 * explains that and asks for nothing, so it never draws a 403.
 * @param props - See {@link InviteCardProps}.
 * @returns The card.
 */
function InviteCard({
  projectId,
  organizationId,
  tags,
  deniedReason,
}: InviteCardProps) {
  const { busy, error, notice, setError, setNotice, save } = useSectionSave();
  const [email, setEmail] = useState("");
  const [tagIds, setTagIds] = useState<number[]>([]);
  const [invites, setInvites] = useState<ProjectInvite[]>([]);
  const { loading, begin, done } = useFirstLoad();
  const { hash } = useLocation();
  const allowed = deniedReason === undefined;

  const load = useCallback(async () => {
    if (!allowed) {
      done();
      return;
    }
    begin();
    try {
      const res = await apiFetch<ActionResponse<InviteList>>(
        `/project/${projectId}/invites?limit=100`,
      );
      setInvites(res.invites);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load invites.");
    } finally {
      done();
    }
  }, [allowed, projectId, begin, done, setError]);

  useEffect(() => {
    load();
  }, [load]);

  // `⌘K → Invite member` lands here with `#invite`.
  useEffect(() => {
    if (hash !== "#invite") return;
    document
      .getElementById("invite")
      ?.scrollIntoView({ block: "start", behavior: "auto" });
    document.getElementById("invite-email")?.focus();
  }, [hash]);

  /** Send the invite, then re-read the list. */
  async function onInvite() {
    const invitee = email.trim();
    if (!invitee) return;
    const ok = await save(
      () =>
        apiFetch(`/organization/${organizationId}/invite`, {
          method: "PUT",
          body: JSON.stringify({ projectId, inviteeEmail: invitee, tagIds }),
        }),
      `Invited ${invitee}. They will find it under Invites when they sign in with that address.`,
    );
    if (!ok) return;
    setEmail("");
    setTagIds([]);
    await load();
  }

  const grantable = tags.filter((t) => !t.reserved);

  return (
    <section id="invite" className="settings-anchor">
      <SectionCard
        title="Invite by email"
        testId="project-invite"
        idPrefix="settings"
        cardTestId="invite-card"
        error={error}
        notice={notice}
        onDismissError={() => setError(null)}
        onDismissNotice={() => setNotice(null)}
      >
        <Form
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            onInvite();
          }}
        >
          <Form.Group controlId="invite-email" className="mb-3">
            <Form.Label>Email</Form.Label>
            <Form.Control
              className="settings-input"
              type="email"
              autoComplete="off"
              placeholder="name@example.com"
              value={email}
              disabled={busy || !allowed}
              title={deniedReason}
              onChange={(e) => setEmail(e.target.value)}
              data-testid="invite-email"
            />
            <Form.Text className="text-muted">
              They do not need an account yet. Accepting adds them to the
              organization as a member, and to this project.
            </Form.Text>
          </Form.Group>
          {grantable.length > 0 && (
            <fieldset className="settings-fieldset mb-3" disabled={!allowed}>
              <legend className="ui-form-label form-label">
                Tags to grant on acceptance
              </legend>
              <div className="d-flex flex-wrap gap-3">
                {grantable.map((t) => (
                  <Form.Check
                    key={t.id}
                    type="checkbox"
                    id={`invite-tag-${t.id}`}
                    label={t.name}
                    checked={tagIds.includes(t.id)}
                    data-testid={`invite-tag-${t.name}`}
                    onChange={(e) =>
                      setTagIds((ids) =>
                        e.target.checked
                          ? [...ids, t.id]
                          : ids.filter((id) => id !== t.id),
                      )
                    }
                  />
                ))}
              </div>
            </fieldset>
          )}
          <GatedButton
            type="submit"
            variant="primary"
            size="sm"
            disabled={busy}
            deniedReason={deniedReason}
            data-testid="invite-submit"
          >
            Send invite
          </GatedButton>
        </Form>

        <h3 className="settings-subheading">Invites this project has sent</h3>
        {allowed ? (
          <Table hover responsive size="sm" data-testid="project-invites">
            <thead>
              <tr>
                <th scope="col">Email</th>
                <th scope="col">Status</th>
                <th scope="col">Invited by</th>
                <th scope="col">Expires</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <SkeletonRows
                  columns={4}
                  rows={2}
                  testId="project-invites-skeleton"
                  label="Loading invites"
                />
              )}
              {!loading &&
                invites.map((invite) => (
                  <tr key={invite.id}>
                    <td>{invite.inviteeEmail}</td>
                    <td>
                      <InviteStatusBadge invite={invite} />
                    </td>
                    <td>{invite.inviterEmail}</td>
                    <td className="tabular">
                      {new Date(invite.expiresAt).toLocaleDateString()}
                    </td>
                  </tr>
                ))}
              {!loading && invites.length === 0 && (
                <tr>
                  <td colSpan={4} className="text-muted">
                    None yet. An invite sent above appears here until it is
                    answered or expires.
                  </td>
                </tr>
              )}
            </tbody>
          </Table>
        ) : (
          <p className="text-muted mb-0" data-testid="project-invites-denied">
            {deniedReason}
          </p>
        )}
      </SectionCard>
    </section>
  );
}
