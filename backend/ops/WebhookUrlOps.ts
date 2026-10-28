import { config } from "keryx";

/** The platforms that deliver webhooks to Hypotenuse. */
export const WEBHOOK_PLATFORMS = ["slack", "linear", "pylon"] as const;

/** One of {@link WEBHOOK_PLATFORMS}. */
export type WebhookPlatform = (typeof WEBHOOK_PLATFORMS)[number];

/**
 * Where each platform's webhook ingress is mounted, beneath the API route.
 *
 * Constants on purpose: every manifest Hypotenuse generates for a bot's
 * platform app embeds these URLs, and the ingress actions mount these exact
 * routes, so the two can never disagree. Changing one means editing every
 * installed app on that platform.
 */
export const WEBHOOK_ROUTES: Record<WebhookPlatform, string> = {
  slack: "/webhooks/slack",
  linear: "/webhooks/linear",
  pylon: "/webhooks/pylon",
};

/**
 * The absolute URL a platform delivers its webhooks to, derived from this
 * deployment's public origin (`APPLICATION_URL`) and API route.
 * @param platform - The delivering platform.
 * @returns The webhook URL, e.g. `https://api.example.com/api/webhooks/slack`.
 */
export function webhookUrl(platform: WebhookPlatform): string {
  const origin = config.server.web.applicationUrl.replace(/\/+$/, "");
  return `${origin}${config.server.web.apiRoute}${WEBHOOK_ROUTES[platform]}`;
}

/**
 * Every platform's webhook URL.
 * @returns One absolute URL per platform.
 */
export function webhookUrls(): Record<WebhookPlatform, string> {
  return {
    slack: webhookUrl("slack"),
    linear: webhookUrl("linear"),
    pylon: webhookUrl("pylon"),
  };
}
