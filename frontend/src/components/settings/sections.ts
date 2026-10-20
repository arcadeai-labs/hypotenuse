import type { Permissions } from "../../context/AuthContext";
import { can, type ProjectStanding } from "../../utils/permissions";

/** Which heading a settings section sits under in the sidebar. */
export type SettingsGroup =
  | "Project"
  | "People"
  | "Execution"
  | "Connections"
  | "Danger zone";

/** One entry in the settings sidebar. */
export interface SettingsSection {
  /** The URL segment: `/settings/<slug>`. */
  slug: string;
  /** What the sidebar calls it. */
  label: string;
  /** The heading it sits under. */
  group: SettingsGroup;
  /**
   * The action whose permission this section's **data** needs, or `null` when
   * every member of the project may read it.
   *
   * An action name and never an RBAC level, because the level is the backend's
   * answer: `can()` reads it out of `actions:permissions`, so moving
   * `connection:list` from admin to member ships with no frontend change. That is
   * the same bargain `can()` itself makes, applied one level up.
   *
   * The field exists at all because three of these endpoints are
   * `AdminMiddleware`-gated, and asking for one as a plain member produces a 403
   * with nothing the reader can do about it. A section that declares a read action
   * it does not hold renders its own "admins only" notice and **issues no
   * request**.
   */
  readAction: string | null;
}

/**
 * The settings sidebar, in order.
 *
 * This is the merge of what used to be two pages — `/project` (name, MCP endpoint,
 * tags, members, delete) and `/settings` (sandbox, connections, ledger) — which
 * between them held one monolithic loader and one page-level alert each. It is the
 * same shape as the agent editor's `EDITOR_SECTIONS` and the same reasons apply:
 * one section mounted at a time, each owning its own draft and its own alerts.
 *
 * Two naming choices are deliberate. `ledger` rather than `sandboxes`, because
 * `sandbox` and `sandboxes` differing by one character is a route somebody will
 * misread. And `general` rather than `project`, so `/settings/project` is not
 * sitting one prefix away from the `/project` redirect that still serves old
 * bookmarks.
 *
 * There is no `countProblemsBySection` analogue here, and there should not be: a
 * project has no `validate` action, so `SectionNav`'s `problemCounts` simply goes
 * unused on this side.
 */
export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  { slug: "general", label: "General", group: "Project", readAction: null },
  { slug: "mcp", label: "MCP endpoint", group: "Project", readAction: null },
  { slug: "members", label: "Members", group: "People", readAction: null },
  { slug: "tags", label: "Tags", group: "People", readAction: null },
  { slug: "sandbox", label: "Sandbox", group: "Execution", readAction: null },
  {
    slug: "ledger",
    label: "Sandbox ledger",
    group: "Execution",
    readAction: "sandbox:list",
  },
  {
    slug: "model",
    label: "Model",
    group: "Connections",
    readAction: "connection:list",
  },
  {
    // The GitHub App repositories are cloned and pushed through. Named for what
    // it is rather than for "everything else": the model accounts have their own
    // section and the sandbox account is configured on Sandbox, beside the
    // provider that needs it. Linear and Google used to share this drawer when
    // they were context providers; they come from MCP servers now.
    slug: "git-providers",
    label: "Git providers",
    group: "Connections",
    readAction: "connection:list",
  },
  {
    slug: "danger",
    label: "Danger zone",
    group: "Danger zone",
    readAction: null,
  },
] as const;

/**
 * The section shown when a URL names none — and the target of the index route.
 *
 * It is deliberately one every member can read: signup, sign-in, the project
 * switcher, and the homepage CTA all land here, so a default that answered
 * "admins only" would make every plain member's landing page a dead end.
 */
export const DEFAULT_SETTINGS_SECTION = "general";

/**
 * Whether the caller may read a section's data.
 *
 * Answers `false` while `permissions` is still `null`, which is `can()`'s own
 * "assume it is gated" rule — a section that fetched on the strength of a
 * not-yet-loaded permission map would 403 on first paint. A non-member reads
 * nothing at all, even where `readAction` is `null`, because every one of these
 * endpoints is project-scoped.
 * @param section - The section in question.
 * @param permissions - The map from `actions:permissions` (null while loading).
 * @param standing - The caller's standing in the project on screen.
 * @returns Whether to fetch, rather than whether to render: the section renders
 * either way, and says which it is.
 */
export function canReadSection(
  section: SettingsSection,
  permissions: Permissions | null,
  standing: ProjectStanding,
): boolean {
  if (!standing.isMember) return false;
  if (section.readAction === null) return true;
  return can(permissions, section.readAction, standing);
}
