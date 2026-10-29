/** A person's standing in one project, as the server answers it. */
export interface ProjectStanding {
  isMember: boolean;
  isAdmin: boolean;
  viaOrganizationOwner: boolean;
}

/** How a project's row names the reader's role in it. */
export interface ProjectRole {
  /** The badge's text. */
  label: string;
  /** Whether it is admin standing, for the badge's tone. */
  admin: boolean;
  /** The badge's title: where the standing comes from. */
  title: string;
}

/**
 * Name the reader's role in a project from the server's standing. An owner's
 * admin standing is named as such, because it comes from the organization, not
 * from anything in the project's own member list.
 * @param standing - `standing` from `project:list` or `project:view`.
 * @returns The label, tone, and explanation.
 */
export function projectRole(standing: ProjectStanding): ProjectRole {
  if (standing.viaOrganizationOwner) {
    return {
      label: "Admin (owner)",
      admin: true,
      title:
        "You own this organization, which makes you an admin of every project in it.",
    };
  }
  if (standing.isAdmin) {
    return {
      label: "Admin",
      admin: true,
      title: "You hold this project's admin tag.",
    };
  }
  return {
    label: "Member",
    admin: false,
    title: "You are a member of this project.",
  };
}
