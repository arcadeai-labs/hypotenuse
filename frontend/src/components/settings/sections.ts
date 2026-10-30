/** Which heading a settings section sits under in the sidebar. */
export type SettingsGroup = "Project" | "People" | "Irreversible";

/** One entry in the settings sidebar. */
export interface SettingsSection {
  /** The URL segment: `/settings/<slug>`. */
  slug: string;
  /** What the sidebar calls it. */
  label: string;
  /** The heading it sits under. */
  group: SettingsGroup;
}

/**
 * The project settings sidebar, in order. Every member can read every one of
 * them; the controls inside are what admin standing gates.
 */
export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  { slug: "general", label: "General", group: "Project" },
  { slug: "models", label: "Models", group: "Project" },
  { slug: "mcp-servers", label: "MCP servers", group: "Project" },
  { slug: "members", label: "Members", group: "People" },
  { slug: "tags", label: "Tags", group: "People" },
  { slug: "danger", label: "Danger zone", group: "Irreversible" },
] as const;

/** The section `/settings` opens, readable by every member. */
export const DEFAULT_SETTINGS_SECTION = "general";
