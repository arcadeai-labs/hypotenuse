import { useOutletContext } from "react-router-dom";
import type { OrganizationViewResponse } from "../../context/StandingContext";
import type { OrganizationStanding } from "../../utils/permissions";

/** The organization as `organization:view` returns it. */
export type Organization = OrganizationViewResponse["organization"];

/**
 * What the organization pages share, through the router's outlet context. The
 * frame holds it back until `organization:view` has answered for the active
 * organization, so a page never renders against a guessed standing.
 */
export interface OrganizationContext {
  organizationId: number;
  organization: Organization;
  /** The caller's standing, as `organization:view` decided it. */
  standing: OrganizationStanding;
  /** `can()` bound to the active standings. */
  may: (actionName: string) => boolean;
  /** Why an action is refused, or `undefined` — a disabled control's `title`. */
  reason: (actionName: string) => string | undefined;
  /** Re-read `organization:view`. */
  reloadOrganization: () => Promise<void>;
}

/**
 * The organization context, typed.
 * @returns What the frame provided.
 */
export function useOrganization(): OrganizationContext {
  return useOutletContext<OrganizationContext>();
}

/** The organization pages, in sidebar order. */
export const ORGANIZATION_SECTIONS = [
  { slug: "projects", label: "Projects", group: "Organization" },
  { slug: "members", label: "Members", group: "Organization" },
  { slug: "settings", label: "Settings", group: "Organization" },
  { slug: "audit", label: "Audit log", group: "Organization" },
] as const;
