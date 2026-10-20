import { config } from "keryx";
// Type-only: brings the `config.linear` augmentation into every program that
// type-checks this file (the frontend reaches it through the status action).
import type {} from "../config/linear";

/**
 * Join a path onto this deployment's public API origin (`APPLICATION_URL`),
 * under the API route prefix.
 * @param path - Route beneath the API prefix, starting with `/`.
 * @returns The absolute URL.
 */
function apiUrl(path: string): string {
  const origin = config.server.web.applicationUrl.replace(/\/+$/, "");
  return `${origin}${config.server.web.apiRoute}${path}`;
}

/**
 * Where Linear delivers this deployment's webhooks. Pasted into the Linear OAuth
 * app's settings; it must be public HTTPS, so in development it is the tunnel.
 * @returns The absolute webhook URL.
 */
export function linearWebhookUrl(): string {
  return apiUrl("/webhooks/linear");
}

/**
 * Where Linear redirects after a workspace admin approves the install. Must match
 * a redirect URI registered on the Linear OAuth app exactly.
 * @returns The absolute OAuth callback URL.
 */
export function linearCallbackUrl(): string {
  return apiUrl("/linear/callback");
}

/**
 * Whether the Linear OAuth app's credentials are present. Says nothing about
 * whether they are right — only the OAuth flow can.
 * @returns True when client id, client secret, and webhook secret are all set.
 */
export function linearConfigured(): boolean {
  const { clientId, clientSecret, webhookSecret } = config.linear;
  return Boolean(clientId && clientSecret && webhookSecret);
}
