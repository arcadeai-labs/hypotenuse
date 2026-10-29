import type { OrganizationView } from "@backend/actions/organization/organization-view";
import type { ProjectView } from "@backend/actions/project/project-view";
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
import { apiFetch } from "../utils/client";
import { useAuth } from "./AuthContext";

/** `project:view`'s answer: the project, its organization, the caller's tags and standing. */
export type ProjectViewResponse = ActionResponse<ProjectView>;
/** `organization:view`'s answer: the organization and the caller's standing. */
export type OrganizationViewResponse = ActionResponse<OrganizationView>;

/** A view, tagged with the id it was read for, so a stale one is recognisable. */
interface Keyed<T> {
  key: string;
  view: T;
}

/** What the standing provider shares. */
export interface StandingState {
  /** The active project's view, or `null` while unknown (or when there is no active project). */
  projectView: ProjectViewResponse | null;
  /** The active organization's view, or `null` while unknown (or when there is none). */
  organizationView: OrganizationViewResponse | null;
  /** Re-read `project:view` for the active project. */
  reloadProject: () => Promise<void>;
  /** Re-read `organization:view` for the active organization. */
  reloadOrganization: () => Promise<void>;
}

const StandingContext = createContext<StandingState | null>(null);

/**
 * Read one view for whichever id is active, holding nothing for any other id.
 *
 * A view is kept with the id it answered for and returned only while that id
 * is still the active one: after a switch the previous project's standing is
 * still in state until the new answer lands, and handing it out would offer
 * that project's admin controls in this one.
 * @param userId - Who is signed in, or null; a different person is a different answer.
 * @param id - The active id, or null.
 * @param path - Build the route to read for an id.
 * @returns The current view (or null) and a reload.
 */
function useKeyedView<T>(
  userId: number | null,
  id: number | null,
  path: (id: number) => string,
): { view: T | null; reload: () => Promise<void> } {
  const key = userId === null || id === null ? null : `${userId}:${id}`;
  const [state, setState] = useState<Keyed<T> | null>(null);
  const current = useRef(key);
  current.current = key;
  const pathRef = useRef(path);
  pathRef.current = path;

  const reload = useCallback(async () => {
    if (key === null || id === null) return;
    try {
      const view = await apiFetch<T>(pathRef.current(id));
      if (current.current === key) setState({ key, view });
    } catch {
      // Unknown standing stays unknown: nothing is denied on its strength,
      // and the page that needed it reports its own failure.
    }
  }, [key, id]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { view: state && state.key === key ? state.view : null, reload };
}

/**
 * Reads the active project's and organization's standing once, for the shell
 * and every page under it. Standing is the server's answer (`project:view`,
 * `organization:view`); the client never infers it from tags or roles.
 * @param props.children - The subtree that consumes the standing hooks.
 * @returns The provider element.
 */
export function StandingProvider({ children }: { children: ReactNode }) {
  const { user, activeProjectId, activeOrganizationId } = useAuth();
  const userId = user?.id ?? null;
  const project = useKeyedView<ProjectViewResponse>(
    userId,
    activeProjectId,
    (id) => `/project/${id}`,
  );
  const organization = useKeyedView<OrganizationViewResponse>(
    userId,
    activeOrganizationId,
    (id) => `/organization/${id}`,
  );

  const value = useMemo<StandingState>(
    () => ({
      projectView: project.view,
      organizationView: organization.view,
      reloadProject: project.reload,
      reloadOrganization: organization.reload,
    }),
    [project.view, project.reload, organization.view, organization.reload],
  );

  return (
    <StandingContext.Provider value={value}>
      {children}
    </StandingContext.Provider>
  );
}

/**
 * Access the shared standing state.
 * @returns The state.
 * @throws {Error} If called outside a {@link StandingProvider}.
 */
export function useStanding(): StandingState {
  const ctx = useContext(StandingContext);
  if (!ctx)
    throw new Error("useStanding must be used within a StandingProvider");
  return ctx;
}
