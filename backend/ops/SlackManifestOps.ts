import type { InstallationUrls } from "../platforms/types";
import type { Bot } from "../schema/bots";

/**
 * **A bot's Slack app manifest.** Every bot is its own Slack app, so it has
 * its own `@handle`, avatar, channel membership, and line in Slack's audit
 * log. The manifest follows Slack's published schema
 * (https://github.com/slackapi/manifest-schema, `manifest.schema.1.0.0.json`;
 * the test suite validates every manifest against it) and is the same JSON a
 * person pastes into "Create an app → From a manifest" or that
 * `slack:app-create` sends to `apps.manifest.create`.
 */

/** The bot token's scopes: what the bot may read and write, and nothing more. */
export const SLACK_BOT_SCOPES = [
  "app_mentions:read",
  "channels:history",
  "groups:history",
  "im:history",
  "channels:read",
  "groups:read",
  "im:read",
  "chat:write",
  "assistant:write",
  "users:read",
  "reactions:write",
  "files:read",
] as const;

/** The bot events the app subscribes to (https://api.slack.com/events). */
export const SLACK_BOT_EVENTS = [
  "app_mention",
  "message.channels",
  "message.groups",
  "message.im",
  "member_joined_channel",
  "channel_left",
  "group_left",
  "app_uninstalled",
  "tokens_revoked",
  "app_home_opened",
] as const;

/**
 * Clip a string to a length, never to nothing.
 * @param text - The string.
 * @param max - The limit.
 * @param fallback - What to use when it is empty.
 * @returns The clipped string.
 */
function clip(text: string, max: number, fallback: string): string {
  const t = text.trim() || fallback;
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * **The manifest for one bot's Slack app.**
 * @param bot - The bot.
 * @param urls - Where Slack delivers events and interactions, and where OAuth returns.
 * @returns The manifest, in Slack's format.
 */
export function buildSlackManifest(
  bot: Pick<Bot, "displayName" | "description" | "slug">,
  urls: InstallationUrls,
): Record<string, unknown> {
  const description = clip(
    bot.description,
    140,
    `${bot.displayName}, a Hypotenuse bot.`,
  );
  return {
    _metadata: { major_version: 1, minor_version: 1 },
    display_information: {
      name: clip(bot.displayName, 35, bot.slug),
      description,
      background_color: "#1f2328",
    },
    features: {
      app_home: {
        home_tab_enabled: false,
        messages_tab_enabled: true,
        messages_tab_read_only_enabled: false,
      },
      bot_user: {
        display_name: clip(bot.displayName, 80, bot.slug),
        always_online: true,
      },
      assistant_view: {
        assistant_description: description,
      },
    },
    oauth_config: {
      redirect_urls: [urls.oauthRedirect],
      scopes: { bot: [...SLACK_BOT_SCOPES] },
    },
    settings: {
      event_subscriptions: {
        request_url: urls.events,
        bot_events: [...SLACK_BOT_EVENTS],
      },
      interactivity: { is_enabled: true, request_url: urls.events },
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
    },
  };
}
