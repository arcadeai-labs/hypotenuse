/**
 * The shapes the shell's switchers and account menu read. They take these as
 * props rather than reading the session themselves, so `AppShell` is the one
 * place live data is mapped onto them.
 */

/** An organization the person belongs to. */
export interface ShellOrganization {
  id: number;
  name: string;
}

/** A project inside the active organization that the person can see. */
export interface ShellProject {
  id: number;
  name: string;
}

/** The person signed in. */
export interface ShellUser {
  name: string;
  email: string;
}

/** Everything the shell's switchers and account menu show. */
export interface ShellData {
  organizations: ShellOrganization[];
  activeOrganizationId: number | null;
  projects: ShellProject[];
  activeProjectId: number | null;
  user: ShellUser | null;
}

/** What the switchers and the account menu can do, and what they may not. */
export interface ShellActions {
  /** Make an organization active. */
  selectOrganization: (organizationId: number) => void;
  /** Make a project of the active organization active. */
  selectProject: (projectId: number) => void;
  /** End the session. */
  signOut: () => void;
  /**
   * Why "New project" is refused, or `undefined` when it is offered. Read
   * from `can("project:create")`, so it is the server's answer.
   */
  newProjectDenied?: string;
  /** Why "New organization" is refused (signed out), or `undefined`. */
  newOrganizationDenied?: string;
  /** Why the active project's audit log is refused, from `can("audit:list")`. */
  auditLogDenied?: string;
  /** Why the organization's audit log is refused, from `can("organization:audit-list")`. */
  organizationAuditDenied?: string;
  /** How many invitations are waiting for the person, for the account menu. */
  pendingInvites?: number;
}

/** What a signed-out shell's person-scoped controls say. */
export const NOT_SIGNED_IN = "Not signed in";
