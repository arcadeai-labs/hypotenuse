import type { ActionsPermissions } from "@backend/actions/actions-permissions";
import type { MeView } from "@backend/actions/me";
import type { OrganizationList } from "@backend/actions/organization/organization-list";
import type { ProjectList } from "@backend/actions/project/project-list";
import type { ActionResponse } from "keryx";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ACTIVE_ORGANIZATION_KEY,
  ACTIVE_PROJECT_KEY,
  pickActive,
  readStoredId,
  writeStoredId,
} from "../utils/activeSelection";
import { apiFetch, isSignedOut } from "../utils/client";
import type { Permissions } from "../utils/permissions";

/** The signed-in user, as `me:view` returns them. */
export type AuthUser = ActionResponse<MeView>["user"];
/** An organization the user belongs to, with their standing, as `organization:list` returns it. */
export type AuthOrganization =
  ActionResponse<OrganizationList>["organizations"][number];
/** A project of the active organization the user can see, as `project:list` returns it. */
export type AuthProject = ActionResponse<ProjectList>["projects"][number];

/** Everything the app knows about the session and what is selected. */
export interface AuthState {
  /** The signed-in user, or `null` when signed out. */
  user: AuthUser | null;
  /** Every organization the user belongs to. */
  organizations: AuthOrganization[];
  /** The selected organization's id, or `null` when there is none. */
  activeOrganizationId: number | null;
  /** The projects of the active organization the user can see. */
  projects: AuthProject[];
  /** The selected project's id, or `null` when the organization shows none. */
  activeProjectId: number | null;
  /** The RBAC map the backend reports — server truth for UI gating. */
  permissions: Permissions | null;
  /** True until the first hydration settles. */
  loading: boolean;
  /** Select an organization; its projects are re-read and the first becomes active unless one is remembered. */
  setActiveOrganization: (organizationId: number) => Promise<void>;
  /** Select a project of the active organization. */
  setActiveProject: (projectId: number) => void;
  /** Re-read the user, their organizations, and the active organization's projects. */
  refresh: () => Promise<void>;
  /** Destroy the session and clear local state. */
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

/** One consistent answer about the session, applied in a single update. */
interface Snapshot {
  user: AuthUser | null;
  organizations: AuthOrganization[];
  activeOrganizationId: number | null;
  projects: AuthProject[];
  activeProjectId: number | null;
}

const SIGNED_OUT: Snapshot = {
  user: null,
  organizations: [],
  activeOrganizationId: null,
  projects: [],
  activeProjectId: null,
};

/**
 * Read the projects of one organization the caller can see.
 * @param organizationId - The organization.
 * @returns Up to a hundred projects, by name.
 */
async function readProjects(organizationId: number): Promise<AuthProject[]> {
  const list = await apiFetch<ActionResponse<ProjectList>>(
    `/projects?organizationId=${organizationId}&limit=100`,
  );
  return list.projects;
}

/**
 * Provides the session to the app. On mount it loads the public permissions
 * map and hydrates the session in parallel; `GET /me` failing is how "signed
 * out" is detected, so the two are `allSettled` rather than chained.
 *
 * The active organization and project live in `localStorage`, and are healed
 * against what the server answers on every read: a remembered id the caller
 * can no longer see falls back to the first one they can.
 * @param props.children - The subtree that consumes {@link useAuth}.
 * @returns The provider element.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [snapshot, setSnapshot] = useState<Snapshot>(SIGNED_OUT);
  const [permissions, setPermissions] = useState<Permissions | null>(null);
  const [loading, setLoading] = useState(true);
  // Every read takes a ticket and only the newest may write, so a slow refresh
  // cannot land after a switch and put the previous organization back.
  const ticket = useRef(0);

  /**
   * Store a snapshot, and remember its selection.
   * @param next - The snapshot to apply.
   */
  const apply = useCallback((next: Snapshot) => {
    setSnapshot(next);
    if (next.user) {
      writeStoredId(ACTIVE_ORGANIZATION_KEY, next.activeOrganizationId);
      writeStoredId(ACTIVE_PROJECT_KEY, next.activeProjectId);
    }
  }, []);

  const refresh = useCallback(async () => {
    const mine = ++ticket.current;
    try {
      const me = await apiFetch<ActionResponse<MeView>>("/me");
      const list = await apiFetch<ActionResponse<OrganizationList>>(
        "/organizations?limit=100",
      );
      const activeOrganizationId = pickActive(
        readStoredId(ACTIVE_ORGANIZATION_KEY),
        list.organizations.map((o) => o.id),
      );
      const projects = activeOrganizationId
        ? await readProjects(activeOrganizationId)
        : [];
      if (mine !== ticket.current) return;
      apply({
        user: me.user,
        organizations: list.organizations,
        activeOrganizationId,
        projects,
        activeProjectId: pickActive(
          readStoredId(ACTIVE_PROJECT_KEY),
          projects.map((p) => p.id),
        ),
      });
    } catch (error) {
      if (mine !== ticket.current) return;
      // Only a 401 means the session is gone. A failed read for any other
      // reason (a deploy, a dropped connection) keeps what we knew, rather
      // than bouncing a signed-in person to the sign-in page.
      if (isSignedOut(error)) setSnapshot(SIGNED_OUT);
    }
  }, [apply]);

  const setActiveOrganization = useCallback(
    async (organizationId: number) => {
      const mine = ++ticket.current;
      writeStoredId(ACTIVE_ORGANIZATION_KEY, organizationId);
      try {
        const projects = await readProjects(organizationId);
        if (mine !== ticket.current) return;
        setSnapshot((current) => {
          const next = {
            ...current,
            activeOrganizationId: organizationId,
            projects,
            activeProjectId: pickActive(
              readStoredId(ACTIVE_PROJECT_KEY),
              projects.map((p) => p.id),
            ),
          };
          writeStoredId(ACTIVE_PROJECT_KEY, next.activeProjectId);
          return next;
        });
      } catch {
        // The organization could not be read (left, or deleted meanwhile):
        // re-hydrate, which heals the selection onto one that exists.
        if (mine === ticket.current) await refresh();
      }
    },
    [refresh],
  );

  const setActiveProject = useCallback((projectId: number) => {
    writeStoredId(ACTIVE_PROJECT_KEY, projectId);
    setSnapshot((current) => ({ ...current, activeProjectId: projectId }));
  }, []);

  const signOut = useCallback(async () => {
    ticket.current++;
    try {
      await apiFetch("/session", { method: "DELETE" });
    } finally {
      // Cleared even if the request failed — the person asked to be signed
      // out, and a stale cookie is the server's to expire.
      setSnapshot(SIGNED_OUT);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [perms] = await Promise.allSettled([
        apiFetch<ActionResponse<ActionsPermissions>>("/actions/permissions"),
        refresh(),
      ]);
      if (cancelled) return;
      if (perms.status === "fulfilled") setPermissions(perms.value.permissions);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  const value = useMemo<AuthState>(
    () => ({
      ...snapshot,
      permissions,
      loading,
      setActiveOrganization,
      setActiveProject,
      refresh,
      signOut,
    }),
    [
      snapshot,
      permissions,
      loading,
      setActiveOrganization,
      setActiveProject,
      refresh,
      signOut,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/**
 * Access the current {@link AuthState}.
 * @returns The current auth state.
 * @throws {Error} If called outside an {@link AuthProvider}.
 */
export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}
