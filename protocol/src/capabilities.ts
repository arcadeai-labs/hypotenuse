import { z } from "zod";
import { TelemetryCapability } from "./telemetry";

/** The roles a runner can play for an agent session. */
export const RUNNER_ROLES = ["manager", "worker"] as const;

/** One of {@link RUNNER_ROLES}. */
export const RunnerRole = z.enum(RUNNER_ROLES);
export type RunnerRole = z.infer<typeof RunnerRole>;

/** A short identifier a person writes in a config file (`claude`, `codex`). */
const identifier = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "letters, digits, `.`, `_`, `-`");

/**
 * One coding agent the daemon is configured to run, and whether its own probe
 * found it usable (binary on PATH, `initialize` succeeded).
 */
export const AgentCapability = z.strictObject({
  id: identifier.describe("The agent's id in the config file"),
  preset: identifier.describe("The preset it is built on, e.g. claude"),
  available: z.boolean().describe("Whether the daemon's probe succeeded"),
  version: z.string().max(128).optional().describe("The agent's version"),
  roles: z
    .array(RunnerRole)
    .max(RUNNER_ROLES.length)
    .optional()
    .describe("The roles this agent plays; absent means every role"),
  error: z
    .string()
    .max(1024)
    .optional()
    .describe("Why the probe failed, when it did"),
});
export type AgentCapability = z.infer<typeof AgentCapability>;

/** One repository the daemon can open worktrees of. */
export const RepositoryCapability = z.strictObject({
  name: identifier.describe("The repository's name in the config file"),
  remote: z
    .string()
    .trim()
    .min(1)
    .max(512)
    .describe("Its git remote; the server normalizes it to host/owner/name"),
  baseBranch: z.string().trim().min(1).max(255).describe("The base branch"),
});
export type RepositoryCapability = z.infer<typeof RepositoryCapability>;

/** A list of subscription values; empty means "everything". */
const subscriptionValues = z
  .array(z.string().trim().min(1).max(255))
  .max(200)
  .default([]);

/**
 * The trigger scopes a runner accepts work from. Each empty list means every
 * value of that kind; kinds intersect.
 */
export const Subscriptions = z.strictObject({
  teams: subscriptionValues.describe("Team keys, e.g. ENG"),
  projects: subscriptionValues.describe("Project ids"),
  labels: subscriptionValues.describe("Label names (matched lowercased)"),
});
export type Subscriptions = z.infer<typeof Subscriptions>;

/**
 * What a runner can do, reported on every heartbeat. The server replaces its
 * copy whenever the canonical hash of this object changes.
 */
export const RunnerCapabilities = z.strictObject({
  roles: z.array(RunnerRole).max(RUNNER_ROLES.length),
  agents: z.array(AgentCapability).max(64),
  repositories: z.array(RepositoryCapability).max(256),
  subscriptions: Subscriptions,
  telemetry: TelemetryCapability.optional().describe(
    "The runner owner's cap on what telemetry leaves the machine; absent from older daemons, which send none",
  ),
});
export type RunnerCapabilities = z.infer<typeof RunnerCapabilities>;

/** A non-negative per-key cap. */
const cap = z.number().int().min(0).max(1000);

/**
 * How much work a runner takes at once: the machine, and optionally per role
 * and per agent. An absent key means no limit at that level.
 */
export const RunnerLimits = z.strictObject({
  maxParallelJobs: z.number().int().min(1).max(1000),
  roles: z.partialRecord(RunnerRole, cap).optional(),
  agents: z.record(identifier, cap).optional(),
});
export type RunnerLimits = z.infer<typeof RunnerLimits>;
