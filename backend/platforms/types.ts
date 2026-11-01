import type { z } from "zod";
import type { BotInstallation } from "../schema/bot_installations";
import type { Bot } from "../schema/bots";
import type { Channel } from "../schema/channels";
import type { Conversation } from "../schema/conversations";
import type {
  OutboxMessage,
  OutboxPriority,
  SurfaceKind,
} from "../schema/outbox_messages";

/**
 * **The platform contract.** Every place a bot talks — the API, the
 * dashboard chat, a generic webhook, and later Slack, Linear, and Pylon — is
 * a {@link SurfaceAdapter}: it declares what its surface can show and
 * delivers outbox rows. A platform people reach the bot *from* is also a
 * {@link PlatformAdapter}: it defines the per-bot app, verifies and parses
 * what the platform sends, and names the channel each message belongs to.
 * No call site asks which platform it is talking to; it reads capabilities.
 */

/** What a surface can show. The outbox reads these; adapters set them. */
export interface SurfaceCapabilities {
  /** Replies stay in a thread, session, or issue. */
  threads: boolean;
  /** Partial text can be shown while the model writes (`stream` rows). */
  streaming: boolean;
  /** A working line ("Searching memory…") can be shown (`status` rows). */
  status: boolean;
  /** The turn's tool steps can be shown (`plan` rows). */
  plan: boolean;
  /** Questions and approvals can carry buttons. */
  buttons: boolean;
  /** A message only one person sees (a rate-limit note). */
  ephemeral: boolean;
  /** A sent message can be edited in place. */
  edits: boolean;
  /** A question is a typed request for input the platform tracks (Linear). */
  elicitation: boolean;
  /** A typing indicator. */
  typing: boolean;
}

/** A surface that can show nothing but final messages. */
export const NO_CAPABILITIES: SurfaceCapabilities = {
  threads: false,
  streaming: false,
  status: false,
  plan: false,
  buttons: false,
  ephemeral: false,
  edits: false,
  elicitation: false,
  typing: false,
};

/** A row about to be written to the outbox. */
export interface OutboxDraft {
  kind: SurfaceKind;
  payload: Record<string, unknown>;
  priority: OutboxPriority;
  /** Rows sharing a key supersede each other: only the newest is delivered. */
  supersedesKey: string | null;
}

/** Why a draft was refused where it was written. */
export interface OutboundRefusal {
  refused: true;
  reason: string;
}

/** Where a draft is being written. */
export interface SurfaceContext {
  conversation: Conversation;
  channel: Channel;
  installation: BotInstallation | null;
}

/** What one send attempt did. */
export interface SendResult {
  outcome: "sent" | "retry" | "undeliverable";
  /** The platform's id for what it posted, recorded before `sent`. */
  externalMessageId?: string | null;
  error?: string | null;
  /** The platform asked us to wait this long (Retry-After). */
  retryAfterMs?: number;
}

/** What a surface adapter does. */
export interface SurfaceAdapter {
  /** The channel type this adapter serves. */
  type: string;
  capabilities: SurfaceCapabilities;
  /**
   * Whether rows are settled at enqueue, because nothing is posted (the
   * dashboard reads Postgres). Such rows are written `sent`.
   */
  settlesAtEnqueue: boolean;
  /**
   * **Refuse at enqueue**: check and shape a draft where it is written, so a
   * malformed row fails with a stack that points at its writer. Return
   * `null` to drop a row this surface has no use for (a `status` on a
   * surface without a status line).
   * @param draft - The row about to be written.
   * @param ctx - The conversation, channel, and installation.
   */
  validateOutbound(
    draft: OutboxDraft,
    ctx: SurfaceContext,
  ): OutboxDraft | OutboundRefusal | null;
  /**
   * Deliver one row. **Never throws**: every failure is a {@link SendResult}.
   * @param row - The row, claimed.
   * @param ctx - The conversation, channel, and installation.
   */
  send(row: OutboxMessage, ctx: SurfaceContext): Promise<SendResult>;
}

/** The URLs a platform app points at, for one installation. */
export interface InstallationUrls {
  /** Where the platform posts events and interactions. */
  events: string;
  /** The OAuth redirect, for platforms that install by OAuth. */
  oauthRedirect: string;
}

/** The app definition a person creates on the platform, one per bot. */
export interface AppManifest {
  /** What the person does with it, in a sentence or two. */
  instructions: string;
  /** The definition itself, in the platform's own format. */
  manifest: Record<string, unknown>;
  /** A link to the platform's own form, pre-filled with the definition (Linear). */
  link?: string;
}

