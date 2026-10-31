import { createHmac } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { FakePlatform } from "../base";
import { SUPPLEMENT } from "./spec/supplement";

/**
 * **Slack, faked** — in process, over Slack's real wire protocols, for the
 * Slack platform's suites. There is no finear for Slack, so this fake is ours
 * and so is its fidelity: every behavior below cites the Slack doc it encodes,
 * and `docs/platform-coverage/slack.md` ties each to a test.
 *
 * **The Web API** (`POST /api/<method>`). Every call is validated against
 * Slack's published spec — the OpenAPI spec pinned in `spec/web-api.json`
 * (`bun run slack:fetch-spec`), plus `spec/supplement.ts` for methods newer
 * than it — and against the manifest schema for `apps.manifest.create`. A
 * call real Slack would refuse is recorded `valid: false`; suites assert
 * there are none. A valid call is answered as Slack answers: `{ok: true, …}`,
 * or `{ok: false, error}` for a bad token (`invalid_auth`), an unknown
 * message, or a scripted failure (`failNext`), and HTTP 429 with
 * `Retry-After` for `ratelimited` (https://api.slack.com/apis/rate-limits).
 *
 * **Events and interactivity** are signed with Slack's v0 scheme over the
 * exact bytes sent (https://api.slack.com/authentication/verifying-requests-from-slack)
 * and posted to the installation's events URL. A person's message in a
 * channel arrives as Slack sends it: an `app_mention` envelope *and* a
 * `message` envelope when it mentions the bot
 * (https://api.slack.com/events/app_mention), each with its own `event_id`.
 * A retry repeats the body with `X-Slack-Retry-Num` and `X-Slack-Retry-Reason`
 * (https://api.slack.com/apis/events-api#retries).
 *
 * **Threads** are held as Slack would show them, so a suite asserts what a
 * person in the channel sees: messages, streamed text, edits, and the status.
 */

/** The pinned Web API spec. */
const WEB_API = (await Bun.file(
  path.join(import.meta.dir, "spec", "web-api.json"),
).json()) as {
  methods: Record<
    string,
    {
      token: boolean;
      params: Record<string, { type: string; required: boolean }>;
    }
  >;
};

/** Slack's manifest schema, as a validator. */
const MANIFEST = z.fromJSONSchema(
  await Bun.file(
    path.join(import.meta.dir, "spec", "manifest.schema.json"),
  ).json(),
);

/** Every method the fake serves, with its parameters. */
const METHODS = { ...WEB_API.methods, ...SUPPLEMENT };

/** Parameters Slack takes as JSON values in a JSON body (and as JSON strings in a form). */
const JSON_PARAMS = new Set([
  "blocks",
  "attachments",
  "metadata",
  "loading_messages",
]);

/**
 * Validate a manifest against Slack's schema.
 * @param manifest - The manifest.
 * @returns `true`, or why it is invalid.
 */
export function validateManifest(manifest: unknown): true | string {
  const parsed = MANIFEST.safeParse(manifest);
  if (parsed.success) return true;
  return parsed.error.issues
    .map((i) => `/${i.path.join("/")}: ${i.message}`)
    .join("; ");
}

/**
 * Check Block Kit against the limits Slack enforces
 * (https://api.slack.com/reference/block-kit/blocks).
 * @param blocks - The blocks.
 * @returns `true`, or why they are invalid.
 */
