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
}

/**
 * One command. The palette lists it, the shortcut sheet shows its `shortcut`,
 * and the keymap dispatches it — three consumers of one row, so none can drift.
 */
export interface Command {
  id: string;
  title: string;
  /** Palette group heading. */
  group: "Navigation" | "Theme" | "View";
  keywords?: string[];
  /** A key sequence as the keymap reads it: `"g s"`, `"?"`, `"["`, `"mod+k"`. */
  shortcut?: string;
  /** Hidden, and not dispatched, when this returns false. Later commands gate on `can()`. */
  when?: (ctx: CommandContext) => boolean;
  run: (ctx: CommandContext) => void;
}

/** The commands that exist before anything is signed in or loaded. */
export const COMMANDS: Command[] = [
  {
    id: "go-home",
    title: "Go to Home",
    group: "Navigation",
    shortcut: "g h",
    run: (c) => c.navigate("/home"),
  },
  {
    id: "go-sessions",
    title: "Go to Sessions",
    group: "Navigation",
    shortcut: "g s",
    run: (c) => c.navigate("/sessions"),
  },
  {
    id: "go-runners",
    title: "Go to Runners",
    group: "Navigation",
    shortcut: "g r",
    run: (c) => c.navigate("/runners"),
  },
  {
    id: "go-routing",
    title: "Go to Routing",
    group: "Navigation",
    shortcut: "g o",
    run: (c) => c.navigate("/routing"),
  },
  {
    id: "go-settings",
    title: "Go to Settings",
    group: "Navigation",
    run: (c) => c.navigate("/settings"),
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
    run: (c) => c.navigate("/style-guide"),
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
