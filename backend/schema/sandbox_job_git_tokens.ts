import {
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

/** What one credential request came to. */
export const GIT_HANDOUT_OUTCOMES = ["issued", "reused", "refused"] as const;

/** One of {@link GIT_HANDOUT_OUTCOMES}. */
export type GitHandoutOutcome = (typeof GIT_HANDOUT_OUTCOMES)[number];

/**
 * A `sandbox_job_git_token` is one credential request from a sandbox job's
 * git or `gh`, and what it came to: a GitHub installation token `issued`
 * (scoped to one repository, at `read` or `write`), the job's cached one
 * `reused`, or the request `refused` with the sentence git printed
 * (`reason`). The ledger of what a job reached on GitHub — the job page's
 * "git handouts" — and the list `finalizeSandboxJob` revokes from.
 *
 * Only an issued token's SHA-256 is stored here. The token itself — needed to
 * revoke it, since GitHub revokes a token only when it is presented — lives
 * in Redis under the job's key until the job ends. A ledger row: ids are
 * copied, never foreign keys, so it takes part in no lock.
 */
export const sandboxJobGitTokens = pgTable(
  "sandbox_job_git_tokens",
  {
    id: serial("id").primaryKey(),
    jobId: integer("job_id").notNull(),
    projectId: integer("project_id").notNull(),
    repository: text("repository").notNull(),
    permission: text("permission").$type<"read" | "write">(),
    outcome: text("outcome").$type<GitHandoutOutcome>().notNull(),
    reason: text("reason"),
    tokenHash: text("token_hash"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("sandbox_job_git_tokens_job_idx").on(t.jobId)],
);

export type SandboxJobGitToken = typeof sandboxJobGitTokens.$inferSelect;
