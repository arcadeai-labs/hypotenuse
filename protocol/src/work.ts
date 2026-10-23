import { z } from "zod";
import { RunnerRole } from "./capabilities";
import { OFFER_KINDS } from "./heartbeat";
import { ClaimTelemetry } from "./telemetry";

/**
 * `daemon:claim`'s body. With `workItemIds`, only those offers (or items this
 * runner already holds, so a retried claim whose answer was lost gets the same
 * assignment back); without, the oldest offer to this runner.
 */
export const ClaimRequest = z.strictObject({
  workItemIds: z
    .array(z.number().int().positive())
    .max(100)
    .optional()
    .describe("Claim only these work items; omitted means any offer"),
});
export type ClaimRequest = z.infer<typeof ClaimRequest>;

/** The repository a turn works in. */
export const AssignmentRepository = z.looseObject({
  remote: z.string(),
  baseBranch: z.string().nullable(),
});
export type AssignmentRepository = z.infer<typeof AssignmentRepository>;

/** The issue a session is on, as the assignment carries it. */
export const AssignmentIssue = z.looseObject({
  id: z.string(),
  identifier: z.string().nullable(),
  title: z.string().nullable(),
  description: z.string().nullable(),
  url: z.string().nullable(),
  teamKey: z.string().nullable(),
  labels: z.array(z.string()),
  state: z.looseObject({ name: z.string(), type: z.string() }).nullable(),
  parent: z.looseObject({ id: z.string() }).nullable(),
  project: z.looseObject({ id: z.string(), name: z.string() }).nullable(),
});
export type AssignmentIssue = z.infer<typeof AssignmentIssue>;

/** One piece of guidance, nearest team first, workspace last. */
export const AssignmentGuidance = z.looseObject({
  origin: z.enum(["team", "workspace"]),
  teamKey: z.string().nullable().optional(),
  body: z.string(),
});
export type AssignmentGuidance = z.infer<typeof AssignmentGuidance>;

/** One turn of the conversation so far, rebuilt from activities. */
export const HistoryEntry = z.looseObject({
  seq: z.number().int(),
  activityId: z.number().int(),
  direction: z.enum(["inbound", "outbound"]),
  type: z.string(),
  body: z.string().nullable(),
  signal: z.string().nullable(),
});
export type HistoryEntry = z.infer<typeof HistoryEntry>;

/** One merged follow-up a person typed, in order. */
export const PromptEntry = z.looseObject({
  activityId: z.number().int(),
  body: z.string(),
});
export type PromptEntry = z.infer<typeof PromptEntry>;

/** The pull requests linked to a session, as its external links name them. */
export const AssignmentLink = z.looseObject({
  label: z.string(),
  url: z.string(),
});
export type AssignmentLink = z.infer<typeof AssignmentLink>;

/** How a manager handed a worker its turn: a new dispatch, or changes requested. */
export const DISPATCH_MODES = ["new", "changes"] as const;
export type DispatchMode = (typeof DISPATCH_MODES)[number];

/**
 * What a worker's turn carries when a manager session dispatched it: the
 * manager's instructions, the agent it would prefer, and the planning issue
 * it came from.
 */
export const AssignmentDispatch = z.looseObject({
  mode: z.enum(DISPATCH_MODES),
  reviewRound: z.number().int().min(0),
  instructions: z
    .string()
    .nullable()
    .describe(
      "Extra context from the planning agent; for `changes`, what to change",
    ),
  agentPreference: z
    .string()
    .nullable()
    .describe("An [agents] id the planning agent prefers; a preference only"),
  parent: z.looseObject({
    agentSessionId: z.number().int().positive(),
    issueIdentifier: z.string().nullable(),
    issueUrl: z.string().nullable(),
  }),
});
export type AssignmentDispatch = z.infer<typeof AssignmentDispatch>;

/** How a dispatched worker's turn ended, as its review reports it. */
export const REVIEW_OUTCOMES = ["completed", "failed", "cancelled"] as const;

/**
 * What a manager's review turn carries: one dispatched worker's result.
 * Linear lets no agent write a prompt, so this exists only in the turn.
 */
export const AssignmentReview = z.looseObject({
  childAgentSessionId: z.number().int().positive(),
  childIssueIdentifier: z.string().nullable(),
  childIssueUrl: z.string().nullable(),
  reviewRound: z.number().int().min(0),
  outcome: z.enum(REVIEW_OUTCOMES),
  finalResponse: z
    .string()
    .nullable()
    .describe("The body of the worker's last response or error"),
  plan: z
    .array(z.looseObject({ content: z.string(), status: z.string() }))
    .nullable(),
  pullRequests: z.array(AssignmentLink),
});
export type AssignmentReview = z.infer<typeof AssignmentReview>;

/**
 * Everything a daemon needs to run one turn. Loose: an older daemon ignores
 * fields a newer server adds.
 */
export const WorkAssignment = z.looseObject({
  workItemId: z.number().int().positive(),
  agentSessionId: z.number().int().positive(),
  type: z.string(),
  externalSessionId: z.string(),
  externalSessionUrl: z.string().nullable(),
  dashboardUrl: z.string(),
  kind: z.enum(OFFER_KINDS),
  role: RunnerRole,
  agentId: z.string().nullable(),
  fresh: z.boolean(),
  repository: AssignmentRepository.nullable(),
  branch: z.string().nullable(),
  issue: AssignmentIssue,
  instruction: z
    .string()
    .nullable()
    .describe(
      "What the mention said, a matched role prefix stripped; null for a delegation",
    ),
  promptContext: z.string().nullable(),
  guidance: z.array(AssignmentGuidance),
  previousComments: z.array(z.record(z.string(), z.unknown())).nullable(),
  history: z.array(HistoryEntry),
  prompt: z.array(PromptEntry).nullable(),
  origin: z.string(),
  creator: z
    .looseObject({ name: z.string().nullable(), email: z.string().nullable() })
    .nullable()
    .optional()
    .describe("Who started the session; null when an automation did"),
  humanDelegated: z.boolean(),
  leaseExpiresAt: z.number().int(),
  dispatch: AssignmentDispatch.nullable()
    .optional()
    .describe("Set when a manager session dispatched this worker turn"),
  review: AssignmentReview.nullable()
    .optional()
    .describe("Set on a manager's review turn: the worker result to review"),
  telemetry: ClaimTelemetry.nullable()
    .optional()
    .describe(
      "The turn's trace and what to collect for the project's exporters; null when nothing is exported",
    ),
});
export type WorkAssignment = z.infer<typeof WorkAssignment>;

/** `daemon:claim`'s answer: an assignment, or `null` when nothing was claimable. */
export const ClaimResponse = z.looseObject({
  assignment: WorkAssignment.nullable(),
});
export type ClaimResponse = z.infer<typeof ClaimResponse>;
