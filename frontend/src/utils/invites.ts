/** Where an invite stands, as a reader of it cares. */
export type InviteState = "pending" | "accepted" | "rejected" | "expired";

/** The fields {@link inviteState} reads. */
export interface InviteLike {
  status: string;
  expiresAt: number;
}

/**
 * Where an invite stands. The server stores `pending` until somebody answers;
 * a pending invite past its expiry can no longer be accepted, and says so.
 * @param invite - The invite, as an invite list serializes it.
 * @param now - The time to compare against (a test passes its own).
 * @returns Its state.
 */
export function inviteState(invite: InviteLike, now = Date.now()): InviteState {
  if (invite.status === "accepted") return "accepted";
  if (invite.status === "rejected") return "rejected";
  return invite.expiresAt <= now ? "expired" : "pending";
}

/** The tone each state's badge is painted in: only a live invite takes color. */
export const INVITE_STATE_TONE: Record<InviteState, string> = {
  pending: "info",
  accepted: "success",
  rejected: "secondary",
  expired: "secondary",
};
