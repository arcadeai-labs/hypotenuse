import {
  type HeartbeatRequest,
  MACHINE_IN_USE,
  type RepositoryCapability,
  type RunnerCapabilities,
  runnerChannel,
} from "@hypotenuse/protocol";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { api, config, ErrorType, TypedError } from "keryx";
import { z } from "zod";
// Type-only: brings the `config.runners` augmentation into every program that
// type-checks this file (the frontend reaches it through the runner actions).
import type {} from "../config/runners";
import {
  type NewRunnerSubscription,
  type RunnerSubscription,
  runnerSubscriptions,
} from "../schema/runner_subscriptions";
import {
  LIVE_RUNNER_STATUSES,
  type Runner,
  type RunnerRevokeReason,
  type RunnerStatus,
  runners,
} from "../schema/runners";
import type { Tag } from "../schema/tags";
import { users } from "../schema/users";
import { RUNNER_TOKEN_PREFIX, sha256Hex } from "./CliTokenOps";
import { isAdmin } from "./MembershipOps";
import type { TxHandle } from "./ProjectOps";

/**
 * Runners: registration, tokens, heartbeats, presence, and revocation.
 *
 * A runner token is ToolExec's run token with a longer life: one random value,
 * stored only as its sha256, resolved by a single indexed equality on the
 * hash (so no per-byte comparison against a secret exists to leak timing),
 * and every permission derived from the row it resolves to. Because it lives
 * for months on a laptop, revocation has to be complete and immediate — the
 * row, every Keryx session `daemon:connect` minted for it, and a `revoked`
 * frame on its channel.
 */

export { RUNNER_TOKEN_PREFIX };

/** One message for every runner token that does not authenticate. */
export const INVALID_RUNNER_TOKEN_MESSAGE =
  "This runner token is invalid or revoked. Run `hypotenuse runner register` again.";

/** The dashboard channel a project's runner list is refreshed on. */
export const PROJECT_RUNNERS_CHANNEL_PATTERN = /^project:(\d+):runners$/;

/** The pattern of a runner's own wake-up channel. */
export const RUNNER_CHANNEL_PATTERN = /^runner:(\d+)$/;

/**
 * The dashboard channel for a project's runners.
 * @param projectId - The project.
 * @returns `project:<id>:runners`.
 */
export function projectRunnersChannel(projectId: number): string {
  return `project:${projectId}:runners`;
}

/** A runner name: what a person types in `runner register --name`. */
export const runnerNameInput = z
  .string()
  .trim()
  .min(1, "A runner name is required")
  .max(64, "A runner name must be at most 64 characters")
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
    "A runner name is letters, digits, `.`, `_`, and `-`",
  );

/**
 * Mint a runner token: `hyp_rt_` and 32 random bytes in base64url, 43
 * characters.
 * @returns The plaintext token.
 */
export function generateRunnerToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `${RUNNER_TOKEN_PREFIX}${Buffer.from(bytes).toString("base64url")}`;
}

/**
 * The lookup key of a runner token.
 * @param token - The plaintext token.
 * @returns Its sha256, hex.
 */
export function hashRunnerToken(token: string): string {
  return sha256Hex(token);
}

/**
 * Normalize a git remote to `hostname/owner/name`, so the scp form, an HTTPS
 * URL, and the bare form of one repository compare equal.
 *
 * `git@github.com:acme/web.git`, `https://github.com/acme/web`,
 * `ssh://git@github.com:22/acme/web.git`, and `github.com/acme/web` all
 * become `github.com/acme/web`. The host is lowercased (hosts are
 * case-insensitive); the path is not (some forges' paths are not).
 * @param remote - The remote as the daemon reported it.
 * @returns The normalized remote.
 */
export function normalizeRemote(remote: string): string {
  let rest = remote.trim();
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(rest);
  if (scheme) rest = rest.slice(scheme[0].length);
  // user@ (ssh and scp forms).
  rest = rest.replace(/^[^@/]+@/, "");
  let host: string;
  let path: string;
  const slash = rest.indexOf("/");
  const colon = rest.indexOf(":");
  if (!scheme && colon !== -1 && (slash === -1 || colon < slash)) {
    // scp form: host:owner/name
    host = rest.slice(0, colon);
    path = rest.slice(colon + 1);
  } else {
    host = slash === -1 ? rest : rest.slice(0, slash);
    path = slash === -1 ? "" : rest.slice(slash + 1);
    host = host.replace(/:\d+$/, "");
  }
  path = path
    .replace(/\/+$/, "")
    .replace(/\.git$/, "")
    .replace(/^\/+/, "");
  return path ? `${host.toLowerCase()}/${path}` : host.toLowerCase();
}

