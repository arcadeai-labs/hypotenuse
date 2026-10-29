import type { ActionsPermissions } from "@backend/actions/actions-permissions";
import type { RbacLevel } from "@backend/middleware/rbac";
import type { ActionResponse } from "keryx";

/** The action → requirement map, as `actions:permissions` reports it. */
export type Permissions = ActionResponse<ActionsPermissions>["permissions"];

/** What the caller is within the project on screen, as `project:view` decides it. */
export interface ProjectStanding {
  /** They hold a membership in it, or own its organization. */
  isMember: boolean;
  /** They hold its reserved `admin` tag, or own its organization. */
  isAdmin: boolean;
  /** Their admin standing comes from owning the organization, not a grant. */
  viaOrganizationOwner?: boolean;
}

/** What the caller is within the organization on screen, as `organization:view` decides it. */
export interface OrganizationStanding {
  /** They hold a membership in it. */
  isMember: boolean;
  /** That membership's role is `owner`. */
  isOwner: boolean;
}

/**
 * Both standings `can()` reads. `null` means **not known yet** — the server has
 * not answered for the active project or organization — which is a different
 * fact from "not a member", and is never turned into a denial.
 */
export interface Standings {
  project: ProjectStanding | null;
  organization: OrganizationStanding | null;
}

/**
 * The three answers to "may they?". `unresolved` is the one that matters: a
 * standing still in flight is not a refusal, so nothing renders one for it.
 */
export type Verdict = "allowed" | "denied" | "unresolved";

/** The standing to read when there is no active project at all — resolved, and a member of nothing. */
export const NO_PROJECT_STANDING: ProjectStanding = {
  isMember: false,
  isAdmin: false,
  viaOrganizationOwner: false,
};

/** The standing to read when there is no active organization at all. */
export const NO_ORGANIZATION_STANDING: OrganizationStanding = {
  isMember: false,
  isOwner: false,
};

/**
 * Decide whether the caller may invoke an action, by asking the backend's own
 * RBAC map what that action requires and comparing it to the standing the
 * server reported.
 *
 * This is the only place the frontend decides what to offer. It never
 * hardcodes "renaming needs admin": it reads `project:edit`'s requirement from
 * `actions:permissions`, which is generated from the very middleware that
 * enforces it. Move an action from admin to member on the backend and this
 * follows with no frontend change. Gating is a courtesy either way; the server
 * is the enforcement.
 * @param permissions - The map from `actions:permissions`, or `null` while loading.
 * @param actionName - The action, e.g. `"tag:create"`.
 * @param standings - The active project's and organization's standing.
 * @returns `allowed`, `denied`, or `unresolved` while the answer needs a standing nobody has reported yet.
 */
export function verdict(
  permissions: Permissions | null,
  actionName: string,
  standings: Standings,
): Verdict {
  if (!permissions) return "unresolved";
  const requirement = permissions[actionName]?.type as RbacLevel | undefined;
  // An action the server does not have is one nobody may run.
  if (!requirement) return "denied";

  const project = standings.project;
  const organization = standings.organization;
  switch (requirement) {
    case "none":
      return "allowed";
    case "member":
      if (!project) return "unresolved";
      return project.isMember ? "allowed" : "denied";
    case "admin":
      if (!project) return "unresolved";
      return project.isAdmin ? "allowed" : "denied";
    case "org-member":
      if (!organization) return "unresolved";
      return organization.isMember ? "allowed" : "denied";
    case "org-owner":
      if (!organization) return "unresolved";
      return organization.isOwner ? "allowed" : "denied";
    default:
      return "denied";
  }
}

/**
 * Whether to offer an action: true unless the server's answer is a refusal.
 *
 * **While standing is unresolved this answers `true`.** A control drawn
 * disabled for the half-second before `project:view` answers, then enabled,
 * is a flash of denial at every admin on every load; and a control that would
 * be refused is refused by the server anyway. Pages that must not offer
 * anything before the answer hold their content back until it arrives.
 * @param permissions - The map from `actions:permissions`, or `null` while loading.
 * @param actionName - The action, e.g. `"tag:create"`.
 * @param standings - The active project's and organization's standing.
 * @returns Whether the control should be enabled.
 */
export function can(
  permissions: Permissions | null,
  actionName: string,
  standings: Standings,
): boolean {
  return verdict(permissions, actionName, standings) !== "denied";
}

/** What a disabled control says about a level it is missing, keyed by the level. */
const REASONS: Record<RbacLevel, string> = {
  none: "Not available.",
  member: "Only members of this project can do this.",
  admin: "Only project admins can do this.",
  "org-member": "Only members of this organization can do this.",
  "org-owner": "Only organization owners can do this.",
};

/**
 * Why an action is refused, in words a disabled control can carry as its
 * `title`. Read off the action's level, so it names what the server checks.
 * @param permissions - The map from `actions:permissions`, or `null` while loading.
 * @param actionName - The action.
 * @returns A sentence naming who may do it.
 */
export function denialReason(
  permissions: Permissions | null,
  actionName: string,
): string {
  const requirement = permissions?.[actionName]?.type as RbacLevel | undefined;
  return requirement ? REASONS[requirement] : REASONS.none;
}