/** A request as it arrived: the raw bytes are what platforms sign. */
export interface RawInbound {
  bytes: Uint8Array;
  text: string;
  headers: Headers;
}

/** An installation, with its credentials opened. */
export interface OpenInstallation {
  installation: BotInstallation;
  credentials: Record<string, unknown>;
}

/** A channel as the platform describes it: the memory boundary. */
export interface ChannelRef {
  /** The platform's channel id (unique within the workspace). */
  externalId: string;
  name: string;
  isPrivate: boolean;
  isShared: boolean;
  isDm: boolean;
  parentExternalId?: string | null;
}

/** One inbound thing a platform sent, in the shape every rule reads. */
export interface NormalizedInbound {
  kind: "message" | "interaction" | "signal" | "lifecycle";
  /** Dedupe: the message, not the event that carried it. */
  messageKey: string;
  channel: ChannelRef;
  /** The thread, session, or issue. */
  conversationKey: string;
  sender: {
    externalUserId: string;
    displayName: string;
    isBot: boolean;
    isSelf: boolean;
  };
  /** Mentions the bot, is a DM, or was delegated to it. */
  addressed: boolean;
  /** An edit or a delete of an earlier message, never a new one. */
  edit?: boolean;
  text?: string;
  interaction?: {
    kind: "answer" | "approval";
    targetId: string;
    value: string;
  };
  signal?: "stop" | "disengage";
  /**
   * `uninstall` — the app was removed or its token revoked; `channel_archived`;
   * `channel_joined` — the bot was invited to the channel; `channel_left` —
   * the bot was removed from it; `disengage` — the conversations matching
   * {@link NormalizedInbound.disengage} end (an issue completed, deleted, or
   * taken away from the bot); `settings` — {@link NormalizedInbound.settings}
   * are merged into the installation's config; `noted` — recorded with the
   * decided outcome {@link NormalizedInbound.note}, changing nothing.
   */
  lifecycle?:
    | "uninstall"
    | "channel_archived"
    | "channel_joined"
    | "channel_left"
    | "disengage"
    | "settings"
    | "noted";
  /**
   * For `disengage`: the bot's live conversations in this workspace whose
   * `details[key]` is one of `values` end, silently.
   */
  disengage?: { key: string; values: string[] };
  /** For `settings`: non-secret settings to merge into the installation's config. */
  settings?: Record<string, unknown>;
  /** For `noted`: the outcome recorded, e.g. `assigned-not-delegated`. */
  note?: string;
  /**
   * What the platform knows about the thread, stored on a new conversation's
   * `details` (a Linear session's issue, team, and project).
   */
  conversationDetails?: Record<string, unknown>;
  /** Extra payload on the acknowledgement row (the platform's own bookkeeping). */
  ackPayload?: Record<string, unknown>;
  /**
   * For a `stop` signal: the answer the platform expects once the
   * conversation is cancelled (Linear keeps a stopped session `stopping`
   * until the agent says something final).
   */
  reply?: string;
  /** The platform's acknowledgement clock. */
  ackDeadlineMs?: number;
}

/** What `verifyInbound` decided. */
export type Verified = { ok: true } | { ok: false; reason: string };

/** What an OAuth install learned and must store. */
export interface OAuthResult {
  /** Secrets to merge into the installation's sealed credentials (a bot token). */
  credentials: Record<string, unknown>;
  /** Settings to merge into its config (the workspace's name, the scopes granted). */
  config: Record<string, unknown>;
  /** The workspace the app was installed into. */
  externalWorkspaceId: string;
  /** The bot's own user id there, which loop filtering reads. */
  externalBotUserId: string;
  /** The platform's id for the app. */
  externalAppId: string | null;
}

/** A platform whose app is installed into a workspace by OAuth. */
export interface OAuthInstall {
  /**
   * Whether the install uses PKCE (S256): the verifier is kept with the
   * install's state and given to {@link OAuthInstall.exchange}.
   */
  pkce?: boolean;
  /**
   * The credential keys an install grants (OAuth tokens), forgotten when the
   * platform says the app was uninstalled. The client credentials stay, so
   * the app can be installed again.
   */
  tokenKeys?: string[];
  /**
   * Where a person approves the install.
   * @param inst - The installation, with its client credentials.
   * @param redirectUri - Where the platform sends the browser back.
   * @param state - The single-use state that names this install.
   * @param codeChallenge - The PKCE challenge (S256), when {@link OAuthInstall.pkce}.
   * @returns The URL.
   */
  authorizeUrl(
    inst: OpenInstallation,
    redirectUri: string,
    state: string,
    codeChallenge?: string,
  ): string;
  /**
   * Exchange the code the platform returned for the installation's token.
   * @param inst - The installation.
   * @param code - The authorization code.
   * @param redirectUri - The redirect the code was issued for.
   * @param codeVerifier - The PKCE verifier, when {@link OAuthInstall.pkce}.
   * @returns What to store.
   */
  exchange(
    inst: OpenInstallation,
    code: string,
    redirectUri: string,
    codeVerifier?: string,
  ): Promise<OAuthResult>;
}