/**
 * The capabilities a daemon reported, normalized the way the server stores
 * them: remotes as `hostname/owner/name`, label subscriptions lowercased, and
 * subscription values de-duplicated and sorted (they are sets).
 * @param capabilities - As reported.
 * @returns The normalized copy.
 */
export function normalizeCapabilities(
  capabilities: RunnerCapabilities,
): RunnerCapabilities {
  const set = (values: string[]) => [...new Set(values)].sort();
  return {
    roles: [...new Set(capabilities.roles)].sort(),
    agents: capabilities.agents,
    repositories: capabilities.repositories.map(
      (r): RepositoryCapability => ({
        ...r,
        remote: normalizeRemote(r.remote),
      }),
    ),
    subscriptions: {
      teams: set(capabilities.subscriptions.teams),
      projects: set(capabilities.subscriptions.projects),
      labels: set(
        capabilities.subscriptions.labels.map((l) => l.toLowerCase()),
      ),
    },
  };
}

/**
 * JSON with object keys sorted at every depth, so two objects that are equal
 * hash equal whatever order their keys arrived in.
 * @param value - Any JSON value.
 * @returns Its canonical serialization.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * The hash a heartbeat's capabilities are compared by.
 * @param capabilities - Normalized capabilities.
 * @returns `sha256:<hex>` of their canonical JSON.
 */
export function capabilityHash(capabilities: RunnerCapabilities): string {
  return `sha256:${sha256Hex(canonicalJson(capabilities))}`;
}

/**
 * Whether the caller may edit or revoke a runner: its owner, or a project
 * admin. A data-dependent check, on top of `ProjectMemberMiddleware()`.
 * @param userId - The caller.
 * @param callerTags - The caller's tags in the runner's project.
 * @param runner - The runner.
 * @returns True for the owner or an admin.
 */
export function canManageRunner(
  userId: number,
  callerTags: Tag[],
  runner: Runner,
): boolean {
  return runner.userId === userId || isAdmin(callerTags);
}

/** The owner fields a runner is shown with. */
export interface RunnerOwner {
  id: number;
  name: string;
  email: string;
}

/** Extra facts a serialized runner can carry. */
export interface SerializeRunnerExtras {
  owner?: RunnerOwner | null;
  subscriptions?: RunnerSubscription[];
  /** Whether a socket is subscribed to the runner's channel right now. */
  socketAttached?: boolean;
  /** Whether the caller may edit or revoke it. */
  canManage?: boolean;
}

/**
 * Shape a runner for the API. There is no token field and no hash: a runner
 * token exists once, in the `runner:register` response. Timestamps are epoch
 * ms.
 * @param row - The runner.
 * @param extras - Owner, subscriptions, socket, and standing, when known.
 * @returns The serialized runner.
 */
export function serializeRunner(
  row: Runner,
  extras: SerializeRunnerExtras = {},
) {
  const ms = (d: Date | null) => (d ? d.getTime() : null);
  return {
    id: row.id,
    projectId: row.projectId,
    userId: row.userId,
    owner: extras.owner ?? null,
    name: row.name,
    status: row.status,
    /** Heartbeating: `online` or `draining`. Decided here, not by a client. */
    online: row.status === "online" || row.status === "draining",
    enabled: row.enabled,
    tokenLastFour: row.tokenLastFour,
    lastHeartbeatAt: ms(row.lastHeartbeatAt),
    lastConnectedAt: ms(row.lastConnectedAt),
    protocolVersion: row.protocolVersion,
    daemonVersion: row.daemonVersion,
    platform: row.platform,
    hostname: row.hostname,
    limits: row.limits,
    activeCount: row.activeCount,
    roles: row.roles,
    agents: row.agents,
    repositories: row.repositories,
    ...(extras.subscriptions
      ? { subscriptions: groupSubscriptions(extras.subscriptions) }
      : {}),
    ...(extras.socketAttached !== undefined
      ? { socketAttached: extras.socketAttached }
      : {}),
    ...(extras.canManage !== undefined
      ? { standing: { canManage: extras.canManage } }
      : {}),
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
    revokedAt: ms(row.revokedAt),
    revokedReason: row.revokedReason,
  };
}

