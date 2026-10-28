import { useAuth } from "../context/AuthContext";
import { useStanding } from "../context/StandingContext";
import {
  NO_ORGANIZATION_STANDING,
  type OrganizationStanding,
} from "../utils/permissions";

/**
 * The caller's standing in the active organization, as `organization:view`
 * decides it.
 *
 * `null` means **unknown** — still hydrating, or the answer for this
 * organization is in flight — and is never read as a denial. Signed out, or
 * with no organization at all, the answer is known: a member of nothing.
 * @returns The standing, or `null` while unknown.
 */
export function useOrganizationStanding(): OrganizationStanding | null {
  const { loading, user, activeOrganizationId } = useAuth();
  const { organizationView } = useStanding();
  if (loading) return null;
  if (!user || activeOrganizationId === null) return NO_ORGANIZATION_STANDING;
  return organizationView?.standing ?? null;
}
