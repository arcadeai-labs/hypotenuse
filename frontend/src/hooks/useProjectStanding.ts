import type { ProjectView } from "@backend/actions/project/project-view";
import type { ActionResponse } from "keryx";
import { useEffect, useState } from "react";
import { useAuth } from "../context/AuthContext";
import { apiFetch } from "../utils/client";
import type { ProjectStanding } from "../utils/permissions";

/**
 * The caller's standing in the active project, as `project:view` decides it,
 * for chrome that gates on `can()` outside any one page — the command palette.
 *
 * `null` until the server answers, and again while a new project's answer is in
 * flight: a stale standing from the previous project would offer that
 * project's admin commands in this one.
 * @returns The standing, or `null` while unknown.
 */
export function useProjectStanding(): ProjectStanding | null {
  const { user, activeProjectId } = useAuth();
  const [standing, setStanding] = useState<ProjectStanding | null>(null);

  useEffect(() => {
    setStanding(null);
    if (!user || !activeProjectId) return;
    let cancelled = false;
    apiFetch<ActionResponse<ProjectView>>(
      `/project?projectId=${activeProjectId}`,
    )
      .then((view) => {
        if (!cancelled) setStanding(view.standing);
      })
      .catch(() => {
        // Unknown standing hides gated commands, which is the safe answer.
      });
    return () => {
      cancelled = true;
    };
  }, [user, activeProjectId]);

  return standing;
}
