/**
 * What the shell shows until there are organizations, projects, and people to
 * read: one organization holding two projects, and nobody signed in. The
 * switchers and the account menu take these shapes as props, so real data
 * replaces this file without touching them.
 */

/** An organization the person belongs to. */
export interface ShellOrganization {
  id: number;
  name: string;
  /** Whether the person owns it — owners see "New project". */
  owner: boolean;
}

/** A project inside the active organization. */
export interface ShellProject {
  id: number;
  name: string;
}

/** The person signed in. */
export interface ShellUser {
  name: string;
  email: string;
}

/** Everything the shell's switchers and account menu read. */
export interface ShellData {
  organizations: ShellOrganization[];
  activeOrganizationId: number | null;
  projects: ShellProject[];
  activeProjectId: number | null;
  user: ShellUser | null;
}

/** The fixture the shell renders today. */
export const SHELL_FIXTURE: ShellData = {
  organizations: [{ id: 1, name: "Acme", owner: true }],
  activeOrganizationId: 1,
  projects: [
    { id: 1, name: "Support" },
    { id: 2, name: "Platform" },
  ],
  activeProjectId: 1,
  user: null,
};
