import {
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

/**
 * A `github_installation` is one installation of the deployment's GitHub App
 * (on an organization or a user account) that a project may use. The App is
 * one for the whole deployment; what a project attaches is only the
 * installation — which repositories that App was granted on the account.
 *
 * An installation is attached only by a person GitHub says can see it: the
 * install callback exchanges the OAuth `code` for a user token and asks
 * `GET /user/installations`, because the `installation_id` on the callback's
 * query string can be spoofed. One installation may be attached to more than
 * one project; `(projectId, installationId)` is unique.
 *
 * - `installationId` — GitHub's id, kept as text (an external id is never
 *   coerced).
 * - `accountLogin` / `accountType` — the organization or user it is on.
 * - `permissions` — the installation's permission map as GitHub last reported
 *   it, shown to people; each mint re-reads the live map.
 * - `suspendedAt` / `revokedAt` — set from the App's `installation` webhook
 *   (`suspend`, `deleted`). Neither mints a token.
 */
export const githubInstallations = pgTable(
  "github_installations",
  {
    id: serial("id").primaryKey(),
    projectId: integer("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    installationId: text("installation_id").notNull(),
    accountLogin: text("account_login").notNull(),
    accountType: text("account_type").notNull(),
    permissions: jsonb("permissions")
      .$type<Record<string, string>>()
      .notNull()
      .default({}),
    attachedByUserId: integer("attached_by_user_id").references(
      () => users.id,
      { onDelete: "set null" },
    ),
    suspendedAt: timestamp("suspended_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdateFn(() => new Date()),
  },
  (t) => [
    uniqueIndex("github_installations_project_installation_idx").on(
      t.projectId,
      t.installationId,
    ),
    index("github_installations_installation_idx").on(t.installationId),
  ],
);

export type GithubInstallation = typeof githubInstallations.$inferSelect;
export type NewGithubInstallation = typeof githubInstallations.$inferInsert;
