import {
  boolean,
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { githubInstallations } from "./github_installations";
import { projects } from "./projects";
import { users } from "./users";

/**
 * A `repository_grant` is a project admin's decision that bots in the project
 * may reach one repository, and whether they may push to it.
 *
 * - `host` / `owner` / `name` — the repository, owner and name lowercased
 *   (GitHub compares them without case). `host` is `github.com` today; it is
 *   a column so another host can arrive without a migration of every row.
 * - `githubInstallationId` — the attached installation the repository is
 *   reached through (its account is `owner`).
 * - `push` — **the one enforced half**: it decides whether the token a sandbox
 *   is handed carries the installation's repository permissions at `write`
 *   or at `read`. A grant without it holds a credential GitHub itself refuses
 *   a push from.
 * - `branchPrefix` — the branch namespace a job is *asked* to push into
 *   (default `hypotenuse/<bot-slug>/`). Guidance, not a gate: an installation
 *   token's narrowest unit is `contents` on a repository, which is write to
 *   every ref. A repository ruleset on GitHub is what enforces it.
 * - `botIds` — the bots that may use the grant; `null` means every bot in the
 *   project.
 */
export const repositoryGrants = pgTable(
  "repository_grants",
  {
    id: serial("id").primaryKey(),
    projectId: integer("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    githubInstallationId: integer("github_installation_id")
      .notNull()
      .references(() => githubInstallations.id, { onDelete: "cascade" }),
    host: text("host").notNull().default("github.com"),
    owner: text("owner").notNull(),
    name: text("name").notNull(),
    push: boolean("push").notNull().default(false),
    branchPrefix: text("branch_prefix"),
    botIds: integer("bot_ids").array(),
    createdByUserId: integer("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdateFn(() => new Date()),
  },
  (t) => [
    uniqueIndex("repository_grants_repo_idx").on(
      t.projectId,
      t.host,
      t.owner,
      t.name,
    ),
    index("repository_grants_installation_idx").on(t.githubInstallationId),
  ],
);

export type RepositoryGrant = typeof repositoryGrants.$inferSelect;
export type NewRepositoryGrant = typeof repositoryGrants.$inferInsert;