function validateBlocks(blocks: unknown): true | string {
  if (!Array.isArray(blocks)) return "blocks must be an array";
  if (blocks.length > 50) return "at most 50 blocks";
  for (const b of blocks as Record<string, unknown>[]) {
    const type = b.type;
    if (type === "section") {
      const t = (b.text as { text?: string } | undefined)?.text ?? "";
      if (t.length > 3000) return "a section's text is at most 3000 characters";
    } else if (type === "actions") {
      const els = (b.elements ?? []) as Record<string, unknown>[];
      if (els.length === 0 || els.length > 25)
        return "an actions block has 1–25 elements";
      for (const e of els) {
        const id = String(e.action_id ?? "");
        if (!id || id.length > 255) return "an element needs an action_id";
        if (e.type === "button") {
          const label = (e.text as { text?: string } | undefined)?.text ?? "";
          if (!label || label.length > 75)
            return "a button's text is 1–75 characters";
          if (String(e.value ?? "").length > 2000)
            return "a button's value is at most 2000 characters";
        } else if (e.type === "static_select") {
          const opts = (e.options ?? []) as unknown[];
          if (opts.length === 0 || opts.length > 100)
            return "a select has 1–100 options";
        } else {
          return `an unexpected element ${String(e.type)}`;
        }
      }
    } else if (type === "context") {
      const els = (b.elements ?? []) as unknown[];
      if (els.length === 0 || els.length > 10)
        return "a context block has 1–10 elements";
    } else {
      return `an unexpected block ${String(type)}`;
    }
  }
  return true;
}

/** One message in a thread, as a person in the channel would see it. */
export interface SlackMessage {
  ts: string;
  channel: string;
  threadTs: string | null;
  user: string;
  text: string;
  blocks?: unknown[];
  /** A streamed message: open until stopped. */
  stream?: { open: boolean };
  edits: number;
}

/** A scripted answer to one method. */
type Scripted =
  | { error: string; status?: number; extra?: Record<string, unknown> }
  | { ratelimited: number };

let tsCounter = 0;

/** Slack, faked. */
export class SlackFake extends FakePlatform {
  team = { id: "T0FAKE", name: "Mushroom Kingdom" };
  appId = "A0FAKE1";
  clientId = "1111.2222";
  clientSecret = "slack-client-secret-0123";
  signingSecret = "slack-signing-secret-0123456789";
  botToken = "xoxb-fake-bot-token";
  configToken = "xoxe.xoxp-1-fake-config-token";
  botUserId = "U0TOAD";
  botId = "B0TOAD";
  /** The installation's events URL on Hypotenuse. */
  eventsUrl = "";
  /** Shift every new `ts` this many seconds into the past. */
  tsOffsetSeconds = 0;
  /** Messages, by `ts`. */
  messages = new Map<string, SlackMessage>();
  /** Every status set, oldest first. */
  statuses: { channel: string; threadTs: string; status: string }[] = [];
  /** Codes a person's approval minted, and the redirect each was for. */
  codes = new Map<string, string>();
  /** Scripted failures, per method. */
  scripted = new Map<string, Scripted[]>();
  /** The arguments of the call being handled (a form body's, parsed). */
  private args: Record<string, unknown> = {};
  private eventCounter = 0;

  /** Forget everything a test did. */
  override reset(): void {
    super.reset();
    this.messages.clear();
    this.statuses = [];
    this.codes.clear();
    this.scripted.clear();
    this.tsOffsetSeconds = 0;
  }

  /** A fresh, monotonic Slack timestamp. */
  nextTs(): string {
    tsCounter++;
    const seconds = Math.floor(Date.now() / 1000) - this.tsOffsetSeconds;
    return `${seconds}.${String(tsCounter).padStart(6, "0")}`;
  }

  /**
   * Make the next call of a method fail as Slack would.
   * @param method - The method.
   * @param answer - The error, or a 429 with this many seconds to wait.
   */
  failNext(method: string, answer: Scripted): void {
    const list = this.scripted.get(method) ?? [];
    list.push(answer);
    this.scripted.set(method, list);
  }

  /** The Web API calls received, by method, valid or not. */
  calls(method?: string): { method: string; args: Record<string, unknown> }[] {
    return this.requests
      .filter((r) => r.path.startsWith("/api/"))
      .map((r) => ({
        method: r.path.slice("/api/".length),
        args: parseArgs(r.headers["content-type"] ?? "", r.body),
      }))
      .filter((c) => !method || c.method === method);
  }