/** A serialized runner, as every `runner:*` action answers. */
export type SerializedRunner = ReturnType<typeof serializeRunner>;

/**
 * Group subscription rows back into the shape a daemon reported them in.
 * @param rows - The runner's subscription rows.
 * @returns `{ teams, projects, labels }`, each sorted.
 */
export function groupSubscriptions(rows: RunnerSubscription[]) {
  const pick = (kind: string) =>
    rows
      .filter((r) => r.kind === kind)
      .map((r) => r.value)
      .sort();
  return {
    teams: pick("team"),
    projects: pick("project"),
    labels: pick("label"),
  };
}

/**
 * Read a runner's subscription rows.
 * @param runnerId - The runner.
 * @returns Its rows.
 */
export async function getRunnerSubscriptions(
  runnerId: number,
): Promise<RunnerSubscription[]> {
  return api.db.db
    .select()
    .from(runnerSubscriptions)
    .where(eq(runnerSubscriptions.runnerId, runnerId));
}

/**
 * Whether a socket is attached to a runner's channel anywhere in the cluster.
 * Not presence — a daemon behind a proxy that eats WebSockets still
 * heartbeats — but worth showing beside it.
 * @param runnerId - The runner.
 * @returns True when some connection holds `runner:<id>`.
 */
export async function isSocketAttached(runnerId: number): Promise<boolean> {
  const members = await api.channels.members(runnerChannel(runnerId));
  return members.length > 0;
}

/** The Redis set of Keryx session ids `daemon:connect` minted for a runner. */
export function runnerSessionsKey(runnerId: number): string {
  return `runner:sessions:${runnerId}`;
}

/**
 * Remember a session `daemon:connect` minted, so revocation can delete it.
 * The set lives as long as the newest session could.
 * @param runnerId - The runner.
 * @param sessionId - The Keryx session id.
 */
export async function trackRunnerSession(
  runnerId: number,
  sessionId: string,
): Promise<void> {
  const key = runnerSessionsKey(runnerId);
  await api.redis.redis
    .multi()
    .sadd(key, sessionId)
    .expire(key, config.session.ttl)
    .exec();
}

/**
 * Mark runners revoked inside a transaction. Idempotent: rows already revoked
 * are left as they were. The caller runs {@link afterRunnersRevoked} once the
 * transaction commits.
 *
 * Work a revoked runner holds is returned to the queue by work routing, in
 * this same transaction, once work items exist.
 * @param tx - The transaction.
 * @param where - Which runners (by id).
 * @param reason - Why.
 * @returns The revoked rows (only those this call changed).
 */
export async function revokeRunners(
  tx: TxHandle,
  runnerIds: number[],
  reason: RunnerRevokeReason,
): Promise<Runner[]> {
  if (runnerIds.length === 0) return [];
  return tx
    .update(runners)
    .set({ status: "revoked", revokedAt: new Date(), revokedReason: reason })
    .where(and(inArray(runners.id, runnerIds), ne(runners.status, "revoked")))
    .returning();
}

/**
 * The post-commit half of revocation: a `revoked` frame on each runner's
 * channel, every session `daemon:connect` minted for it deleted (which ends
 * that socket's authority now, not at session TTL), and the dashboard told.
 * Never throws: the revocation already committed.
 * @param revoked - What {@link revokeRunners} returned.
 */
