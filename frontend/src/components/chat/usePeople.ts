import type { MembershipList } from "@backend/actions/membership/membership-list";
import type { ParticipantView } from "@backend/actions/participant/participant-view";
import type { ActionResponse } from "keryx";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "../../context/AuthContext";
import { apiFetch } from "../../utils/client";
import { useRead } from "../bots/data";
import type { Entry } from "../transcript/model";

/** A platform participant, as `participant:view` serializes it. */
export type Participant = ActionResponse<ParticipantView>["participant"];

/** What {@link usePeople} hands a page. */
export interface People {
  /** A member's name from their user id ("You" never: their own name). */
  personName: (userId: number | null) => string;
  /** A platform participant's display name from their id. */
  participantName: (participantId: number | null) => string;
  /** The name to put on a message: the participant's when it has one, else the member's. */
  speakerName: (who: {
    userId: number | null;
    participantId: number | null;
  }) => string;
}

/**
 * The names of everyone who wrote in a conversation: members from the
 * project's memberships, and platform participants read one by one with
 * `participant:view` the first time an entry names them. A name not read
 * yet, or not readable, falls back to a neutral word.
 * @param projectId - The project, or `null`.
 * @param entries - The conversation's entries.
 * @returns See {@link People}.
 */
export function usePeople(
  projectId: number | null,
  entries: readonly Entry[],
): People {
  const { user } = useAuth();
  const members = useRead<ActionResponse<MembershipList>>(
    projectId ? `/project/${projectId}/members?limit=100` : null,
  );
  const [participants, setParticipants] = useState<Map<number, string>>(
    () => new Map(),
  );

  const wanted = useMemo(() => {
    const ids = new Set<number>();
    for (const e of entries) if (e.participantId) ids.add(e.participantId);
    return [...ids].sort((a, b) => a - b).join(",");
  }, [entries]);

  useEffect(() => {
    if (!projectId || !wanted) return;
    let cancelled = false;
    const missing = wanted
      .split(",")
      .map(Number)
      .filter((id) => !participants.has(id));
    if (missing.length === 0) return;
    Promise.all(
      missing.map((id) =>
        apiFetch<{ participant: Participant }>(
          `/project/${projectId}/participant/${id}`,
        )
          .then((res) => [id, res.participant.displayName] as const)
          .catch(() => [id, "Someone on the platform"] as const),
      ),
    ).then((found) => {
      if (cancelled) return;
      setParticipants((was) => {
        const next = new Map(was);
        for (const [id, name] of found) next.set(id, name);
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [projectId, wanted, participants]);

  const personName = useCallback(
    (userId: number | null) => {
      if (userId === null) return "Someone";
      if (userId === user?.id) return user.name;
      return (
        members.data?.memberships.find((m) => m.user.id === userId)?.user
          .name ?? "A member"
      );
    },
    [members.data, user],
  );
  const participantName = useCallback(
    (participantId: number | null) =>
      participantId === null
        ? "Someone"
        : (participants.get(participantId) ?? "Someone on the platform"),
    [participants],
  );
  const speakerName = useCallback(
    (who: { userId: number | null; participantId: number | null }) =>
      who.participantId !== null
        ? participantName(who.participantId)
        : personName(who.userId),
    [participantName, personName],
  );
  return { personName, participantName, speakerName };
}
