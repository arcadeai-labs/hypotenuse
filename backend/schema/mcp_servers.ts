import {
  boolean,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import type { EncryptedSecret } from "../ops/CryptoOps";
import { projects } from "./projects";
import { users } from "./users";

/** How a server authenticates the requests Hypotenuse makes to it. */
export const MCP_AUTH_MODES = ["none", "headers", "bearer", "oauth"] as const;

/** One of {@link MCP_AUTH_MODES}. */
export type McpAuthMode = (typeof MCP_AUTH_MODES)[number];

/** The transports a server may speak. Only Streamable HTTP: a hosted service spawns no tenant commands. */
export const MCP_TRANSPORTS = ["streamable-http"] as const;

/** Whether a server last answered: it did, it failed, or it waits for a person to sign in. */
export const MCP_SERVER_STATUSES = ["ok", "error", "needs_auth"] as const;

/** One of {@link MCP_SERVER_STATUSES}. */
export type McpServerStatus = (typeof MCP_SERVER_STATUSES)[number];

/** One tool in a server's cached catalog, as `tools/list` described it. */
export interface McpCatalogTool {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

/** The OAuth client Hypotenuse registered (or was given) at a server's authorization server. */
export interface McpOAuthClient {
  clientId: string;
  clientSecret?: string;
  /** The authorization server's issuer. */
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  /** The protected resource the tokens are for (RFC 8707). */
  resource: string;
  scope?: string;
}

/** The tokens an OAuth sign-in produced. */
export interface McpOAuthTokens {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms, when the provider said. */
  expiresAt?: number;
}

/**
 * An `mcp_server` is one MCP server a project connects once, for its bots to
 * use: a Streamable HTTP URL and how to authenticate to it.
 *
 * Every credential is sealed with `CryptoOps`: `credentials` holds the
 * encrypted JSON of the static headers (`headers`) or the bearer token
 * (`bearer`), and `oauthClient` / `oauthTokens` the OAuth client and its
 * tokens. None of them is ever returned — `serializeMcpServer` carries only the
 * header names and the bearer's last four. `credentialVersion` is bumped by
 * every change to any of them, which retires every pooled client built with
 * the old ones.
 *
 * `toolsCache` is the server's catalog as `tools/list` last answered, refreshed
 * by `mcp-servers:refresh` and on demand; `status` / `lastError` record the
 * last connection.
 */
export const mcpServers = pgTable(
  "mcp_servers",
  {
    id: serial("id").primaryKey(),
    projectId: integer("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 64 }).notNull(),
    url: text("url").notNull(),
    transport: text("transport").notNull().default("streamable-http"),
    authMode: text("auth_mode").$type<McpAuthMode>().notNull(),
    credentials: jsonb("credentials").$type<EncryptedSecret>(),
    /** The header names (never values) of a `headers` server, for display. */
    headerNames: jsonb("header_names").$type<string[]>().notNull().default([]),
    /** The last four characters of a `bearer` server's token, for display. */
    lastFour: varchar("last_four", { length: 4 }),
    oauthClient: jsonb("oauth_client").$type<EncryptedSecret>(),
    oauthTokens: jsonb("oauth_tokens").$type<EncryptedSecret>(),
    credentialVersion: integer("credential_version").notNull().default(1),
    enabled: boolean("enabled").notNull().default(true),
    /** A per-call timeout for this server's tools, overriding the deployment's. */
    timeoutMs: integer("timeout_ms"),
    status: text("status").$type<McpServerStatus>().notNull().default("ok"),
    lastError: text("last_error"),
    toolsCache: jsonb("tools_cache")
      .$type<McpCatalogTool[]>()
      .notNull()
      .default([]),
    toolsRefreshedAt: timestamp("tools_refreshed_at", { withTimezone: true }),
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
  (t) => [uniqueIndex("mcp_servers_project_name_idx").on(t.projectId, t.name)],
);

export type McpServer = typeof mcpServers.$inferSelect;
export type NewMcpServer = typeof mcpServers.$inferInsert;
