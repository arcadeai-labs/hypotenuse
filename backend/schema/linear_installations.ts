import { sql } from "drizzle-orm";
import {
  boolean,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { EncryptedSecret } from "../ops/CryptoOps";
import { projects } from "./projects";
import { users } from "./users";

/** Every state an installation can be in. */
export const LINEAR_INSTALLATION_STATUSES = [
  "active",
  "revoked",
  "error",
] as const;

/** One of {@link LINEAR_INSTALLATION_STATUSES}. */
export type LinearInstallationStatus =
  (typeof LINEAR_INSTALLATION_STATUSES)[number];

/**
 * The last `X-RateLimit-*` headers Linear sent for this installation. Epoch-ms
 * reset times; `null` for a header Linear did not send.
 */
export interface LinearRateLimitSnapshot {
  requestsLimit: number | null;
  requestsRemaining: number | null;
  requestsResetAt: number | null;
  complexityLimit: number | null;
  complexityRemaining: number | null;
  complexityResetAt: number | null;
  /** `X-Complexity`: what the last query cost. */
  lastComplexity: number | null;
  /** When these headers were seen. */
  observedAt: number;
}

/**
 * What Linear says the app user can do in this workspace, read with the app's
 * own token at install time.
 */
export interface LinearAppUserCapabilities {
  app: boolean;
  isAssignable: boolean;
  isMentionable: boolean;
  supportsAgentSessions: boolean;
}

/**
 * A `linear_installation` is one project's connection to one Linear workspace:
 * the `@hypotenuse` **app user** in that workspace (`actor=app`), and the OAuth
 * tokens that act as it.
 *
 * - **One per project** (`projectId` unique). Reconnecting replaces the tokens
 *   on this row and keeps its id, so everything that later points at it keeps
 *   its foreign key.
 * - **One live row per workspace** (`organizationId` unique among rows whose
 *   status is not `revoked`). An inbound webhook carries only the workspace and
 *   app user ids, so two projects on one workspace could not be told apart. A
 *   disconnected row is kept — its mirrored sessions and audit rows still point
 *   at it — and the partial index is what lets the workspace connect elsewhere
 *   afterwards.
 * - **Tokens are AES-256-GCM sealed** (`ops/CryptoOps.ts`) and nulled on
 *   disconnect. No serializer has a field either one fits in.
 *
 * `status` is `active` while the tokens work, `error` once a refresh has been
 * refused (an admin must reconnect), and `revoked` after a disconnect.
 */
export const linearInstallations = pgTable(
  "linear_installations",
  {
    id: serial("id").primaryKey(),
    projectId: integer("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    organizationId: text("organization_id").notNull(),
    organizationName: text("organization_name").notNull(),
    urlKey: text("url_key").notNull(),
    appUserId: text("app_user_id").notNull(),
    appUserName: text("app_user_name").notNull(),
    appUserCapabilities: jsonb("app_user_capabilities")
      .$type<LinearAppUserCapabilities>()
      .notNull(),
    oauthClientId: text("oauth_client_id").notNull(),
    scopes: jsonb("scopes").$type<string[]>().notNull(),
    accessTokenEncrypted: jsonb(
      "access_token_encrypted",
    ).$type<EncryptedSecret | null>(),
    refreshTokenEncrypted: jsonb(
      "refresh_token_encrypted",
    ).$type<EncryptedSecret | null>(),
    accessTokenLastFour: text("access_token_last_four").notNull().default(""),
    accessTokenExpiresAt: timestamp("access_token_expires_at", {
      withTimezone: true,
    }),
    /**
     * When an admin last completed the install for this row (first connect or
     * reconnect). Only the callback writes it, so a client waiting on a connect
     * can tell its own approval from a token refresh or a rate-limit write.
     */
    connectedAt: timestamp("connected_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastRefreshedAt: timestamp("last_refreshed_at", { withTimezone: true }),
    refreshFailedAt: timestamp("refresh_failed_at", { withTimezone: true }),
    refreshError: text("refresh_error"),
    canAccessAllPublicTeams: boolean("can_access_all_public_teams")
      .notNull()
      .default(false),
    teamIds: jsonb("team_ids").$type<string[]>().notNull(),
    status: text("status")
      .$type<LinearInstallationStatus>()
      .notNull()
      .default("active"),
    installedByUserId: integer("installed_by_user_id").references(
      () => users.id,
      { onDelete: "set null" },
    ),
    rateLimit: jsonb("rate_limit").$type<LinearRateLimitSnapshot | null>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdateFn(() => new Date()),
  },
  (t) => ({
    projectIndex: uniqueIndex("linear_installations_project_idx").on(
      t.projectId,
    ),
    liveOrganizationIndex: uniqueIndex("linear_installations_org_live")
      .on(t.organizationId)
      .where(sql`${t.status} <> 'revoked'`),
  }),
);

export type LinearInstallation = typeof linearInstallations.$inferSelect;
export type NewLinearInstallation = typeof linearInstallations.$inferInsert;