/** A platform people reach a bot from: one app per bot. */
export interface PlatformAdapter extends SurfaceAdapter {
  /** A name for people. */
  label: string;
  /** The installation's non-secret settings. */
  installationSchema: z.ZodType<Record<string, unknown>>;
  /** The installation's secrets, sealed and never serialized. */
  credentialSchema: z.ZodType<Record<string, unknown>>;
  /**
   * The app definition for one bot.
   * @param bot - The bot.
   * @param urls - Where the app points.
   */
  manifest(bot: Bot, urls: InstallationUrls): AppManifest;
  /**
   * Check a delivery's signature over its raw bytes, in constant time and
   * within a timestamp window.
   * @param req - The request as it arrived.
   * @param inst - The installation the routing key named.
   */
  verifyInbound(req: RawInbound, inst: OpenInstallation): Verified;
  /**
   * Read a verified body. JSON by default; Slack posts interactivity as a
   * form whose `payload` field is JSON.
   * @param req - The request as it arrived.
   * @returns The parsed body.
   * @throws When it cannot be read.
   */
  decodeBody?(req: RawInbound): unknown;
  /**
   * Whether an installation still waiting to be installed answers the
   * platform's handshake (Slack verifies a request URL when the app is
   * created, before anyone installs it). Its other deliveries are dropped.
   */
  handshakeWhilePending?: boolean;
  /**
   * Whether a signed delivery to an installation that is not active (waiting
   * to be installed, errored, or uninstalled) is still answered 200 and
   * dropped, never refused: Linear disables a webhook whose deliveries keep
   * failing, for every workspace of the app.
   */
  acknowledgeWhileInactive?: boolean;
  /**
   * Whether a conversation key names one conversation across the platform
   * (a Linear agent session id), so a conversation keeps its channel even
   * when the thing it is about moves (an issue moved to another project).
   */
  globalConversationKeys?: boolean;
  /**
   * The workspace a delivery says it is from, when the platform names it in
   * the body. A delivery from a workspace other than the installation's is
   * recorded `unknown-installation` and changes nothing.
   * @param body - The parsed body.
   * @returns The workspace id, or `null` when the body does not say.
   */
  workspaceOf?(body: unknown): string | null;
  /** The OAuth install, for platforms whose app is installed that way. */
  oauth?: OAuthInstall;
  /**
   * Whether connected credentials are enough to take deliveries. An OAuth
   * platform's client credentials are not: the installation stays `pending`
   * until the install (or a pasted bot token) completes it.
   * @param credentials - The credentials as connected.
   * @returns `true` to activate.
   */
  readyToActivate?(credentials: Record<string, unknown>): boolean;
  /**
   * A handshake the platform expects answered (Slack's `url_verification`),
   * only ever asked after verification.
   * @param body - The parsed body.
   */
  handshake?(body: unknown): Response | null;
  /**
   * The platform's id for this delivery, which a retry repeats.
   * @param body - The parsed body.
   * @param req - The request.
   */
  eventId(body: unknown, req: RawInbound): string;
  /**
   * What a verified delivery says.
   * @param body - The parsed body.
   * @param inst - The installation.
   */
  parseInbound(body: unknown, inst: OpenInstallation): NormalizedInbound[];
  /**
   * The channel — the memory boundary — an inbound message belongs to.
   * @param inbound - The message.
   */
  resolveChannel(inbound: NormalizedInbound): ChannelRef;
  /**
   * Check the credentials work, and learn the bot's own id on the platform.
   * @param inst - The installation.
   * @returns The bot's platform user id.
   */
  probe(inst: OpenInstallation): Promise<{ externalBotUserId: string }>;
  /**
   * The outbox target for a conversation in a channel.
   * @param channel - The channel row.
   * @param conversationKey - The thread, session, or issue.
   */
  target?(channel: Channel, conversationKey: string | null): unknown;
}

/**
 * Whether a validation answer is a refusal.
 * @param v - What `validateOutbound` returned.
 * @returns `true` for a refusal.
 */
export function isRefusal(
  v: OutboxDraft | OutboundRefusal | null,
): v is OutboundRefusal {
  return v !== null && (v as OutboundRefusal).refused === true;
}
