import { z } from "zod";
import { RunnerCapabilities, RunnerLimits, RunnerRole } from "./capabilities";

/** The states a daemon reports for a work item it holds. */
export const ACTIVE_STATES = ["starting", "running", "cancelling"] as const;

/** A work item the daemon holds, as it reports it on each heartbeat. */
export const ActiveItem = z.strictObject({
  workItemId: z.number().int().positive(),
  agentSessionId: z.number().int().positive(),
  role: RunnerRole,
  agentId: z.string().min(1).max(64),
  state: z.enum(ACTIVE_STATES),
});
export type ActiveItem = z.infer<typeof ActiveItem>;

/** A stable hash of the OS machine id: `sha256:<hex>`. */
export const MachineId = z
  .string()
  .regex(/^sha256:[0-9a-f]{1,64}$/, "sha256:<hex>")
  .describe("A stable hash of the OS machine id, `sha256:<hex>`");

/**
 * `daemon:heartbeat`'s body. Strict: a newer daemon cannot send a field an
 * older server would silently drop.
 */
export const HeartbeatRequest = z.strictObject({
  protocolVersion: z.number().int().positive(),
  daemonVersion: z.string().trim().min(1).max(64),
  platform: z.string().trim().min(1).max(64),
  hostname: z.string().trim().min(1).max(256),
  draining: z.boolean(),
  machineId: MachineId,
  limits: RunnerLimits,
  active: z.array(ActiveItem).max(1000),
  capabilities: RunnerCapabilities,
  dryRun: z
    .boolean()
    .optional()
    .describe(
      "Validate and answer without recording anything: no presence, no capabilities, no leases, no offers",
    ),
});
export type HeartbeatRequest = z.infer<typeof HeartbeatRequest>;

/** Who the token is, answered to a dry run. */
export const DryRunRunner = z.looseObject({
  id: z.number().int().positive(),
  name: z.string(),
  projectId: z.number().int().positive(),
  projectSlug: z.string(),
});
export type DryRunRunner = z.infer<typeof DryRunRunner>;

/** The kinds of work an offer can be for. */
export const OFFER_KINDS = [
  "session_created",
  "prompt",
  "dispatch",
  "review",
] as const;

/** Work offered to this runner, to be claimed before `offerExpiresAt`. */
export const Offer = z.looseObject({
  workItemId: z.number().int().positive(),
  agentSessionId: z.number().int().positive(),
  kind: z.enum(OFFER_KINDS),
  role: RunnerRole,
  offerExpiresAt: z.number().int(),
});
export type Offer = z.infer<typeof Offer>;

/** Why a held work item is being cancelled. */
export const CANCEL_REASONS = [
  "stop",
  "dashboard",
  "delegate_removed",
  "issue_closed",
  "integration_revoked",
  "superseded",
] as const;

/**
 * A held work item the daemon must cancel. The reasons may grow: a daemon
 * stops the turn for a reason it does not know, and says nothing in Linear.
 */
export const Cancel = z.looseObject({
  workItemId: z.number().int().positive(),
  reason: z.union([z.enum(CANCEL_REASONS), z.string().min(1).max(64)]),
});
export type Cancel = z.infer<typeof Cancel>;

/**
 * A person's reply to a question a held turn is waiting on (an `elicitation`
 * it posted mid-turn), delivered to that turn instead of starting a new one.
 * Repeated on every heartbeat until the turn completes; the daemon reads each
 * `activityId` once.
 */
export const Answer = z.looseObject({
  workItemId: z.number().int().positive(),
  activityId: z.number().int().positive(),
  body: z.string(),
});
export type Answer = z.infer<typeof Answer>;

/**
 * `daemon:heartbeat`'s answer. Loose: an older daemon ignores fields a newer
 * server adds.
 */
export const HeartbeatResponse = z.looseObject({
  serverTime: z.number().int(),
  heartbeatIntervalMs: z.number().int().positive(),
  leaseMs: z.number().int().positive(),
  offers: z.array(Offer),
  cancels: z.array(Cancel),
  unknownActive: z.array(z.number().int().positive()),
  answers: z
    .array(Answer)
    .default([])
    .describe("Replies to questions held turns are waiting on, oldest first"),
  runner: DryRunRunner.optional().describe(
    "A dry run only: the runner the token is",
  ),
  unknownSubscriptions: z
    .looseObject({ teams: z.array(z.string()) })
    .nullable()
    .optional()
    .describe(
      "A dry run only: subscribed team keys the project's Linear connection cannot see; null when it could not be asked",
    ),
});
export type HeartbeatResponse = z.infer<typeof HeartbeatResponse>;
