import { DESTINATIONS } from "../components/shell/destinations";
import type { ThemePreference } from "../context/ThemeContext";

/** What a command can see when deciding whether it applies and when it runs. */
export interface CommandContext {
  navigate: (to: string) => void;
  setTheme: (preference: ThemePreference) => void;
  /** Toggle the sidebar between full width and icons. */
  toggleSidebar: () => void;
  /** Open the shortcut sheet. */
  showShortcuts: () => void;
  /** Focus the current page's search field, if it has one. */
  focusSearch: () => void;
  /**
   * `can()` bound to the active project's and organization's standing: whether
   * the person may run an action. A standing still in flight is not a refusal,
   * so this answers true until the server has said otherwise.
   */
  may: (actionName: string) => boolean;
  /** Why an action is refused, or `undefined` when it is not — `useMay().reason`. */
  reason: (actionName: string) => string | undefined;
  /** The current route's path, for commands that act on the page on screen. */
  pathname?: string;
}

/**
 * One command. The palette lists it, the shortcut sheet shows its `shortcut`,
 * and the keymap dispatches it — three consumers of one row, so none can drift.
 */
export interface Command {
  id: string;
  title: string;
  /** Palette group heading. */
  group: "Navigation" | "Project" | "Theme" | "View";
  keywords?: string[];
  /** A key sequence as the keymap reads it: `"g s"`, `"?"`, `"["`, `"mod+k"`. */
  shortcut?: string;
  /** Hidden, and not dispatched, when this returns false — for a command whose page does not exist. */
  when?: (ctx: CommandContext) => boolean;
  /**
   * The actions the person must be allowed to run for this command to do
   * anything. A refused command is listed **disabled**, with the reason, rather
   * than hidden: disabled, never absent. See {@link commandDeniedReason}.
   */
  requires?: string[];
  run: (ctx: CommandContext) => void;
}

/**
 * Every command. A destination's `g` command exists only while its page does,
 * so a shortcut never lands on a page that is not there; a command the person
 * may not run names the actions it needs in `requires`, and is drawn disabled.
 */
export const COMMANDS: Command[] = [
  ...DESTINATIONS.map(
    (destination): Command => ({
      id: `go-${destination.id}`,
      title: `Go to ${destination.label}`,
      group: "Navigation",
      shortcut: destination.shortcut,
      when: () => destination.available,
      run: (c) => c.navigate(destination.to),
    }),
  ),
  {
    id: "invite-member",
    title: "Invite member",
    group: "Project",
    keywords: ["people", "add", "email", "team"],
    // `invite:create` alone is any organization member; inviting into a
    // project is a project admin's, which is what reading its invites takes.
    requires: ["invite:create", "invite:list"],
    run: (c) => c.navigate("/settings/members#invite"),
  },
  {
    id: "new-project",
    title: "New project",
    group: "Project",
    keywords: ["create", "add"],
    requires: ["project:create"],
    run: (c) => c.navigate("/projects/new"),
  },
  {
    id: "new-organization",
    title: "New organization",
    group: "Project",
    keywords: ["create", "add", "company", "team"],
    requires: ["organization:create"],
    run: (c) => c.navigate("/organizations/new"),
  },
  {
    id: "go-docs",
    title: "Open docs",
    group: "Navigation",
    keywords: ["help"],
    run: (c) => c.navigate("/docs"),
  },
  {
    id: "go-style-guide",
    title: "Open style guide",
    group: "Navigation",
    run: (c) => c.navigate("/docs/style-guide"),
  },
  {
    id: "theme-light",
    title: "Theme: Light",
    group: "Theme",
    keywords: ["appearance"],
    run: (c) => c.setTheme("light"),
  },
  {
    id: "theme-dark",
    title: "Theme: Dark",
    group: "Theme",
    keywords: ["appearance"],
    run: (c) => c.setTheme("dark"),
  },
  {
    id: "theme-system",
    title: "Theme: System",
    group: "Theme",
    keywords: ["appearance", "auto"],
    run: (c) => c.setTheme("system"),
  },
  {
    id: "toggle-sidebar",
    title: "Toggle sidebar",
    group: "View",
    shortcut: "[",
    run: (c) => c.toggleSidebar(),
  },
  {
    id: "search",
    title: "Search",
    group: "View",
    shortcut: "/",
    run: (c) => c.focusSearch(),
  },
  {
    id: "shortcuts",
    title: "Keyboard shortcuts",
    group: "View",
    shortcut: "?",
    keywords: ["help", "keys"],
    run: (c) => c.showShortcuts(),
  },
];

/**
 * The commands that apply right now.
 * @param commands - The registry.
 * @param ctx - The current context.
 * @returns Commands whose `when` passes (or that have none).
 */
export function availableCommands(
  commands: Command[],
  ctx: CommandContext,
): Command[] {
  return commands.filter((command) => !command.when || command.when(ctx));
}

/**
 * Why a command is refused, from the first of its `requires` the person may
 * not run, or `undefined` when it is offered.
 * @param command - The command.
 * @param ctx - The current context.
 * @returns The refusal's reason, or undefined.
 */
export function commandDeniedReason(
  command: Command,
  ctx: CommandContext,
): string | undefined {
  for (const action of command.requires ?? []) {
    const reason = ctx.reason(action);
    if (reason) return reason;
  }
  return undefined;
}
