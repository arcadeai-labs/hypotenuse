import type { InviteListPending } from "@backend/actions/invite/invite-list-pending";
import type { ActionResponse } from "keryx";
import { Menu } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
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
  chatCommands,
  commandDeniedReason,
} from "../commands/registry";
import { useAuth } from "../context/AuthContext";
import { useNotifications } from "../context/NotificationContext";
import { useTheme } from "../context/ThemeContext";
import { useMay } from "../hooks/useMay";
import { Mark, Sheet } from "../ui";
import { CommandPalette } from "../ui/CommandPalette";
import { ShortcutSheet } from "../ui/ShortcutSheet";
import { apiFetch } from "../utils/client";
import { Sidebar } from "./shell/Sidebar";
import {
  NOT_SIGNED_IN,
  type ShellActions,
  type ShellData,
} from "./shell/shellData";
import { VerifyEmailBanner } from "./VerifyEmailBanner";

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
 * How many invitations are waiting for the signed-in person, re-read when the
 * person or the page changes (accepting one is a page away).
 * @param userId - Who is signed in, or null.
 * @param pathname - The current route, so leaving `/invites` re-reads.
 * @returns The count, zero while unknown.
 */
function usePendingInviteCount(
  userId: number | null,
  pathname: string,
): number {
  const [count, setCount] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `pathname` is the re-read trigger.
  useEffect(() => {
    if (userId === null) {
      setCount(0);
      return;
    }
    let cancelled = false;
    apiFetch<ActionResponse<InviteListPending>>("/invites/pending?limit=1")
      .then((res) => {
        if (!cancelled) setCount(res.pagination.total);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [userId, pathname]);
  return count;
}

/**
 * How many of something wait on a person in the active project — tool calls
 * for approval, requests for help — among the bots the person may read: a
 * list's `total` for one row. Re-read when the project or the page changes,
 * and when a notification arrives, since a new one notifies whoever may act.
 * @param projectId - The active project, or null.
 * @param route - The list beneath the project, e.g. `approvals`.
 * @param pathname - The current route, so acting on one and leaving re-reads.
 * @param unread - The unread notification count, as a re-read trigger.
 * @returns The count, zero while unknown.
 */
function usePendingCount(
  projectId: number | null,
  route: "approvals" | "help",
  pathname: string,
  unread: number,
): number {
  const [count, setCount] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `pathname` and `unread` are re-read triggers.
  useEffect(() => {
    if (projectId === null) {
      setCount(0);
      return;
    }
    let cancelled = false;
    apiFetch<{ pagination: { total: number } }>(
      `/project/${projectId}/${route}?status=pending&limit=1`,
    )
      .then((res) => {
        if (!cancelled) setCount(res.pagination.total);
      })
      .catch(() => {
        if (!cancelled) setCount(0);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, route, pathname, unread]);
  return count;
}

/**
 * The active project's bots, for the palette's "Chat with …" commands: read
 * when the palette opens, so a closed palette costs nothing.
 * @param projectId - The project, or null while there is nothing to read.
 * @returns The bots, empty while unknown.
 */
function useChatBots(
  projectId: number | null,
): { id: number; name: string; slug: string }[] {
  const [bots, setBots] = useState<
    { id: number; name: string; slug: string }[]
  >([]);
  useEffect(() => {
    if (projectId === null) return;
    let cancelled = false;
    apiFetch<{ bots: { id: number; name: string; slug: string }[] }>(
      `/project/${projectId}/bots?limit=100`,
    )
      .then((res) => {
        if (!cancelled) setBots(res.bots);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [projectId]);
  return bots;
}

/**
 * The product's frame: sidebar, main column, command palette, shortcut sheet,
 * and the one global key listener. The switchers and account menu read the
 * session; every gated control asks `can()` through {@link useMay}, so it
 * matches what the server enforces. Below 768px the sidebar lives in a sheet
 * behind a top bar's menu button. It is mounted in exactly one place at a time,
 * so its test ids never resolve twice.
 * @returns The shell around the routed page.
 */
export function AppShell() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { setPreference } = useTheme();
  const auth = useAuth();
  const { may, reason } = useMay();
  const pendingInvites = usePendingInviteCount(auth.user?.id ?? null, pathname);
  const { unreadCount } = useNotifications();
  const pendingApprovals = usePendingCount(
    auth.user ? auth.activeProjectId : null,
    "approvals",
    pathname,
    unreadCount,
  );
  const pendingHelp = usePendingCount(
    auth.user ? auth.activeProjectId : null,
    "help",
    pathname,
    unreadCount,
  );
  const counts = useMemo(
    () => ({ approvals: pendingApprovals, help: pendingHelp }),
    [pendingApprovals, pendingHelp],
  );

  const data: ShellData = useMemo(
    () => ({
      organizations: auth.organizations.map((o) => ({
        id: o.id,
        name: o.name,
      })),
      activeOrganizationId: auth.activeOrganizationId,
      projects: auth.projects.map((p) => ({ id: p.id, name: p.name })),
      activeProjectId: auth.activeProjectId,
      user: auth.user ? { name: auth.user.name, email: auth.user.email } : null,
    }),
    [
      auth.organizations,
      auth.activeOrganizationId,
      auth.projects,
      auth.activeProjectId,
      auth.user,
    ],
  );
  const { setActiveOrganization, setActiveProject, signOut } = auth;
  const actions: ShellActions = useMemo(
    () => ({
      selectOrganization: (id) => void setActiveOrganization(id),
      selectProject: setActiveProject,
      signOut: () => {
        void signOut().then(() => navigate("/sign-in"));
      },
      newProjectDenied: reason("project:create"),
      // Anyone signed in may start an organization.
      newOrganizationDenied: auth.user ? undefined : NOT_SIGNED_IN,
      auditLogDenied: reason("audit:list"),
      organizationAuditDenied: reason("organization:audit-list"),
      pendingInvites,
    }),
    [
      setActiveOrganization,
      setActiveProject,
      signOut,
      navigate,
      reason,
      pendingInvites,
      auth.user,
    ],
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
      reason,
      pathname,
    }),
    [navigate, setPreference, toggleSidebar, may, reason, pathname],
  );
  const commands = useMemo(() => availableCommands(COMMANDS, ctx), [ctx]);
  const chatBots = useChatBots(
    auth.user && paletteOpen ? auth.activeProjectId : null,
  );
  // The palette also offers a chat with each bot; the keymap never does.
  const paletteCommands = useMemo(
    () => [...commands, ...chatCommands(chatBots)],
    [commands, chatBots],
  );
  const deniedReason = useCallback(
    (command: Command) => commandDeniedReason(command, ctx),
    [ctx],
  );
  // A refused command is drawn in the palette but never dispatched by a key.
  const runnable = useMemo(
    () => commands.filter((command) => !deniedReason(command)),
    [commands, deniedReason],
  );
  const run = useCallback((command: Command) => command.run(ctx), [ctx]);

  // The matcher keeps a key buffer across renders; rebuild it only when the
  // command set changes, and read the latest context through a ref.
  const matcher = useMemo(() => createSequenceMatcher(runnable), [runnable]);
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
            data={data}
            actions={actions}
            collapsed={false}
            counts={counts}
            inSheet
            onToggle={() => setMobileNavOpen(false)}
            onNavigate={() => setMobileNavOpen(false)}
          />
        </Sheet>
      ) : (
        <div className="shell-sidebar-slot">
          <Sidebar
            data={data}
            actions={actions}
            collapsed={collapsed}
            counts={counts}
            onToggle={toggleSidebar}
          />
        </div>
      )}
      <main className="shell-main">
        <VerifyEmailBanner />
        <Outlet />
      </main>
      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        commands={paletteCommands}
        onRun={run}
        deniedReason={deniedReason}
      />
      <ShortcutSheet
        open={shortcutsOpen}
        onClose={() => setShortcutsOpen(false)}
        commands={commands}
      />
    </div>
  );
}
