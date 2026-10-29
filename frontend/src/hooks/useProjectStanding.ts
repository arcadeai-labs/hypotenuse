import { useAuth } from "../context/AuthContext";
import { useStanding } from "../context/StandingContext";
import {
  NO_PROJECT_STANDING,
  type ProjectStanding,
} from "../utils/permissions";

/**
 * The caller's standing in the active project, as `project:view` decides it.
 *
 * `null` means **unknown** — the session is still hydrating, or the answer for
 * this project is in flight — and is never read as a denial. With no active
 * project at all (an organization that shows the caller none) the answer is
 * known: a member of nothing.
 * @returns The standing, or `null` while unknown.
 */
export function useProjectStanding(): ProjectStanding | null {
  const { loading, user, activeProjectId } = useAuth();
  const { projectView } = useStanding();
  if (loading) return null;
  if (!user || activeProjectId === null) return NO_PROJECT_STANDING;
  return projectView?.standing ?? null;
}
