import {
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { conversations } from "./conversations";
import { projects } from "./projects";

/** Every state a pull request can be in, as GitHub reports it. */
export const PULL_REQUEST_STATES = ["open", "closed", "merged"] as const;

/** One of {@link PULL_REQUEST_STATES}. */
export type PullRequestState = (typeof PULL_REQUEST_STATES)[number];

/**
 * A `sandbox_job_pull_request` is a pull request a sandbox job opened: what
 * GitHub's review and CI events are matched to, and how they find their way
 * back to the conversation that asked for the work.
 *
 * `(host, owner, name, number)` is unique: a pull request belongs to the job
 * that opened it, and a later job that pushes to its branch to address a
 * review keeps it there. `conversationId` is the job's parent conversation,
 * copied here so an event is matched with one indexed read. `relayedAt` is
 * when the link was written to the conversation's surface.
 */
export const sandboxJobPullRequests = pgTable(
  "sandbox_job_pull_requests",
  {
    id: serial("id").primaryKey(),
    projectId: integer("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    jobId: integer("job_id").notNull(),
    conversationId: integer("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    host: text("host").notNull().default("github.com"),
    owner: text("owner").notNull(),
    name: text("name").notNull(),
    number: integer("number").notNull(),
    url: text("url").notNull(),
    title: text("title"),
    headRef: text("head_ref"),
    state: text("state").$type<PullRequestState>().notNull().default("open"),
    relayedAt: timestamp("relayed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdateFn(() => new Date()),
  },
  (t) => [
    uniqueIndex("sandbox_job_pull_requests_repo_number_idx").on(
      t.projectId,
      t.host,
      t.owner,
      t.name,
      t.number,
    ),
    index("sandbox_job_pull_requests_job_idx").on(t.jobId),
    index("sandbox_job_pull_requests_conversation_idx").on(t.conversationId),
  ],
);

export type SandboxJobPullRequest = typeof sandboxJobPullRequests.$inferSelect;