  /**
   * What a person sees in a thread: the bot's messages and the people's, in order.
   * @param channel - The channel.
   * @param threadTs - The thread.
   * @returns The messages, oldest first.
   */
  thread(channel: string, threadTs: string): SlackMessage[] {
    return [...this.messages.values()]
      .filter(
        (m) =>
          m.channel === channel &&
          (m.threadTs === threadTs || m.ts === threadTs),
      )
      .sort((a, b) => Number(a.ts) - Number(b.ts));
  }

  /** The bot's messages in a thread. */
  botMessages(channel: string, threadTs: string): SlackMessage[] {
    return this.thread(channel, threadTs).filter(
      (m) => m.user === this.botUserId,
    );
  }

  // ─── Deliveries to Hypotenuse ──────────────────────────────────────────

  /**
   * Post exact bytes to Hypotenuse, v0-signed.
   * @param body - The body.
   * @param opts - The content type, a retry number, a secret or timestamp to sign with, a URL.
   * @returns Hypotenuse's answer.
   */
  async post(
    body: string,
    opts: {
      contentType?: string;
      retryNum?: number;
      secret?: string;
      timestamp?: number;
      url?: string;
    } = {},
  ): Promise<{ status: number; body: string; ms: number }> {
    const t = String(opts.timestamp ?? Math.floor(Date.now() / 1000));
    const sig = `v0=${createHmac("sha256", opts.secret ?? this.signingSecret)
      .update(`v0:${t}:${body}`)
      .digest("hex")}`;
    const started = performance.now();
    const res = await fetch(opts.url ?? this.eventsUrl, {
      method: "POST",
      headers: {
        "content-type": opts.contentType ?? "application/json",
        "x-slack-request-timestamp": t,
        "x-slack-signature": sig,
        "user-agent": "Slackbot 1.0 (+https://api.slack.com/robots)",
        ...(opts.retryNum
          ? {
              "x-slack-retry-num": String(opts.retryNum),
              "x-slack-retry-reason": "http_timeout",
            }
          : {}),
      },
      body,
    });
    return {
      status: res.status,
      body: await res.text(),
      ms: performance.now() - started,
    };
  }

  /**
   * An `event_callback` envelope around an event
   * (https://api.slack.com/apis/events-api#callback-field).
   * @param event - The event.
   * @param opts - The event id, and whether the channel is externally shared.
   * @returns The envelope's JSON.
   */
  envelope(
    event: Record<string, unknown>,
    opts: { eventId?: string; shared?: boolean } = {},
  ): string {
    return JSON.stringify({
      token: "deprecated-verification-token",
      team_id: this.team.id,
      context_team_id: this.team.id,
      api_app_id: this.appId,
      event,
      type: "event_callback",
      event_id: opts.eventId ?? `Ev${Date.now()}${++this.eventCounter}`,
      event_time: Math.floor(Date.now() / 1000),
      authorizations: [
        {
          team_id: this.team.id,
          user_id: this.botUserId,
          is_bot: true,
          is_enterprise_install: false,
        },
      ],
      is_ext_shared_channel: opts.shared ?? false,
    });
  }

  /**
   * Deliver one event.
   * @param event - The event.
   * @param opts - Its id, shared, a retry number.
   * @returns Hypotenuse's answer.
   */
  async deliver(
    event: Record<string, unknown>,
    opts: { eventId?: string; shared?: boolean; retryNum?: number } = {},
  ) {
    return this.post(this.envelope(event, opts), { retryNum: opts.retryNum });
  }

