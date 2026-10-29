import { useOutletContext } from "react-router-dom";
import type { ProjectViewResponse } from "../../context/StandingContext";
import type { ProjectStanding } from "../../utils/permissions";

/** The project as `project:view` returns it. */
export type Project = ProjectViewResponse["project"];

/**
 * What the settings shell hands every section, through the router's outlet
 * context. The shell holds it back until `project:view` has answered for the
 * active project, so every section sees real standing and never a guess.
 *
 * What is here is what more than one section needs, and nothing else;
 * everything a single section reads, that section fetches.
 */
export interface SettingsContext {
  /** The active project. */
  projectId: number;
  /** The project as the server last returned it. */
  project: Project;
  /** The organization it belongs to. */
  organizationId: number;
  /** The caller's standing, as `project:view` decided it. */
  standing: ProjectStanding;
  /** `can()` bound to this project's and organization's standing. */
  may: (actionName: string) => boolean;
  /** Why an action is refused, or `undefined` — a disabled control's `title`. */
  reason: (actionName: string) => string | undefined;
  /** Re-read `project:view`. */
  reloadProject: () => Promise<void>;
}

/**
 * The settings context, typed. No section imports `useOutletContext` itself.
 * @returns What the shell provided.
 */
export function useProjectSettings(): SettingsContext {
  return useOutletContext<SettingsContext>();
}
