import { createHash, randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { api, config, ErrorType, TypedError } from "keryx";
// Type-only, purely for the `declare module "keryx"` augmentation inside.
import type {} from "../config/platforms";
import { platformAdapter } from "../platforms/registry";
import type { InstallationUrls } from "../platforms/types";
import {
  type BotInstallation,
  botInstallations,
} from "../schema/bot_installations";
import type { Bot } from "../schema/bots";
import type { DbHandle } from "./DbOps";

/**
 * Bot installations: one bot's own app on one platform workspace. The
 * routing key in its webhook URL is minted once, shown once, and stored only
 * as a hash; its credentials are sealed and never leave the server.
 */

/** The prefix every routing key carries, so one is recognizable in a leak. */
export const ROUTING_KEY_PREFIX = "hyp_rk_";

/**
 * A fresh routing key.
 * @returns The plaintext key.
 */
export function generateRoutingKey(): string {
  return `${ROUTING_KEY_PREFIX}${randomBytes(24).toString("base64url")}`;
}

/**
 * The hash a routing key is stored and looked up by.
 * @param key - The plaintext key.
 * @returns Its SHA-256, hex.
 */
export function hashRoutingKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/**
 * Where a platform delivers to an installation, and where its OAuth returns.
 * @param type - The platform.
 * @param routingKey - The plaintext routing key.
 * @returns The URLs.
 */
export function installationUrls(
  type: string,
  routingKey: string,
): InstallationUrls {
  const origin = config.server.web.applicationUrl.replace(/\/+$/, "");
  const base = `${origin}${config.server.web.apiRoute}`;
  return {
    events: `${base}/webhooks/${type}/${routingKey}`,
    oauthRedirect: `${base}/installation/oauth/callback`,
  };
}

export { openInstallation, sealCredentials } from "./InstallationCredentialOps";

/**
 * The installation a routing key names, if it may take deliveries.
 * @param type - The platform the URL named.
 * @param routingKey - The plaintext key from the path.
 * @param handshakeWhilePending - Also answer for an installation that has its
 *   signing credentials but is not installed yet (Slack verifies the URL then).
 * @param acknowledgeWhileInactive - Also answer for one that is errored or
 *   uninstalled but still holds its signing secret (Linear disables a webhook
 *   whose deliveries keep failing).
 * @returns The installation, or `null` for unknown, disabled, or uninstalled.
 */
export async function installationForRoutingKey(
  type: string,
  routingKey: string,
  handshakeWhilePending = false,
  acknowledgeWhileInactive = false,
): Promise<BotInstallation | null> {
  if (!routingKey.startsWith(ROUTING_KEY_PREFIX)) return null;
  const [row] = await api.db.db
    .select()
    .from(botInstallations)
    .where(
      and(
        eq(botInstallations.routingKeyHash, hashRoutingKey(routingKey)),
        eq(botInstallations.type, type),
      ),
    )
    .limit(1);
  if (!row) return null;
  if (row.status === "active") return row;
  if (acknowledgeWhileInactive && row.credentials !== null) return row;
  if (
    handshakeWhilePending &&
    row.credentials !== null &&
    (row.status === "pending" || row.status === "error")
  ) {
    return row;
  }
  return null;
}

/**
 * Shape an installation for any answer. Credentials and the routing key's
 * hash have no field here.
 * @param row - The installation.
 * @returns The serialized installation.
 */
export function serializeInstallation(row: BotInstallation) {
  return {
    id: row.id,
    projectId: row.projectId,
    botId: row.botId,
    type: row.type,
    externalWorkspaceId: row.externalWorkspaceId,
    externalAppId: row.externalAppId,
    externalBotUserId: row.externalBotUserId,
    config: row.config,
    hasCredentials: row.credentials !== null,
    credentialVersion: row.credentialVersion,
    status: row.status,
    lastError: row.lastError,
    installedByUserId: row.installedByUserId,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

/**
 * The 404 every unreadable or missing installation answers with.
 * @returns The error.
 */
export function installationNotFound(): TypedError {
  return new TypedError({
    message: "Installation not found in this project",
    type: ErrorType.CONNECTION_ACTION_NOT_FOUND,
  });
}

/**
 * The platform adapter for a type, or a validation error naming the field.
 * @param type - The platform.
 * @returns The adapter.
 * @throws {TypedError} `CONNECTION_ACTION_PARAM_VALIDATION`.
 */
export function requirePlatform(type: string) {
  const adapter = platformAdapter(type);
  if (!adapter) {
    throw new TypedError({
      message: `There is no "${type}" platform.`,
      type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
      key: "type",
    });
  }
  return adapter;
}

/**
 * Load an installation of a bot in a project.
 * @param db - A database handle.
 * @param projectId - The project.
 * @param installationId - The installation.
 * @returns The row and its bot.
 * @throws {TypedError} `CONNECTION_ACTION_NOT_FOUND`.
 */
export async function loadInstallation(
  db: DbHandle,
  projectId: number,
  installationId: number,
): Promise<BotInstallation> {
  const [row] = await db
    .select()
    .from(botInstallations)
    .where(
      and(
        eq(botInstallations.id, installationId),
        eq(botInstallations.projectId, projectId),
      ),
    )
    .limit(1);
  if (!row) throw installationNotFound();
  return row;
}

/**
 * The manifest for a bot's app on a platform.
 * @param bot - The bot.
 * @param type - The platform.
 * @param routingKey - The plaintext routing key.
 * @returns The manifest and the URLs it embeds.
 */
export function manifestFor(bot: Bot, type: string, routingKey: string) {
  const adapter = requirePlatform(type);
  const urls = installationUrls(type, routingKey);
  return { urls, ...adapter.manifest(bot, urls) };
}

/** An install in progress: who started it, for which installation. */
export interface PendingInstall {
  installationId: number;
  projectId: number;
  botId: number;
  userId: number;
  /** The PKCE verifier, for a platform whose install uses PKCE. */
  codeVerifier?: string;
}

/**
 * A fresh PKCE verifier and its S256 challenge.
 * @returns Both.
 */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/**
 * The Redis key of an install's state.
 * @param state - The state.
 * @returns The key.
 */
function installKey(state: string): string {
  return `installation:oauth:${createHash("sha256").update(state).digest("hex")}`;
}

/**
 * Begin an OAuth install: a single-use `state`, bound to the installation
 * and the person, that lives for `installStateTtlSeconds`.
 * @param pending - The installation and the person.
 * @returns The state, for the authorize URL.
 */
export async function startInstall(pending: PendingInstall): Promise<string> {
  const state = randomBytes(24).toString("base64url");
  await api.redis.redis.set(
    installKey(state),
    JSON.stringify(pending),
    "EX",
    config.platforms.slack.installStateTtlSeconds,
  );
  return state;
}

/**
 * Take an install's state: it works once.
 * @param state - The state the platform returned.
 * @returns The install, or `null` for an unknown, used, or expired state.
 */
export async function takeInstall(
  state: string,
): Promise<PendingInstall | null> {
  const raw = await api.redis.redis.getdel(installKey(state));
  return raw ? (JSON.parse(raw) as PendingInstall) : null;
}
