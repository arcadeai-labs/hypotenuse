import { z } from "zod";
import {
  signCallback,
  verifyCallbackSignature,
} from "../../../ops/SignatureOps";
import { FakePlatform } from "../base";

/**
 * **The webhook platform's fake**: a system connected to a bot as a generic
 * webhook platform. It receives the bot's signed deliveries (validating each
 * against the published outbound shape and the signature), and posts signed
 * deliveries to the installation's events URL as a person, a button press, a
 * signal, or a lifecycle event — with the same bytes it signed.
 *
 * Control routes: `POST /__test/post` (a message), `/__test/press` (an
 * interaction), `/__test/signal`, `/__test/uninstall`, and `/__test/answer`
 * (script the next answer: a status, a 429 with `Retry-After`, or a lost
 * response).
 */

/** The published outbound shape: every surface kind, as JSON. */
export const webhookOutboundSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ping") }),
  z.object({
    kind: z.literal("status"),
    deliveryId: z.number(),
    channel: z.string(),
    conversation: z.string(),
    text: z.string(),
  }),
  z.object({
    kind: z.literal("stream"),
    deliveryId: z.number(),
    channel: z.string(),
    conversation: z.string(),
    text: z.string(),
  }),
  z.object({
    kind: z.literal("plan"),
    deliveryId: z.number(),
    channel: z.string(),
    conversation: z.string(),
    steps: z.array(
      z.object({ seq: z.number(), tool: z.string(), state: z.string() }),
    ),
  }),
  z.object({
    kind: z.literal("message"),
    deliveryId: z.number(),
    channel: z.string(),
    conversation: z.string(),
    text: z.string().min(1),
  }),
  z.object({
    kind: z.literal("question"),
    deliveryId: z.number(),
    channel: z.string(),
    conversation: z.string(),
    text: z.string().min(1),
    options: z.array(z.string()).optional(),
    questionEntryId: z.number(),
  }),
  z.object({
    kind: z.literal("approval"),
    deliveryId: z.number(),
    channel: z.string(),
    conversation: z.string(),
    approvalId: z.number(),
    name: z.string(),
    actions: z.array(z.string()),
  }),
]);

/** One inbound delivery's fields, as a test writes them. */
export interface InboundDraft {
  channel:
    | string
    | {
        id: string;
        name?: string;
        private?: boolean;
        shared?: boolean;
        dm?: boolean;
      };
  conversation: string;
  messageId?: string;
  eventId?: string;
  sender?: { id: string; name?: string; isBot?: boolean };
  text?: string;
  mentions?: boolean;
  edited?: boolean;
  type?: "message" | "interaction" | "signal" | "lifecycle";
  interaction?: {
    kind: "answer" | "approval";
    targetId: string;
    value: string;
  };
  signal?: "stop" | "disengage";
  lifecycle?: "uninstall" | "channel_archived";
}

let counter = 0;

/** The webhook platform, faked. */
export class WebhookPlatform extends FakePlatform {
  /** The shared signing secret. */
  secret = "whsec-test-0123456789abcdef";
  /** The installation's events URL on Hypotenuse. */
  eventsUrl = "";
  /** Sign with a different secret, to test a bad signature. */
  signWith: string | null = null;
  /** Sign with this timestamp (unix seconds), to test a stale one. */
  timestamp: number | null = null;

  /** Where Hypotenuse delivers: the installation's `deliveryUrl`. */
  get deliveryUrl(): string {
    return `${this.url}/deliver`;
  }

  /**
   * Post one delivery to Hypotenuse, signed as the platform signs it.
   * @param draft - What a person did.
   * @returns Hypotenuse's answer: status and body text.
   */
  async send(draft: InboundDraft): Promise<{ status: number; body: string }> {
    const messageId = draft.messageId ?? `m${++counter}-${Date.now()}`;
    const body = JSON.stringify({
      type: draft.type ?? "message",
      messageId,
      ...(draft.eventId ? { eventId: draft.eventId } : {}),
      channel: draft.channel,
      conversation: draft.conversation,
      sender: draft.sender ?? { id: "U-peach", name: "Peach" },
      ...(draft.text !== undefined ? { text: draft.text } : {}),
      ...(draft.mentions !== undefined ? { mentions: draft.mentions } : {}),
      ...(draft.edited ? { edited: true } : {}),
      ...(draft.interaction ? { interaction: draft.interaction } : {}),
      ...(draft.signal ? { signal: draft.signal } : {}),
      ...(draft.lifecycle ? { lifecycle: draft.lifecycle } : {}),
    });
    return this.sendRaw(body);
  }

  /**
   * Post exact bytes, signed.
   * @param body - The body.
   * @param url - Where (the events URL by default).
   * @returns Hypotenuse's answer.
   */
  async sendRaw(
    body: string,
    url = this.eventsUrl,
  ): Promise<{ status: number; body: string }> {
    const t = this.timestamp ?? Math.floor(Date.now() / 1000);
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "hypotenuse-signature": signCallback(
          this.signWith ?? this.secret,
          body,
          t,
        ),
      },
      body,
    });
    return { status: res.status, body: await res.text() };
  }

  /** The bot's deliveries received, parsed. */
  get deliveries(): Record<string, unknown>[] {
    return this.requests
      .filter((r) => r.path === "/deliver" && r.json)
      .map((r) => r.json as Record<string, unknown>)
      .filter((j) => j.kind !== "ping");
  }

  protected validate(
    _path: string,
    headers: Record<string, string>,
    body: string,
    json: unknown,
  ): true | string {
    if (
      !verifyCallbackSignature(
        this.secret,
        headers["hypotenuse-signature"] ?? "",
        body,
      )
    ) {
      return "bad signature";
    }
    const parsed = webhookOutboundSchema.safeParse(json);
    if (!parsed.success)
      return parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ");
    const kind = (json as { kind: string }).kind;
    if (
      kind !== "ping" &&
      headers["hypotenuse-delivery"] !==
        String((json as { deliveryId: number }).deliveryId)
    ) {
      return "Hypotenuse-Delivery does not match deliveryId";
    }
    return true;
  }

  protected handle(_path: string, json: unknown): Response {
    const kind = (json as { kind?: string }).kind;
    if (kind === "ping") return Response.json({ botUserId: "B-toadsworth" });
    return Response.json({ messageId: `ext-${++counter}` });
  }

  protected async control(name: string, body: unknown): Promise<unknown> {
    const b = (body ?? {}) as Record<string, unknown>;
    switch (name) {
      case "post":
        return this.send(b as unknown as InboundDraft);
      case "press":
        return this.send({
          ...(b as unknown as InboundDraft),
          type: "interaction",
        });
      case "signal":
        return this.send({ ...(b as unknown as InboundDraft), type: "signal" });
      case "uninstall":
        return this.send({
          ...(b as unknown as InboundDraft),
          type: "lifecycle",
          lifecycle: "uninstall",
        });
      case "answer":
        this.answers.push(b as never);
        return { queued: this.answers.length };
      default:
        throw new Error(`No control named ${name}`);
    }
  }
}
