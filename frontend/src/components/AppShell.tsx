import { Menu } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Outlet, useNavigate } from "react-router-dom";
import {
  createSequenceMatcher,
  isTypingTarget,
  keyName,
} from "../commands/keymap";
import {
  availableCommands,
  COMMANDS,
  type Command,
  type CommandContext,
} from "../commands/registry";
import { useAuth } from "../context/AuthContext";
import { useTheme } from "../context/ThemeContext";
import { useProjectStanding } from "../hooks/useProjectStanding";
import { Mark, Sheet } from "../ui";
import { CommandPalette } from "../ui/CommandPalette";
import { ShortcutSheet } from "../ui/ShortcutSheet";
import { can } from "../utils/permissions";
import { Sidebar } from "./shell/Sidebar";

/** localStorage key for the collapsed sidebar. */
export const SIDEBAR_STORAGE_KEY = "hypotenuse.sidebar";

/**
 * Read whether the sidebar was left collapsed.
 * @returns True if collapsed.
 */
function readCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_STORAGE_KEY) === "collapsed";
  } catch {
    return false;
  }
}

/** Below this width the sidebar moves into a sheet. */
const NARROW_QUERY = "(max-width: 767.98px)";

/**
 * Whether the viewport is narrow, following resizes.
 * @returns True below 768px.
 */
function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(
    () => window.matchMedia(NARROW_QUERY).matches,
  );
  useEffect(() => {
    const query = window.matchMedia(NARROW_QUERY);
    const onChange = (event: MediaQueryListEvent) => setNarrow(event.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return narrow;
}

/**
 * The signed-in frame: sidebar, main column, command palette, shortcut sheet,
 * and the one global key listener. It renders inside `ProtectedRoute`, so a
 * session always exists here. Below 768px the sidebar lives in a sheet
 * behind a top bar's menu button. It is mounted in exactly one place at a time,
 * so its test ids never resolve twice.
 * @returns The shell around the routed page.
 */
export function AppShell() {
  const navigate = useNavigate();
  const { setPreference } = useTheme();
  const { permissions } = useAuth();
  const standing = useProjectStanding();
  const may = useCallback(
    (actionName: string) =>
      standing !== null && can(permissions, actionName, standing),
    [permissions, standing],
  );
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const narrow = useNarrow();

  const toggleSidebar = useCallback(() => {
    setCollapsed((was) => {
      try {
        localStorage.setItem(
          SIDEBAR_STORAGE_KEY,
          was ? "expanded" : "collapsed",
        );
      } catch {
        // Unavailable storage only costs persistence.
      }
      return !was;
    });
  }, []);

  const ctx: CommandContext = useMemo(
    () => ({
      navigate,
      setTheme: setPreference,
      toggleSidebar,
      showShortcuts: () => setShortcutsOpen(true),
      focusSearch: () =>
        document.querySelector<HTMLElement>("[data-search]")?.focus(),
      may,
    }),
    [navigate, setPreference, toggleSidebar, may],
  );
  const commands = useMemo(() => availableCommands(COMMANDS, ctx), [ctx]);
  const run = useCallback((command: Command) => command.run(ctx), [ctx]);

  // The matcher keeps a key buffer across renders; rebuild it only when the
  // command set changes, and read the latest context through a ref.
  const matcher = useMemo(() => createSequenceMatcher(commands), [commands]);
  const runRef = useRef(run);
  runRef.current = run;
  const overlayOpen = paletteOpen || shortcutsOpen || (narrow && mobileNavOpen);

  useEffect(() => {
    /**
     * The global keymap. Typing in a field, or any key while an overlay owns
     * the keyboard, is left alone — except ⌘K, which always toggles the palette.
     * @param event - The key event.
     */
    function onKey(event: KeyboardEvent): void {
      const name = keyName(event);
      if (!name) return;
      if (name === "mod+k") {
        event.preventDefault();
        setPaletteOpen((v) => !v);
        return;
      }
      if (
        overlayOpen ||
        isTypingTarget(event.target) ||
        name.startsWith("mod+")
      )
        return;
      const command = matcher.press(name);
      if (command) {
        event.preventDefault();
        runRef.current(command);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [matcher, overlayOpen]);

  return (
    <div className="shell" data-testid="app-shell" data-collapsed={collapsed}>
      <div className="shell-topbar">
        <button
          type="button"
          className="shell-icon-button"
          data-testid="sidebar-open"
          aria-label="Open navigation"
          onClick={() => setMobileNavOpen(true)}
        >
          <Menu size={16} aria-hidden="true" />
        </button>
        <Mark size={16} label={null} className="shell-brand-mark" />
        <span className="shell-brand-name">Hypotenuse</span>
      </div>
      {narrow ? (
        <Sheet
          open={mobileNavOpen}
          onClose={() => setMobileNavOpen(false)}
          side="left"
          className="shell-sidebar-sheet"
          aria-label="Navigation"
        >
          <Sidebar
            collapsed={false}
            onToggle={() => setMobileNavOpen(false)}
            onNavigate={() => setMobileNavOpen(false)}
          />
        </Sheet>
      ) : (
        <div className="shell-sidebar-slot">
          <Sidebar collapsed={collapsed} onToggle={toggleSidebar} />
        </div>
      )}
      <main className="shell-main">
        <Outlet />
      </main>
      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        commands={commands}
        onRun={run}
      />
      <ShortcutSheet
        open={shortcutsOpen}
        onClose={() => setShortcutsOpen(false)}
        commands={commands}
      />
    </div>
  );
}
