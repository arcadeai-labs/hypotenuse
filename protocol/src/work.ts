import { z } from "zod";
import { RunnerRole } from "./capabilities";
import { OFFER_KINDS } from "./heartbeat";

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
  humanDelegated: z.boolean(),
  leaseExpiresAt: z.number().int(),
});
export type WorkAssignment = z.infer<typeof WorkAssignment>;

/** `daemon:claim`'s answer: an assignment, or `null` when nothing was claimable. */
export const ClaimResponse = z.looseObject({
  assignment: WorkAssignment.nullable(),
});
export type ClaimResponse = z.infer<typeof ClaimResponse>;
