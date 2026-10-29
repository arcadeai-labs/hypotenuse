import { and, eq } from "drizzle-orm";
import { type ProjectInvite, projectInvites } from "../schema/project_invites";
import type { TxHandle } from "./DbOps";

/** How long an invite remains valid before it expires: five days, in ms. */
export const INVITE_TTL_MS = 5 * 24 * 60 * 60 * 1000;

/** The invite lifecycle states stored in `project_invites.status`. */
export const INVITE_STATUS = {
  pending: "pending",
  accepted: "accepted",
  rejected: "rejected",
  /** Withdrawn because the invitee was removed from the organization or project it names. */
  revoked: "revoked",
} as const;

/**
 * Whether an invite has passed its expiry timestamp.
 * @param invite - The invite row to check.
 * @param now - The reference time (defaults to the current time).
 * @returns `true` if the invite is expired.
 */
export function isExpired(
  invite: ProjectInvite,
  now: Date = new Date(),
): boolean {
  return invite.expiresAt.getTime() <= now.getTime();
}

/**
 * Shape an invite row into the API-safe object returned by actions. `kind` is
 * the server's answer to "what does accepting this give me", so the client never
 * infers it from a nullable column.
 * @param invite - The invite row from the database.
 * @returns The serialized invite.
 */
export function serializeInvite(invite: ProjectInvite) {
  return {
    id: invite.id,
    kind: invite.projectId ? ("project" as const) : ("organization" as const),
    organizationId: invite.organizationId,
    projectId: invite.projectId,
    inviterUserId: invite.inviterUserId,
    inviteeEmail: invite.inviteeEmail,
    tagIds: invite.tagIds,
    status: invite.status,
    inviterEmail: invite.inviterEmail,
    organizationName: invite.organizationName,
    projectName: invite.projectName,
    createdAt: invite.createdAt.getTime(),
    expiresAt: invite.expiresAt.getTime(),
  };
}

/**
 * Withdraw the pending invites addressed to someone who was just removed, so
 * a stale invite is not a way back in. Called on the removing transaction.
 *
 * - With a `projectId`, the invites into that project (the person was removed
 *   from it, and stays in the organization).
 * - Without one, every pending invite into the organization, project invites
 *   included (the person was removed from the organization).
 * @param tx - The removing transaction.
 * @param organizationId - The organization.
 * @param email - The removed person's address.
 * @param projectId - The project they were removed from, or `null` for the organization.
 * @returns The ids of the invites withdrawn.
 */
export async function revokePendingInvites(
  tx: TxHandle,
  organizationId: number,
  email: string,
  projectId: number | null,
): Promise<number[]> {
  const rows = await tx
    .update(projectInvites)
    .set({ status: INVITE_STATUS.revoked })
    .where(
      and(
        eq(projectInvites.organizationId, organizationId),
        eq(projectInvites.inviteeEmail, email),
        eq(projectInvites.status, INVITE_STATUS.pending),
        projectId === null
          ? undefined
          : eq(projectInvites.projectId, projectId),
      ),
    )
    .returning({ id: projectInvites.id });
  return rows.map((r) => r.id);
}
