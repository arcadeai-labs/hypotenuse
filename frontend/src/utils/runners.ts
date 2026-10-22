import type { RunnerList } from "@backend/actions/runner/runner-list";
import type { ActionResponse } from "keryx";
import type { CapacitySegment } from "../ui/CapacityBar";
import type { RunnerPresence } from "../ui/PresenceDot";

/** A runner as `runner:list` serializes it. */
export type ListedRunner = ActionResponse<RunnerList>["runners"][number];

/**
 * The dashboard channel a project's runner list is refreshed on. Its one
 * frame, `{ event: "runners" }`, carries no ids: the page re-reads the list.
 * @param projectId - The project on screen.
 * @returns `project:<id>:runners`.
 */
export function runnersChannel(projectId: number): string {
  return `project:${projectId}:runners`;
}

/**
 * Whether a socket frame is the runner list's refresh frame.
 * @param payload - The parsed inner payload of a broadcast.
 * @returns True for `{ event: "runners" }`.
 */
export function isRunnersPayload(payload: unknown): boolean {
  return (
    typeof payload === "object" &&
    payload !== null &&
    (payload as { event?: unknown }).event === "runners"
  );
}

/**
 * The presence glyph a runner shows. A revoked runner is drawn offline; the
 * status column names it.
 * @param status - The server's status for it.
 * @returns The presence.
 */
export function presenceOf(status: ListedRunner["status"]): RunnerPresence {
  return status === "online" || status === "draining" ? status : "offline";
}

/**
 * "used/total" for a runner's capacity, from what its last heartbeat said. A
 * runner that has never heartbeated has no limits yet.
 * @param runner - The runner.
 * @returns e.g. `1/3`, or `—`.
 */
export function capacityLabel(
  runner: Pick<ListedRunner, "activeCount" | "limits">,
): string {
  const total = runner.limits?.maxParallelJobs;
  return total ? `${runner.activeCount}/${total}` : "—";
}

/**
 * The ids of the agents a runner reported as usable.
 * @param runner - The runner.
 * @returns Their ids, in reported order.
 */
export function availableAgents(
  runner: Pick<ListedRunner, "agents">,
): string[] {
  return runner.agents.filter((a) => a.available).map((a) => a.id);
}

/** One live session a runner holds, for its capacity bar. */
export interface HeldSession {
  id: number;
  issueIdentifier: string | null;
}

/**
 * A runner's slots as capacity segments: one per `maxParallelJobs`, the
 * held sessions first, each linking to its session page. A runner that went
 * offline while holding work turns those segments stale — the one loud state
 * on the page.
 * @param runner - The runner.
 * @param held - The sessions it holds.
 * @returns The segments.
 */
export function capacitySegments(
  runner: Pick<ListedRunner, "limits" | "activeCount" | "status">,
  held: HeldSession[],
): CapacitySegment[] {
  const total = Math.max(runner.limits?.maxParallelJobs ?? 0, held.length);
  const busy = runner.status === "offline" ? "stale" : "busy";
  return Array.from({ length: total }, (_, i) => {
    const session = held[i];
    if (session) {
      return {
        state: busy,
        label: session.issueIdentifier ?? `#${session.id}`,
        href: `/sessions/${session.id}`,
      };
    }
    return i < runner.activeCount ? { state: busy } : { state: "free" };
  });
}

/**
 * Group runners by owner, owners by name.
 * @param runners - The runners.
 * @returns `[owner name, runners]` pairs.
 */
export function groupByOwner(
  runners: ListedRunner[],
): [string, ListedRunner[]][] {
  const groups = new Map<string, ListedRunner[]>();
  for (const runner of runners) {
    const owner = runner.owner?.name ?? "Unknown owner";
    groups.set(owner, [...(groups.get(owner) ?? []), runner]);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
}
