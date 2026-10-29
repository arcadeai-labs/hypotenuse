import { useCallback, useMemo } from "react";
import { useAuth } from "../context/AuthContext";
import {
  can,
  denialReason,
  type Standings,
  type Verdict,
  verdict,
} from "../utils/permissions";
import { useOrganizationStanding } from "./useOrganizationStanding";
import { useProjectStanding } from "./useProjectStanding";

/** What {@link useMay} hands a component. */
export interface May {
  /** `can()` bound to the active project's and organization's standing. */
  may: (actionName: string) => boolean;
  /** The three-way answer, for the rare control that must wait for it. */
  verdictOf: (actionName: string) => Verdict;
  /**
   * The `title` a disabled control carries: why it is refused, or `undefined`
   * when it is not.
   */
  reason: (actionName: string) => string | undefined;
  /** Both standings are known. */
  resolved: boolean;
}

/**
 * `can()` bound to the active standings, for any component under the shell.
 * Unknown standing answers "may" — a denial is drawn only once the server has
 * said so.
 * @returns See {@link May}.
 */
export function useMay(): May {
  const { permissions } = useAuth();
  const project = useProjectStanding();
  const organization = useOrganizationStanding();
  const standings = useMemo<Standings>(
    () => ({ project, organization }),
    [project, organization],
  );

  const may = useCallback(
    (actionName: string) => can(permissions, actionName, standings),
    [permissions, standings],
  );
  const verdictOf = useCallback(
    (actionName: string) => verdict(permissions, actionName, standings),
    [permissions, standings],
  );
  const reason = useCallback(
    (actionName: string) =>
      verdict(permissions, actionName, standings) === "denied"
        ? denialReason(permissions, actionName)
        : undefined,
    [permissions, standings],
  );

  return {
    may,
    verdictOf,
    reason,
    resolved: permissions !== null && project !== null && organization !== null,
  };
}
