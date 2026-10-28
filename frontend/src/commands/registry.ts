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
   * `can()` bound to the active project's standing: whether the person may run
   * an action. False for everything until there is a standing to read, so a
   * gated command is hidden rather than offered and refused.
   */
  may: (actionName: string) => boolean;
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
  /** Hidden, and not dispatched, when this returns false. Gated commands ask `ctx.may()`. */
  when?: (ctx: CommandContext) => boolean;
  run: (ctx: CommandContext) => void;
}

/**
 * Every command. A destination's `g` command exists only while its page does,
 * so a shortcut never lands on a page that is not there; gated commands carry
 * a `when` that asks `ctx.may()`.
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
