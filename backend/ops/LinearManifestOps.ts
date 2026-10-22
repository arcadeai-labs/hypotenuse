import { config } from "keryx";
import { linearCallbackUrl, linearWebhookUrl } from "./LinearOps";

/** Where Linear's app-creation form lives; `?manifest=` pre-fills it. */
export const LINEAR_APP_CREATION_URL =
  "https://linear.app/settings/api/applications/new";

/** The manifest schema Linear publishes, and the version this writes. */
export const LINEAR_MANIFEST_SCHEMA_URL =
  "https://linear.app/.well-known/oauth-app-manifest.schema.json";

/**
 * The webhook resource types the app subscribes to. `OAuthApp` (revocation) is
 * not in the manifest's enum: it is a toggle on the app's settings page, which
 * `docs/DEPLOY.md` says to switch on by hand.
 */
export const LINEAR_WEBHOOK_RESOURCE_TYPES = [
  "AgentSessionEvent",
  "AppUserNotification",
  "PermissionChange",
  "Issue",
  "Comment",
] as const;

/** An OAuth app manifest, as far as this deployment fills one in. */
export interface LinearAppManifest {
  $schema: string;
  schemaVersion: "1.0.0";
  distribution: "public";
  developer: { name: string };
  oauth: {
    client_name: string;
    client_uri: string;
    redirect_uris: string[];
    grant_types: ["authorization_code"];
  };
  webhook: { enabled: true; url: string; resourceTypes: string[] };
}

/**
 * Refuse a client name Linear would refuse, with a message that says why.
 * Linear rejects names that are not 2–80 characters, contain "Linear", or carry
 * a URL — and its own error for a deployment called "Linear Bot" says less.
 * @param name - The proposed `oauth.client_name`.
 * @throws {Error} If Linear would refuse the name.
 */
export function assertClientName(name: string): void {
  if (name.length < 2 || name.length > 80) {
    throw new Error("The Linear app name must be 2–80 characters");
  }
  if (/linear/i.test(name)) {
    throw new Error('The Linear app name must not contain "Linear"');
  }
  if (/https?:\/\//i.test(name)) {
    throw new Error("The Linear app name must not contain a URL");
  }
}

/**
 * Refuse a webhook URL Linear would refuse: it must be public HTTPS, and not a
 * loopback, private-network, or `linear.app` host. Local development gets one
 * from the ngrok tunnel (`bun run ngrok`).
 * @param url - The proposed `webhook.url`.
 * @throws {Error} If Linear would refuse the URL.
 */
export function assertPublicWebhookUrl(url: string): void {
  const parsed = new URL(url);
  const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const reason =
    parsed.protocol !== "https:"
      ? "it is not HTTPS"
      : host === "localhost" ||
          host.endsWith(".localhost") ||
          /^127\./.test(host) ||
          host === "::1" ||
          host === "0.0.0.0"
        ? "it is a loopback address"
        : /^10\./.test(host) ||
            /^192\.168\./.test(host) ||
            /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
            /^169\.254\./.test(host) ||
            /^f[cd][0-9a-f]{2}:/.test(host) ||
            /^fe80:/.test(host)
          ? "it is a private-network address"
          : host === "linear.app" || host.endsWith(".linear.app")
            ? "it is a linear.app host"
            : null;
  if (reason) {
    throw new Error(
      `Linear only delivers webhooks to public HTTPS URLs, and ${url} is refused because ${reason}. Set APPLICATION_URL to the deployment's public origin (in development, the ngrok tunnel from \`bun run ngrok\`).`,
    );
  }
}

/**
 * Build the manifest for this deployment's Linear OAuth app: the callback and
 * webhook URLs derived from `APPLICATION_URL`, the dashboard as the client URI,
 * and the webhook resource types the agent needs.
 * @param options.name - The app's name in Linear (`@<name>` in mentions).
 * @param options.developer - Who is shown as the app's developer.
 * @returns The manifest.
 * @throws {Error} If Linear would refuse the name or the webhook URL.
 */
export function buildAppManifest(
  options: { name?: string; developer?: string } = {},
): LinearAppManifest {
  const name = options.name ?? "Hypotenuse";
  assertClientName(name);
  const webhookUrl = linearWebhookUrl();
  assertPublicWebhookUrl(webhookUrl);
  const dashboard = config.cliAuth.appUrl.replace(/\/+$/, "");
  return {
    $schema: LINEAR_MANIFEST_SCHEMA_URL,
    schemaVersion: "1.0.0",
    // Public means other workspaces may install it — each project connects its
    // own workspace to this one app. It does not list the app in Linear's
    // integration directory; that is a separate submission.
    distribution: "public",
    developer: { name: options.developer ?? name },
    oauth: {
      client_name: name,
      client_uri: dashboard,
      redirect_uris: [linearCallbackUrl()],
      grant_types: ["authorization_code"],
    },
    webhook: {
      enabled: true,
      url: webhookUrl,
      resourceTypes: [...LINEAR_WEBHOOK_RESOURCE_TYPES],
    },
  };
}

/**
 * The pre-filled app-creation link: Linear's form with the manifest in one
 * `manifest` query parameter.
 * @param options - As {@link buildAppManifest}.
 * @returns The link an operator opens to create the app.
 */
export function buildAppManifestUrl(
  options: { name?: string; developer?: string } = {},
): string {
  const url = new URL(LINEAR_APP_CREATION_URL);
  url.searchParams.set("manifest", JSON.stringify(buildAppManifest(options)));
  return url.toString();
}
