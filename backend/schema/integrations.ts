import { sql } from "drizzle-orm";
import {
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

/**
 * Every kind of system that can start agent work — a **trigger type**. Each
 * row that mirrors something in a trigger system carries one of these as
 * `type`, and keeps that system's own ids in `external*` columns. Linear is the
 * first; a new type adds a value here and its own ingress, client, and
 * `details` shape.
 */
export const TRIGGER_TYPES = ["linear"] as const;

/** One of {@link TRIGGER_TYPES}. */
export type TriggerType = (typeof TRIGGER_TYPES)[number];

/** Every state an integration can be in. */
export const INTEGRATION_STATUSES = ["active", "revoked", "error"] as const;

/** One of {@link INTEGRATION_STATUSES}. */
export type IntegrationStatus = (typeof INTEGRATION_STATUSES)[number];

/**
 * The last rate-limit headers the trigger system sent for this integration.
 * Epoch-ms reset times; `null` for a header it did not send.
 */
export interface RateLimitSnapshot {
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

/** A Linear integration's own state, in `integrations.details`. */
export interface LinearIntegrationDetails {
  appUserCapabilities: LinearAppUserCapabilities;
  /** The teams the workspace admin granted the app. */
  teamIds: string[];
  canAccessAllPublicTeams: boolean;
}

/** `integrations.details`, by trigger type. */
export interface IntegrationDetailsByType {
  linear: LinearIntegrationDetails;
}

/**
 * An `integration` is one project's connection to one workspace of one trigger
 * system — today a Linear workspace, where it is the `@hypotenuse` **app user**
 * (`actor=app`) and the OAuth tokens that act as it.
 *
 * - **One per project and type** (`(projectId, type)` unique). Reconnecting
 *   replaces the tokens on this row and keeps its id, so everything that later
 *   points at it keeps its foreign key.
 * - **One live row per external workspace** (`(type, externalWorkspaceId)`
 *   unique among rows that are not `revoked`). An inbound webhook carries only
 *   the workspace and app user ids, so two projects on one workspace could not
 *   be told apart. A disconnected row is kept — its mirrored sessions and audit
 *   rows still point at it — and the partial index is what lets the workspace
 *   connect elsewhere afterwards.
 * - **Tokens are AES-256-GCM sealed** (`ops/CryptoOps.ts`) and nulled on
 *   disconnect. No serializer has a field either one fits in.
 * - **What only one type has lives in `details`**, typed per type
 *   ({@link IntegrationDetailsByType}).
 *
 * `status` is `active` while the tokens work, `error` once a refresh has been
 * refused (an admin must reconnect), and `revoked` after a disconnect.
 */
export const integrations = pgTable(
  "integrations",
  {
    id: serial("id").primaryKey(),
    projectId: integer("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    type: text("type").$type<TriggerType>().notNull(),
    /** The workspace in the trigger system: Linear's organization id. */
    externalWorkspaceId: text("external_workspace_id").notNull(),
    workspaceName: text("workspace_name").notNull(),
    workspaceUrlKey: text("workspace_url_key").notNull(),
    /** The app's own user in that workspace: Linear's `viewer.id`. */
    externalAppUserId: text("external_app_user_id").notNull(),
    appUserName: text("app_user_name").notNull(),
    details: jsonb("details").$type<LinearIntegrationDetails>().notNull(),
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
    status: text("status")
      .$type<IntegrationStatus>()
      .notNull()
      .default("active"),
    connectedByUserId: integer("connected_by_user_id").references(
      () => users.id,
      { onDelete: "set null" },
    ),
    rateLimit: jsonb("rate_limit").$type<RateLimitSnapshot | null>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdateFn(() => new Date()),
  },
  (t) => ({
    projectTypeIndex: uniqueIndex("integrations_project_type_idx").on(
      t.projectId,
      t.type,
    ),
    liveWorkspaceIndex: uniqueIndex("integrations_workspace_live")
      .on(t.type, t.externalWorkspaceId)
      .where(sql`${t.status} <> 'revoked'`),
  }),
);

export type Integration = typeof integrations.$inferSelect;
export type NewIntegration = typeof integrations.$inferInsert;
