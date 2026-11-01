import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { sandboxJobs } from "./sandbox_jobs";

/** Every status a sandbox question can be in. */
export const SANDBOX_QUESTION_STATUSES = [
  "pending",
  "answered",
  "expired",
  "cancelled",
] as const;

/** One of {@link SANDBOX_QUESTION_STATUSES}. */
export type SandboxQuestionStatus = (typeof SANDBOX_QUESTION_STATUSES)[number];

/**
 * Who a question goes to: `conversation` (`sandbox:ask`, relayed to the
 * conversation the job belongs to) or `team` (`sandbox:request-help`, a help
 * request in the project's Help inbox).
 */
export const SANDBOX_QUESTION_KINDS = ["conversation", "team"] as const;

/** One of {@link SANDBOX_QUESTION_KINDS}. */
export type SandboxQuestionKind = (typeof SANDBOX_QUESTION_KINDS)[number];

/** Who answered: the bot, a person on the dashboard, or the team's inbox. */
export interface SandboxAnsweredBy {
  kind: "bot" | "user" | "help";
  userId?: number | null;
  name?: string | null;
}

/**
 * A question a coding agent asked from inside a sandbox. Asking returns its id
 * at once; `sandbox:check-answer` collects the answer later ("ask now,
 * collect later"), and a check that runs out is `pending` with `timedOut`,
 * never an error. A job asks at most `config.sandbox.questionCap`, counted
 * under the job's row lock. `helpRequestId` is set for a `team` question.
 */
export const sandboxJobQuestions = pgTable(
  "sandbox_job_questions",
  {
    id: serial("id").primaryKey(),
    jobId: integer("job_id")
      .notNull()
      .references(() => sandboxJobs.id, { onDelete: "cascade" }),
    kind: text("kind").$type<SandboxQuestionKind>().notNull(),
    question: text("question").notNull(),
    options: jsonb("options").$type<string[]>(),
    blocking: boolean("blocking").notNull().default(true),
    urgency: text("urgency"),
    status: text("status")
      .$type<SandboxQuestionStatus>()
      .notNull()
      .default("pending"),
    answer: text("answer"),
    answeredBy: jsonb("answered_by").$type<SandboxAnsweredBy>(),
    helpRequestId: integer("help_request_id"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    answeredAt: timestamp("answered_at", { withTimezone: true }),
  },
  (t) => [index("sandbox_job_questions_job_idx").on(t.jobId, t.id)],
);

export type SandboxJobQuestion = typeof sandboxJobQuestions.$inferSelect;