  /**
   * A person writes in a channel. Mentioning the bot, it arrives twice — as
   * `app_mention` and as `message` — as real Slack sends it.
   * @param m - Who, where, what.
   * @returns The message's `ts`, and Hypotenuse's answers.
   */
  async say(m: {
    channel: string;
    text: string;
    user?: string;
    threadTs?: string;
    mention?: boolean;
    channelType?: "channel" | "group" | "im" | "mpim";
    shared?: boolean;
  }) {
    const ts = this.nextTs();
    const user = m.user ?? "U0PEACH";
    const text = m.mention ? `<@${this.botUserId}> ${m.text}` : m.text;
    this.messages.set(ts, {
      ts,
      channel: m.channel,
      threadTs: m.threadTs ?? null,
      user,
      text,
      edits: 0,
    });
    const base = {
      user,
      text,
      ts,
      channel: m.channel,
      event_ts: ts,
      ...(m.threadTs ? { thread_ts: m.threadTs } : {}),
    };
    const answers = [];
    if (m.mention && m.channelType !== "im") {
      answers.push(
        await this.deliver(
          { type: "app_mention", ...base },
          { shared: m.shared },
        ),
      );
    }
    answers.push(
      await this.deliver(
        {
          type: "message",
          channel_type: m.channelType ?? "channel",
          ...base,
        },
        { shared: m.shared },
      ),
    );
    return { ts, answers };
  }

  /**
   * A person presses a button (or picks from a menu) on one of the bot's
   * messages: a `block_actions` payload, form-encoded
   * (https://api.slack.com/reference/interaction-payloads/block-actions).
   * @param messageTs - The message the element is on.
   * @param actionId - The element's `action_id`.
   * @param opts - Who pressed it, and the option picked.
   * @returns Hypotenuse's answer.
   */
  async press(
    messageTs: string,
    actionId: string,
    opts: {
      user?: string;
      name?: string;
      value?: string;
      select?: boolean;
    } = {},
  ) {
    const message = this.messages.get(messageTs);
    if (!message) throw new Error(`No message ${messageTs}`);
    const user = opts.user ?? "U0PEACH";
    const action = opts.select
      ? {
          type: "static_select",
          action_id: actionId,
          block_id: "b",
          selected_option: {
            text: { type: "plain_text", text: opts.value ?? "" },
            value: opts.value ?? "",
          },
          action_ts: `${Date.now() / 1000}`,
        }
      : {
          type: "button",
          action_id: actionId,
          block_id: "b",
          text: { type: "plain_text", text: opts.value ?? "" },
          value: opts.value ?? "",
          action_ts: `${Date.now() / 1000}`,
        };
    const payload = {
      type: "block_actions",
      user: {
        id: user,
        username: (opts.name ?? user).toLowerCase(),
        name: opts.name ?? user,
        team_id: this.team.id,
      },
      api_app_id: this.appId,
      token: "deprecated-verification-token",
      container: {
        type: "message",
        message_ts: messageTs,
        channel_id: message.channel,
        is_ephemeral: false,
        ...(message.threadTs ? { thread_ts: message.threadTs } : {}),
      },
      trigger_id: `${Date.now()}.${++this.eventCounter}.fake`,
      team: { id: this.team.id, domain: "mushroom" },
      channel: { id: message.channel, name: message.channel },
      message: {
        type: "message",
        user: message.user,
        ts: messageTs,
        text: message.text,
        ...(message.threadTs ? { thread_ts: message.threadTs } : {}),
      },
      actions: [action],
    };
    return this.post(
      new URLSearchParams({ payload: JSON.stringify(payload) }).toString(),
      { contentType: "application/x-www-form-urlencoded" },
    );
  }

  /**
   * A person approves the install on Slack's authorize page: Slack mints a
   * code and sends the browser to the redirect
   * (https://api.slack.com/authentication/oauth-v2#asking).
   * @param authorizeUrl - The URL Hypotenuse sent the browser to.
   * @returns The callback URL the browser is sent to.
   */
  approveInstall(authorizeUrl: string): string {
    const url = new URL(authorizeUrl);
    if (url.searchParams.get("client_id") !== this.clientId) {
      throw new Error("The authorize URL names another app's client_id");
    }
    const redirect = String(url.searchParams.get("redirect_uri"));
    const code = `code-${++this.eventCounter}`;
    this.codes.set(code, redirect);
    const back = new URL(redirect);
    back.searchParams.set("code", code);
    back.searchParams.set("state", String(url.searchParams.get("state")));
    return back.toString();
  }

  // ─── The Web API ───────────────────────────────────────────────────────

