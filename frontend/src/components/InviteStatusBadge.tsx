import { Badge } from "../ui";
import {
  INVITE_STATE_TONE,
  type InviteLike,
  inviteState,
} from "../utils/invites";

/**
 * An invite's state as a badge: pending, accepted, rejected, revoked, or expired.
 * @param props - `invite`, as an invite list serializes it.
 * @returns The badge.
 */
export function InviteStatusBadge({ invite }: { invite: InviteLike }) {
  const state = inviteState(invite);
  return (
    <Badge bg={INVITE_STATE_TONE[state]} data-testid="invite-status">
      {state}
    </Badge>
  );
}
