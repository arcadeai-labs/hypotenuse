import type {
  AgentCapability,
  RepositoryCapability,
  RunnerLimits,
  RunnerRole,
  TelemetryCapability,
} from "@hypotenuse/protocol";
import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { projects } from "./projects";
import { users } from "./users";

/** Every presence state a runner can be in. */
export const RUNNER_STATUSES = [
  "online",
  "offline",
  "draining",
  "revoked",
] as const;

/** One of {@link RUNNER_STATUSES}. */
export type RunnerStatus = (typeof RUNNER_STATUSES)[number];

/** The statuses of a runner whose daemon is heartbeating: one per machine. */
export const LIVE_RUNNER_STATUSES = ["online", "draining"] as const;

/** Why a runner was revoked. */
export const RUNNER_REVOKE_REASONS = [
  "revoked",
  "replaced",
  "membership_removed",
] as const;

/** One of {@link RUNNER_REVOKE_REASONS}. */
export type RunnerRevokeReason = (typeof RUNNER_REVOKE_REASONS)[number];

/**
 * A `runner` is one `hypotenuse daemon` registered to one project by one
 * person — the machine coding agents run on.
 *
 * - **The token is a hash.** `tokenHash` is the sha256 of the `hyp_rt_…`
 *   token, whose plaintext exists once, in the `runner:register` response.
 * - **Capabilities are reported, not configured.** Everything from
 *   `protocolVersion` to `repositories` is what the last heartbeat said;
 *   `capabilityHash` is the canonical hash of the reported capabilities, so a
 *   steady heartbeat rewrites one timestamp rather than every row.
 * - **A name is unique among the project's unrevoked runners**, so
 *   `runner register --replace` can revoke a row and reuse its name.
 * - **One live runner per machine**: a partial unique index over `machineId`
 *   for `online` and `draining` rows makes two daemons on one machine an
 *   atomic refusal, not a race.
 * - **A revoked row is kept** (with `revokedAt` and `revokedReason`) so the
 *   audit trail and the sessions it held still resolve.
 */
export const runners = pgTable(
  "runners",
  {
    id: serial("id").primaryKey(),
    projectId: integer("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /** The person who registered it; their membership is its authority. */
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull(),
    tokenLastFour: text("token_last_four").notNull(),
    status: text("status").$type<RunnerStatus>().notNull().default("offline"),
    /** A paused runner heartbeats but is never offered work. */
    enabled: boolean("enabled").notNull().default(true),
    lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
    lastConnectedAt: timestamp("last_connected_at", { withTimezone: true }),
    protocolVersion: integer("protocol_version"),
    daemonVersion: text("daemon_version"),
    platform: text("platform"),
    hostname: text("hostname"),
    machineId: text("machine_id"),
    limits: jsonb("limits").$type<RunnerLimits | null>(),
    /** How many work items the daemon said it holds on its last heartbeat. */
    activeCount: integer("active_count").notNull().default(0),
    roles: jsonb("roles").$type<RunnerRole[]>().notNull().default([]),
    agents: jsonb("agents").$type<AgentCapability[]>().notNull().default([]),
    /** Remotes normalized to `hostname/owner/name`. */
    repositories: jsonb("repositories")
      .$type<RepositoryCapability[]>()
      .notNull()
      .default([]),
    /**
     * The owner's telemetry cap, as last reported (`[telemetry]` in the
     * daemon's config); null from a daemon that reports none, which sends
     * no telemetry.
     */
    telemetry: jsonb("telemetry").$type<TelemetryCapability | null>(),
    capabilityHash: text("capability_hash"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdateFn(() => new Date()),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedReason: text("revoked_reason").$type<RunnerRevokeReason | null>(),
  },
  (t) => ({
    tokenHashIndex: uniqueIndex("runners_token_hash_idx").on(t.tokenHash),
    projectNameIndex: uniqueIndex("runners_project_name_idx")
      .on(t.projectId, t.name)
      .where(sql`${t.status} <> 'revoked'`),
    liveMachineIndex: uniqueIndex("runners_live_machine_idx")
      .on(t.machineId)
      .where(sql`${t.status} IN ('online', 'draining')`),
    // Membership removal revokes a person's runners in a project.
    projectUserIndex: index("runners_project_user_idx").on(
      t.projectId,
      t.userId,
    ),
    // `work:reap` finds runners whose heartbeat lapsed.
    statusHeartbeatIndex: index("runners_status_heartbeat_idx").on(
      t.status,
      t.lastHeartbeatAt,
    ),
  }),
);

export type Runner = typeof runners.$inferSelect;
export type NewRunner = typeof runners.$inferInsert;