  protected validate(
    reqPath: string,
    headers: Record<string, string>,
    body: string,
    json: unknown,
  ): true | string {
    if (reqPath.startsWith("/oauth/")) return true;
    if (!reqPath.startsWith("/api/")) return `no route ${reqPath}`;
    const method = reqPath.slice("/api/".length);
    const spec = METHODS[method];
    if (!spec) return `${method} is not a method the fake knows`;
    const type = headers["content-type"] ?? "";
    const form = type.startsWith("application/x-www-form-urlencoded");
    if (!form && !type.startsWith("application/json")) {
      return `${method}: unsupported content type ${type}`;
    }
    // Slack warns `missing_charset` on a JSON body without one.
    if (!form && !/charset=utf-8/i.test(type)) {
      return `${method}: a JSON body needs charset=utf-8`;
    }
    this.args = form
      ? parseArgs(type, body)
      : ((json ?? {}) as Record<string, unknown>);
    const auth = headers.authorization ?? "";
    if (spec.token && !/^Bearer \S+$/.test(auth)) {
      return `${method}: requires a bearer token`;
    }
    for (const [name, p] of Object.entries(spec.params)) {
      if (
        p.required &&
        (this.args[name] === undefined || this.args[name] === "")
      ) {
        return `${method}: ${name} is required`;
      }
    }
    for (const [name, value] of Object.entries(this.args)) {
      const p = spec.params[name];
      if (!p) return `${method}: ${name} is not a parameter`;
      if (JSON_PARAMS.has(name)) {
        const parsed = typeof value === "string" ? safeJson(value) : value;
        if (name === "blocks") {
          const ok = validateBlocks(parsed);
          if (ok !== true) return `${method}: ${ok}`;
        }
        continue;
      }
      if (
        p.type === "boolean" &&
        typeof value !== "boolean" &&
        value !== "true" &&
        value !== "false"
      ) {
        return `${method}: ${name} must be a boolean`;
      }
      if (p.type === "string" && typeof value !== "string") {
        return `${method}: ${name} must be a string`;
      }
    }
    if (method === "apps.manifest.create") {
      const manifest = safeJson(String(this.args.manifest));
      const ok = validateManifest(manifest);
      if (ok !== true) return `apps.manifest.create: ${ok}`;
    }
    return true;
  }

