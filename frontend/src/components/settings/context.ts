import type { ConnectionList } from "@backend/actions/connection/connection-list";
import type { ProjectView } from "@backend/actions/project/project-view";
import type { ActionResponse } from "keryx";
import { useOutletContext } from "react-router-dom";
import type { ProjectStanding } from "../../utils/permissions";

/** The project as `project:view` returns it. */
export type Project = ActionResponse<ProjectView>["project"];

/** The MCP endpoint `project:view` reports, or `null` while it is loading. */
export type Mcp = ActionResponse<ProjectView>["mcp"];

/** One connected credential, as `connection:list` reports it. */
export type Connection = ActionResponse<ConnectionList>["connections"][number];

/** Which third party a connection is with. */
export type ConnectionKind = Connection["kind"];

/** Every connection kind the server knows about, with its schema and prose. */
export type Catalog = ActionResponse<ConnectionList>["catalog"];

/**
 * One connection kind as the server describes it: label, prose, metadata schema,
 * secret shape, where to get the secret — and `usage`, which is the server's
 * answer to **which settings section configures it**. Nothing here compares a
 * kind to a provider name.
 */
export type ConnectionDefinition = Catalog["kinds"][number];

/**
 * What the settings shell hands every section.
 *
 * Passed through the router's own outlet context rather than a React context, for
 * the reason `agent-editor/context.ts` gives at length: `src/context/` means
 * app-global state living inside `AuthProvider`, and the route tree already gives
 * the parent/child guarantee a provider would re-declare.
 *
 * What is here is what **more than one simultaneously reachable section** needs,
 * and nothing else. Everything a single section reads, that section fetches — which
 * is what makes "a plain member never calls an admin-only endpoint" a property of
 * the shape rather than of a conditional somebody has to remember.
 */
export interface SettingsContext {
  /** The active project. */
  projectId: number;
  /** The project as the server last returned it. */
  project: Project;
  /** The MCP endpoint, which only the MCP section renders. */
  mcp: Mcp | null;
  /** The caller's standing, as `project:view` decided it. */
  standing: ProjectStanding;
  /**
   * `can()` bound to this project's standing.
   *
   * The "until `project:view` answers, assume the least" fallback lives here and
   * nowhere else. It was written out twice, once per old page, which is one copy
   * too many of a rule — and the shell holds the context back until `project:view`
   * *has* answered, so by the time a section calls this it is real standing rather
   * than the pessimistic default.
   */
  may: (actionName: string) => boolean;
  /** Every connected credential, or `[]` when the caller may not read them. */
  connections: Connection[];
  /** The connection catalog, or `null` for a non-admin and while loading. */
  catalog: Catalog | null;
  /** Whether the admin-only half was fetched at all. */
  maySeeSecrets: boolean;
  /**
   * Whether `connection:list` has answered.
   *
   * Distinct from `connections.length === 0`, which a project with no credentials
   * and a project whose request has not returned *both* produce — the confusion
   * that had the Model section announce "No coding agents are registered." to
   * every admin for one round trip.
   *
   * It stays `false` forever for a non-admin, who never fetches, and that is
   * correct rather than a leak: every reader checks {@link maySeeSecrets} first
   * and renders the admin-only notice instead.
   */
  connectionsLoaded: boolean;
  /** Re-read `project:view` alone. */
  reloadProject: () => Promise<void>;
  /** Re-read `connection:list` alone. A no-op for anyone who may not read it. */
  reloadConnections: () => Promise<void>;
  /**
   * Tell the shell whether this section is holding unsaved edits.
   *
   * A section must clear it after a successful save and on unmount. Which sections
   * report at all is a judgement, and the list is in `SettingsPage`'s JSDoc.
   */
  markDirty: (slug: string, dirty: boolean) => void;
}

/**
 * The settings context, typed.
 *
 * The single seam: no section imports `useOutletContext` directly, so if this ever
 * needs to become a real context the swap is this file alone.
 * @returns What the shell provided.
 */
export function useProjectSettings(): SettingsContext {
  return useOutletContext<SettingsContext>();
}
