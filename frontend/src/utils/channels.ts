/**
 * Pure helpers for a bot's channels: which platforms it can be installed on,
 * how its channels split into bound and unbound, and what binding one asks a
 * person to confirm.
 */

/** A platform a bot can be installed on, as the Channels section offers it. */
export interface InstallablePlatform {
  type: string;
  label: string;
  /** What connecting it takes, in a sentence. */
  summary: string;
}

/** The platforms with an installation today, in the order they are drawn. */
export const INSTALLABLE_PLATFORMS: readonly InstallablePlatform[] = [
  {
    type: "slack",
    label: "Slack",
    summary:
      "The bot as its own Slack app: create it from a manifest, install it into your workspace, and invite it to channels with /invite.",
  },
  {
    type: "linear",
    label: "Linear",
    summary:
      "The bot as its own Linear app: create it from a pre-filled link, install it into your workspace, and delegate issues to it or mention it.",
  },
  {
    type: "webhook",
    label: "Webhook",
    summary:
      "Any system that can POST signed JSON: it sends people's messages to the bot's events URL, and receives the bot's messages at a delivery URL you choose.",
  },
];

/** The sentence a person confirms before binding a private channel, verbatim. */
export const PRIVATE_AUDIENCE_SENTENCE =
  "Everyone who can read this bot in Hypotenuse will be able to read this channel's conversations and memory.";

/** The sentence a person confirms before binding a shared channel. */
export const SHARED_AUDIENCE_SENTENCE =
  "This channel is shared with another organization: its people will be able to talk to this bot.";

/** A channel as `channel:list?botId=` answers it, reduced to what these helpers read. */
export interface ChannelLike {
  id: number;
  isPrivate: boolean;
  isShared: boolean;
  binding: unknown | null;
}

/**
 * Split a bot's channels into those it is bound to and those that have
 * messaged it without a binding, keeping the server's order in each.
 * @param channels - `channel:list?botId=`'s rows.
 * @returns `bound` and `unbound`.
 */
export function splitChannels<T extends ChannelLike>(
  channels: readonly T[],
): { bound: T[]; unbound: T[] } {
  return {
    bound: channels.filter((c) => c.binding !== null),
    unbound: channels.filter((c) => c.binding === null),
  };
}

/** What binding a channel asks a person to confirm, and what the request then carries. */
export interface BindConfirmation {
  /** The sentences to confirm, empty when binding needs no confirmation. */
  sentences: string[];
  /** The fields `channel-binding:create` takes for what was confirmed. */
  flags: { confirmAudience?: true; allowShared?: true };
}

/**
 * What binding a channel takes: a private channel's audience said in so
 * many words and confirmed (`confirmAudience`), a shared channel's other
 * organization named and allowed (`allowShared`), both for one that is both.
 * @param channel - The channel.
 * @returns See {@link BindConfirmation}.
 */
export function bindConfirmation(
  channel: Pick<ChannelLike, "isPrivate" | "isShared">,
): BindConfirmation {
  const sentences: string[] = [];
  const flags: BindConfirmation["flags"] = {};
  if (channel.isPrivate) {
    sentences.push(PRIVATE_AUDIENCE_SENTENCE);
    flags.confirmAudience = true;
  }
  if (channel.isShared) {
    sentences.push(SHARED_AUDIENCE_SENTENCE);
    flags.allowShared = true;
  }
  return { sentences, flags };
}

/** How a binding listens, as a select reads it. */
export const BINDING_MODES = [
  { value: "mentions", label: "When mentioned" },
  { value: "all", label: "Every message" },
  { value: "dm", label: "Direct messages" },
] as const;

/** When a message reaches a working bot, as a select reads it. */
export const BINDING_DELIVERIES = [
  { value: "steer", label: "Before its next step" },
  { value: "queue", label: "After its turn" },
] as const;

/** Who decides approvals from the channel, as a select reads it. */
export const APPROVAL_POLICIES = [
  { value: "dashboard", label: "Only in the dashboard" },
  { value: "participants", label: "Anyone in the channel" },
  { value: "listed", label: "Only listed people" },
] as const;

/**
 * Read a list of platform user ids typed one per line or comma-separated.
 * @param text - What was typed.
 * @returns The ids, trimmed, without blanks or repeats.
 */
export function parseExternalIds(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[\n,]/)
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
}

/**
 * An installation's status, as a chip reads.
 * @param status - `pending`, `active`, `error`, or `uninstalled`.
 * @returns The words.
 */
export function installationStatusLabel(status: string): string {
  switch (status) {
    case "active":
      return "Connected";
    case "pending":
      return "Waiting to be connected";
    case "error":
      return "Not delivering";
    case "uninstalled":
      return "Uninstalled";
    default:
      return status;
  }
}