export async function afterRunnersRevoked(
  revoked: Pick<Runner, "id" | "projectId">[],
): Promise<void> {
  const projectIds = new Set<number>();
  for (const runner of revoked) {
    projectIds.add(runner.projectId);
    try {
      await publish(runnerChannel(runner.id), "revoked");
      const key = runnerSessionsKey(runner.id);
      const sessionIds = await api.redis.redis.smembers(key);
      const keys = sessionIds.map((id) => `session:${id}`);
      await api.redis.redis.del(key, ...keys);
    } catch (error) {
      api.logger.warn("runner revocation side effects failed", {
        runnerId: runner.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  for (const projectId of projectIds) await publishRunnersChanged(projectId);
}

/**
 * Tell a project's dashboards its runner list changed. Content-free.
 * Never throws.
 * @param projectId - The project.
 */
export async function publishRunnersChanged(projectId: number): Promise<void> {
  try {
    await publish(projectRunnersChannel(projectId), "runners");
  } catch (error) {
    api.logger.warn("runner list broadcast failed", {
      projectId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Publish one content-free frame.
 * @param channel - The channel.
 * @param event - The frame's only field.
 */
async function publish(channel: string, event: string): Promise<void> {
  await api.pubsub.broadcast(channel, JSON.stringify({ event }), "runners");
}

/** What another live runner on the same machine looks like to the caller. */
export interface MachineConflict {
  runnerId: number | null;
  runnerName: string | null;
}

/**
 * Find a different live runner with this machine id.
 * @param runner - The runner asking.
 * @param machineId - The machine id it reported.
 * @param db - Where to read (a transaction, or the pool).
 * @returns The conflict as the caller may see it, or `null`.
 */
export async function findMachineConflict(
  runner: Runner,
  machineId: string,
  db: TxHandle | typeof api.db.db = api.db.db,
): Promise<MachineConflict | null> {
  const [other] = await db
    .select()
    .from(runners)
    .where(
      and(
        eq(runners.machineId, machineId),
        inArray(runners.status, [...LIVE_RUNNER_STATUSES]),
        ne(runners.id, runner.id),
      ),
    )
    .limit(1);
  if (!other) return null;
  return describeConflict(runner, other);
}

/**
 * Name the other runner only to someone who could see it anyway — the same
 * project, or the same owner. Machine ids are global, so the other runner
 * may belong to another tenant on a shared build box.
 * @param runner - The runner asking.
 * @param other - The live runner holding the machine.
 * @returns The conflict.
 */
function describeConflict(runner: Runner, other: Runner): MachineConflict {
  const visible =
    other.projectId === runner.projectId || other.userId === runner.userId;
  return visible
    ? { runnerId: other.id, runnerName: other.name }
    : { runnerId: null, runnerName: null };
}

/**
 * The 409 a second live runner on one machine receives — a raw response,
 * because Keryx's typed errors have no 409.
 * @param conflict - Which runner holds the machine.
 * @returns The response.
 */
export function machineInUseResponse(conflict: MachineConflict): Response {
  const named = conflict.runnerName
    ? `runner "${conflict.runnerName}" (#${conflict.runnerId})`
    : "another runner";
  return Response.json(
    {
      error: {
        type: MACHINE_IN_USE,
        message: `This machine is already running ${named}. One daemon per machine: stop it first.`,
        runnerId: conflict.runnerId,
        runnerName: conflict.runnerName,
      },
    },
    { status: 409 },
  );
}

/**
 * Whether an error is the live-machine unique index refusing a second live
 * runner — the losing side of two daemons starting at once.
 * @param error - What a transaction threw.
 * @returns True for a unique violation on `runners_live_machine_idx`.
 */
export function isMachineIndexViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current; depth++) {
    const e = current as {
      code?: unknown;
      constraint?: unknown;
      cause?: unknown;
    };
    if (e.code === "23505" && e.constraint === "runners_live_machine_idx") {
      return true;
    }
    current = e.cause;
  }
  return false;
}

/** What a heartbeat changed, for the caller to publish. */
export interface HeartbeatResult {
  runner: Runner;
  /** Whether the dashboard's view of the runner changed. */
  changed: boolean;
  conflict: MachineConflict | null;
}

/**
 * Apply a heartbeat: liveness, status, the reported facts, and — only when
 * the capability hash changed — the capabilities and subscription rows.
 * A steady fleet therefore writes one row per beat, not a dozen.
 *
 * The machine check runs on the locked row; two different runners racing
 * onto one machine id are settled by `runners_live_machine_idx`, which the
 * caller maps to the same refusal.
 * @param tx - The transaction.
 * @param runnerId - The runner heartbeating.
 * @param request - The validated heartbeat.
 * @returns The updated row, whether anything visible changed, or a conflict
 *   (in which case nothing was written).
 */
export async function applyHeartbeat(
  tx: TxHandle,
  runnerId: number,
  request: HeartbeatRequest,
): Promise<HeartbeatResult> {
  const [current] = await tx
    .select()
    .from(runners)
    .where(eq(runners.id, runnerId))
    .for("update")
    .limit(1);
  if (!current || current.status === "revoked") {
    throw new TypedError({
      message: INVALID_RUNNER_TOKEN_MESSAGE,
      type: ErrorType.CONNECTION_SESSION_NOT_FOUND,
    });
  }

  const conflict = await findMachineConflict(current, request.machineId, tx);
  if (conflict) return { runner: current, changed: false, conflict };

  const capabilities = normalizeCapabilities(request.capabilities);
  const hash = capabilityHash(capabilities);
  const status: RunnerStatus = request.draining ? "draining" : "online";
  const capabilitiesChanged = hash !== current.capabilityHash;

  const [updated] = await tx
    .update(runners)
    .set({
      status,
      lastHeartbeatAt: new Date(),
      protocolVersion: request.protocolVersion,
      daemonVersion: request.daemonVersion,
      platform: request.platform,
      hostname: request.hostname,
      machineId: request.machineId,
      limits: request.limits,
      activeCount: request.active.length,
      ...(capabilitiesChanged
        ? {
            capabilityHash: hash,
            roles: capabilities.roles,
            agents: capabilities.agents,
            repositories: capabilities.repositories,
          }
        : {}),
    })
    .where(eq(runners.id, runnerId))
    .returning();

  if (capabilitiesChanged) {
    await replaceSubscriptions(tx, runnerId, capabilities);
  }

  const changed =
    capabilitiesChanged ||
    status !== current.status ||
    request.active.length !== current.activeCount ||
    canonicalJson(request.limits) !== canonicalJson(current.limits);
  return { runner: updated!, changed, conflict: null };
}

/**
 * Replace a runner's subscription rows with what its capabilities say.
 * @param tx - The transaction.
 * @param runnerId - The runner.
 * @param capabilities - Normalized capabilities.
 */
async function replaceSubscriptions(
  tx: TxHandle,
  runnerId: number,
  capabilities: RunnerCapabilities,
): Promise<void> {
  await tx
    .delete(runnerSubscriptions)
    .where(eq(runnerSubscriptions.runnerId, runnerId));
  const { teams, projects, labels } = capabilities.subscriptions;
  const rows: NewRunnerSubscription[] = [
    ...teams.map((value) => ({ kind: "team" as const, value })),
    ...projects.map((value) => ({ kind: "project" as const, value })),
    ...labels.map((value) => ({ kind: "label" as const, value })),
  ].map((r) => ({ ...r, runnerId, type: "linear" as const }));
  if (rows.length > 0) await tx.insert(runnerSubscriptions).values(rows);
}

/**
 * Mark every live runner whose last heartbeat is older than
 * `runners.offlineAfterMs` offline. Draining runners lapse the same way.
 * @returns The runners marked offline.
 */
export async function reapOfflineRunners(): Promise<Runner[]> {
  const cutoff = new Date(Date.now() - config.runners.offlineAfterMs);
  return api.db.db
    .update(runners)
    .set({ status: "offline" })
    .where(
      and(
        inArray(runners.status, [...LIVE_RUNNER_STATUSES]),
        sql`(${runners.lastHeartbeatAt} IS NULL OR ${runners.lastHeartbeatAt} < ${cutoff})`,
      ),
    )
    .returning();
}

/**
 * A runner by id, only if it is in the project — the same not-found for a
 * runner in another project as for none at all, so ids are not enumerable.
 * @param projectId - The project the caller is a member of.
 * @param runnerId - The runner asked for.
 * @param db - Where to read; pass a transaction to lock the row.
 * @param lock - Take `FOR UPDATE` on the row (inside a transaction).
 * @returns The runner.
 * @throws {TypedError} `CONNECTION_ACTION_NOT_FOUND`.
 */
export async function runnerInProject(
  projectId: number,
  runnerId: number,
  db: TxHandle | typeof api.db.db = api.db.db,
  lock = false,
): Promise<Runner> {
  const query = db
    .select()
    .from(runners)
    .where(and(eq(runners.id, runnerId), eq(runners.projectId, projectId)))
    .limit(1);
  const [row] = lock ? await query.for("update") : await query;
  if (!row) {
    throw new TypedError({
      message: "Runner not found",
      type: ErrorType.CONNECTION_ACTION_NOT_FOUND,
    });
  }
  return row;
}

/**
 * The owners of some runners, by user id.
 * @param userIds - Owner ids.
 * @returns A map from id to owner.
 */
export async function runnerOwners(
  userIds: number[],
): Promise<Map<number, RunnerOwner>> {
  if (userIds.length === 0) return new Map();
  const rows = await api.db.db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(users)
    .where(inArray(users.id, [...new Set(userIds)]));
  return new Map(rows.map((r) => [r.id, r]));
}