  protected handle(reqPath: string): Response {
    const method = reqPath.slice("/api/".length);
    const a = this.args;
    const scripted = this.scripted.get(method)?.shift();
    if (scripted && "ratelimited" in scripted) {
      return Response.json(
        { ok: false, error: "ratelimited" },
        {
          status: 429,
          headers: { "retry-after": String(scripted.ratelimited) },
        },
      );
    }
    if (scripted) {
      return Response.json(
        { ok: false, error: scripted.error, ...(scripted.extra ?? {}) },
        { status: scripted.status ?? 200 },
      );
    }
    const auth = this.requests.at(-1)?.headers.authorization ?? "";
    const token = auth.replace(/^Bearer /, "");
    const ok = (extra: Record<string, unknown> = {}) =>
      Response.json({ ok: true, ...extra });
    const fail = (error: string) => Response.json({ ok: false, error });
    if (method === "apps.manifest.create") {
      if (token !== this.configToken) return fail("invalid_auth");
      return ok({
        app_id: this.appId,
        credentials: {
          client_id: this.clientId,
          client_secret: this.clientSecret,
          verification_token: "deprecated",
          signing_secret: this.signingSecret,
        },
        oauth_authorize_url: `https://slack.com/oauth/v2/authorize?client_id=${this.clientId}`,
      });
    }
    if (method === "oauth.v2.access") {
      const redirect = this.codes.get(String(a.code));
      if (!redirect) return fail("invalid_code");
      if (
        a.client_id !== this.clientId ||
        a.client_secret !== this.clientSecret
      ) {
        return fail("invalid_client_id");
      }
      if (a.redirect_uri !== redirect) return fail("bad_redirect_uri");
      this.codes.delete(String(a.code));
      return ok({
        access_token: this.botToken,
        token_type: "bot",
        scope: "app_mentions:read,chat:write",
        bot_user_id: this.botUserId,
        app_id: this.appId,
        team: this.team,
        enterprise: null,
        authed_user: { id: "U0PEACH" },
        is_enterprise_install: false,
      });
    }
    if (token !== this.botToken) return fail("invalid_auth");
    switch (method) {
      case "auth.test":
        return ok({
          url: "https://mushroom.slack.com/",
          team: this.team.name,
          user: "toadsworth",
          team_id: this.team.id,
          user_id: this.botUserId,
          bot_id: this.botId,
          is_enterprise_install: false,
        });
      case "assistant.threads.setStatus":
        this.statuses.push({
          channel: String(a.channel_id),
          threadTs: String(a.thread_ts),
          status: String(a.status),
        });
        return ok();
      case "chat.postMessage": {
        const ts = this.nextTs();
        this.messages.set(ts, {
          ts,
          channel: String(a.channel),
          threadTs: a.thread_ts ? String(a.thread_ts) : null,
          user: this.botUserId,
          text: String(a.text ?? ""),
          blocks: toBlocks(a.blocks),
          edits: 0,
        });
        return ok({ channel: a.channel, ts, message: { ts, text: a.text } });
      }
      case "chat.update": {
        const m = this.messages.get(String(a.ts));
        if (!m || m.channel !== a.channel) return fail("message_not_found");
        if (m.user !== this.botUserId) return fail("cant_update_message");
        m.text = String(a.text ?? m.text);
        if (a.blocks !== undefined) m.blocks = toBlocks(a.blocks);
        m.edits++;
        return ok({ channel: a.channel, ts: m.ts, text: m.text });
      }
      case "chat.startStream": {
        const ts = this.nextTs();
        this.messages.set(ts, {
          ts,
          channel: String(a.channel),
          threadTs: String(a.thread_ts),
          user: this.botUserId,
          text: String(a.markdown_text ?? ""),
          stream: { open: true },
          edits: 0,
        });
        return ok({ channel: a.channel, ts });
      }
      case "chat.appendStream": {
        const m = this.messages.get(String(a.ts));
        if (!m?.stream) return fail("message_not_found");
        if (!m.stream.open) return fail("message_not_in_streaming_state");
        m.text += String(a.markdown_text);
        return ok({ channel: a.channel, ts: m.ts });
      }
      case "chat.stopStream": {
        const m = this.messages.get(String(a.ts));
        if (!m?.stream) return fail("message_not_found");
        if (!m.stream.open) return fail("message_not_in_streaming_state");
        if (a.markdown_text) m.text += String(a.markdown_text);
        m.stream.open = false;
        return ok({ channel: a.channel, ts: m.ts });
      }
      default:
        return fail("unknown_method");
    }
  }

  protected async control(name: string, body: unknown): Promise<unknown> {
    const b = (body ?? {}) as Record<string, unknown>;
    switch (name) {
      case "say":
        return this.say(b as never);
      case "fail":
        this.failNext(String(b.method), b.answer as Scripted);
        return { ok: true };
      default:
        throw new Error(`No control named ${name}`);
    }
  }
}

/**
 * Parse a request's arguments, JSON or form.
 * @param contentType - Its content type.
 * @param body - Its body.
 * @returns The arguments.
 */
function parseArgs(contentType: string, body: string): Record<string, unknown> {
  if (contentType.startsWith("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(body).entries());
  }
  return (safeJson(body) ?? {}) as Record<string, unknown>;
}

/**
 * Parse JSON, or `null`.
 * @param text - The text.
 * @returns The value.
 */
function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Blocks as an array, from a JSON value or a JSON string.
 * @param blocks - The blocks.
 * @returns The array, or `undefined`.
 */
function toBlocks(blocks: unknown): unknown[] | undefined {
  if (blocks === undefined) return undefined;
  const v = typeof blocks === "string" ? safeJson(blocks) : blocks;
  return Array.isArray(v) ? v : undefined;
}
