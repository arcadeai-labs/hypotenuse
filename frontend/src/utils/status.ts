import type { Status } from "@backend/actions/status";
import type { ActionResponse } from "keryx";

/** What `GET /api/status` answers, typed from the action itself. */
export type StatusResponse = ActionResponse<Status>;

/** One line of the status page: a dependency and what the server said about it. */
export interface StatusCheck {
  /** What was checked, as a person reads it. */
  label: string;
  /** `true` healthy, `false` failing, `null` disabled on this server. */
  ok: boolean | null;
}

/**
 * Flatten a status response into the checks a person scans for. A database the
 * server runs without has no extensions to report, so its extension row says
 * disabled rather than failing.
 * @param status - The body of `GET /api/status`.
 * @returns Every check, in the order they are shown.
 */
export function statusChecks(status: StatusResponse): StatusCheck[] {
  return [
    { label: "Database", ok: status.checks.database },
    {
      label: "Database extension: vector",
      ok: status.database ? status.database.extensions.vector : null,
    },
    { label: "Redis", ok: status.checks.redis },
  ];
}

/**
 * The word shown for a check's result.
 * @param ok - The check's result.
 * @returns `ok`, `failing`, or `disabled`.
 */
export function checkLabel(ok: boolean | null): string {
  if (ok === null) return "disabled";
  return ok ? "ok" : "failing";
}
