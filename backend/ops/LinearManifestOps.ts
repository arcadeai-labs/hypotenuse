import { config } from "keryx";
// Type-only, purely for the `declare module "keryx"` augmentation inside.
import type {} from "../config/frontend";
import type {} from "../config/platforms";
import type { InstallationUrls } from "../platforms/types";
import type { Bot } from "../schema/bots";

/**
 * **A bot's Linear app, as Linear's app manifest** (`schemaVersion 1.0.0`).
 * Linear has no app-creation API: a workspace admin opens the pre-filled
 * creation link (`?manifest=` on Linear's new-application form), creates the
 * app, and pastes its client id, client secret, and webhook signing secret
 * back into Hypotenuse. One app per bot, so each bot is its own delegate,
 * mention, and actor in Linear.
 *
 * - `distribution: public`, or a second workspace cannot install it (public
 *   does not list it in Linear's directory; that is a separate submission).
 * - The webhook subscribes to agent sessions, inbox notifications, permission
 *   changes, and issues (for un-delegation and an issue completed or deleted).
 *   Revocation (`OAuthApp`) is a toggle on the app's settings page, not in
 *   the manifest's enum: the instructions say to switch it on.
 * - `oauth` is closed (`additionalProperties: false`): the description lives
 *   in `display`, and `grant_types` admits only `authorization_code` and
 *   `client_credentials`. Refresh tokens need no grant here; Linear issues
 *   one with every authorization-code token.
 */

/** The manifest schema Linear publishes. */
export const LINEAR_MANIFEST_SCHEMA_URL =
  "https://linear.app/.well-known/oauth-app-manifest.schema.json";

/** The webhook resource types a bot's app subscribes to. */
export const LINEAR_WEBHOOK_RESOURCE_TYPES = [
  "AgentSessionEvent",
  "AppUserNotification",
  "PermissionChange",
  "Issue",
] as const;

/** The scopes an install asks for, with `actor=app`. */
export const LINEAR_SCOPES = [
  "read",
  "write",
  "app:assignable",
  "app:mentionable",
  "issues:create",
  "comments:create",
] as const;

/**
 * Why Linear would refuse an app name, if it would. Linear refuses names that
 * are not 2–80 characters, contain "Linear", or carry a URL.
 * @param name - The proposed name.
 * @returns The reason, or `null`.
 */
export function clientNameProblem(name: string): string | null {
  if (name.length < 2 || name.length > 80) {
    return "Linear wants an app name of 2–80 characters";
  }
  if (/linear/i.test(name))
    return 'Linear refuses an app name containing "Linear"';
  if (/https?:\/\//i.test(name)) return "Linear refuses an app name with a URL";
  return null;
}

/**
 * Why Linear would refuse a webhook URL, if it would: it delivers only to
 * public HTTPS, never to a loopback, private-network, or `linear.app` host.
 * @param url - The proposed webhook URL.
 * @returns The reason, or `null`.
 */
export function webhookUrlProblem(url: string): string | null {
  const parsed = new URL(url);
  const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (parsed.protocol !== "https:") return "it is not HTTPS";
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    /^127\./.test(host) ||
    host === "::1" ||
    host === "0.0.0.0"
  ) {
    return "it is a loopback address";
  }
  if (
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^f[cd][0-9a-f]{2}:/.test(host) ||
    /^fe80:/.test(host)
  ) {
    return "it is a private-network address";
  }
  if (host === "linear.app" || host.endsWith(".linear.app")) {
    return "it is a linear.app host";
  }
  return null;
}

/**
 * The manifest for one bot's Linear app.
 * @param bot - The bot.
 * @param urls - Where the app points: its webhook and the OAuth redirect.
 * @returns The manifest.
 */
export function buildLinearManifest(
  bot: Pick<Bot, "displayName" | "description">,
  urls: InstallationUrls,
): Record<string, unknown> {
  return {
    $schema: LINEAR_MANIFEST_SCHEMA_URL,
    schemaVersion: "1.0.0",
    distribution: "public",
    ...(bot.description
      ? { display: { description: bot.description.slice(0, 1000) } }
      : {}),
    developer: { name: bot.displayName },
    oauth: {
      client_name: bot.displayName,
      client_uri: config.frontend.url.replace(/\/+$/, ""),
      redirect_uris: [urls.oauthRedirect],
      grant_types: ["authorization_code"],
    },
    webhook: {
      enabled: true,
      url: urls.events,
      resourceTypes: [...LINEAR_WEBHOOK_RESOURCE_TYPES],
    },
  };
}

/**
 * The pre-filled app-creation link: Linear's form with the manifest in one
 * `manifest` query parameter.
 * @param manifest - The manifest.
 * @returns The link a workspace admin opens.
 */
export function linearAppCreationLink(
  manifest: Record<string, unknown>,
): string {
  const url = new URL(config.platforms.linear.appCreationUrl);
  url.searchParams.set("manifest", JSON.stringify(manifest));
  return url.toString();
}
