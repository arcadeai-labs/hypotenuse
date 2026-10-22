import { createHmac } from "node:crypto";
import type {
  AgentSessionEventWebhookPayload,
  AppUserNotificationWebhookPayloadWithNotification,
  AppUserTeamAccessChangedWebhookPayload,
  OAuthAppWebhookPayload,
} from "@linear/sdk/webhooks";
import { config } from "keryx";

/**
 * Signed webhook deliveries built at the HTTP boundary, for what finear cannot
 * send: `PermissionChange`, `AppUserNotification`, a structured
 * `promptContext` and `guidance`, the docs' `agentActivity.body`, and every
 * malformed or hostile delivery the ingress tests need. Each body is typed
 * with `@linear/sdk`'s own webhook payload types, so a fixture that drifts from
 * Linear's shape fails to compile. See "Known finear gaps" in
 * `docs/LINEAR_COVERAGE.md`.
 */

/**
 * Linear's signature over a body: hex HMAC-SHA256 under the signing secret.
 * @param body - The exact bytes to send.
 * @param secret - The secret; defaults to the server's.
 * @returns The `Linear-Signature` value.
 */
export function sign(
  body: string | Uint8Array,
  secret = config.linear.webhookSecret,
): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

/** Overrides for one delivery. */
export interface DeliverOptions {
  /** `Linear-Delivery`; a fresh UUID by default. Pass null to omit it. */
  deliveryId?: string | null;
  /** `Linear-Signature`; the correct one by default. Pass null to omit it. */
  signature?: string | null;
  /** The secret to sign with, when `signature` is not given. */
  secret?: string;
  /** `Linear-Event`; the body's `type` by default. */
  event?: string;
  /** The exact body bytes, instead of `JSON.stringify(payload)`. */
  raw?: string | Uint8Array;
  method?: string;
  /** More request headers. */
  headers?: Record<string, string>;
}

/** What the server answered. */
export interface Delivered {
  status: number;
  text: string;
  deliveryId: string | null;
  ms: number;
}

/**
 * POST one delivery to the server's webhook endpoint as Linear would.
 * @param url - The server's base URL.
 * @param payload - The body, serialized unless `options.raw` is given.
 * @param options - Header and body overrides.
 * @returns The status, body, delivery id, and how long the answer took.
 */
export async function deliver(
  url: string,
  payload: object,
  options: DeliverOptions = {},
): Promise<Delivered> {
  const body = options.raw ?? JSON.stringify(payload);
  const deliveryId =
    options.deliveryId === undefined ? crypto.randomUUID() : options.deliveryId;
  const signature =
    options.signature === undefined
      ? sign(body, options.secret)
      : options.signature;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Linear-Event":
      options.event ?? String((payload as { type?: unknown }).type ?? ""),
    "Linear-Timestamp": String(
      (payload as { webhookTimestamp?: unknown }).webhookTimestamp ?? "",
    ),
    "User-Agent": "Linear-Webhook",
    ...options.headers,
  };
  if (deliveryId !== null) headers["Linear-Delivery"] = deliveryId;
  if (signature !== null) headers["Linear-Signature"] = signature;
  const started = performance.now();
  const res = await fetch(`${url}/api/webhooks/linear`, {
    method: options.method ?? "POST",
    headers,
    body: options.method === "GET" ? undefined : body,
  });
  const text = await res.text();
  return {
    status: res.status,
    text,
    deliveryId,
    ms: performance.now() - started,
  };
}

/** The workspace and app a fixture delivery is for. */
export interface Target {
  organizationId: string;
  appUserId: string;
  oauthClientId?: string;
}

/**
 * An `AgentSessionEvent`, as Linear documents it.
 * @param target - The workspace and app.
 * @param fields - The event's own fields; `agentSession` at least.
 * @returns The payload, stamped now.
 */
export function agentSessionEvent(
  target: Target,
  fields: Partial<AgentSessionEventWebhookPayload> &
    Pick<AgentSessionEventWebhookPayload, "action" | "agentSession">,
): AgentSessionEventWebhookPayload {
  return {
    type: "AgentSessionEvent",
    organizationId: target.organizationId,
    appUserId: target.appUserId,
    oauthClientId: target.oauthClientId ?? config.linear.clientId,
    createdAt: new Date(),
    webhookId: crypto.randomUUID(),
    webhookTimestamp: Date.now(),
    ...fields,
  };
}

/**
 * A minimal `agentSession` for an injected event.
 * @param overrides - Fields to set.
 * @returns The session object.
 */
export function webhookSession(
  overrides: Partial<AgentSessionEventWebhookPayload["agentSession"]> = {},
): AgentSessionEventWebhookPayload["agentSession"] {
  const id = crypto.randomUUID();
  const issueId = crypto.randomUUID();
  return {
    id,
    appUserId: "app-user",
    organizationId: "org",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "pending",
    type: "commentThread",
    issueId,
    issue: {
      id: issueId,
      identifier: "ENG-900",
      title: "An injected issue",
      url: "https://linear.app/eng/issue/ENG-900",
      teamId: "team",
      team: { id: "team", key: "ENG", name: "Engineering" },
    },
    ...overrides,
  };
}

/**
 * `PermissionChange` / `teamAccessChanged`.
 * @param target - The workspace and app.
 * @param change - The teams added and removed, and public-team access.
 * @returns The payload, stamped now.
 */
export function permissionChange(
  target: Target,
  change: Pick<
    AppUserTeamAccessChangedWebhookPayload,
    "addedTeamIds" | "removedTeamIds" | "canAccessAllPublicTeams"
  >,
): AppUserTeamAccessChangedWebhookPayload {
  return {
    type: "PermissionChange",
    action: "teamAccessChanged",
    organizationId: target.organizationId,
    appUserId: target.appUserId,
    oauthClientId: target.oauthClientId ?? config.linear.clientId,
    createdAt: new Date(),
    webhookId: crypto.randomUUID(),
    webhookTimestamp: Date.now(),
    ...change,
  };
}

/**
 * `OAuthApp` / `revoked`.
 * @param target - The workspace.
 * @returns The payload, stamped now.
 */
export function oauthAppRevoked(target: Target): OAuthAppWebhookPayload {
  return {
    type: "OAuthApp",
    action: "revoked",
    organizationId: target.organizationId,
    oauthClientId: target.oauthClientId ?? config.linear.clientId,
    createdAt: new Date(),
    webhookId: crypto.randomUUID(),
    webhookTimestamp: Date.now(),
  };
}

/**
 * `AppUserNotification` of one notification type.
 * @param target - The workspace and app.
 * @param action - The notification type, e.g. `issueMention`.
 * @param fields - More notification fields: `issueId` and `issue`, `actorId`.
 * @returns The payload, stamped now.
 */
export function appUserNotification(
  target: Target,
  action: string,
  fields: Record<string, unknown> = {},
): AppUserNotificationWebhookPayloadWithNotification {
  return {
    type: "AppUserNotification",
    action,
    organizationId: target.organizationId,
    appUserId: target.appUserId,
    oauthClientId: target.oauthClientId ?? config.linear.clientId,
    createdAt: new Date(),
    webhookId: crypto.randomUUID(),
    webhookTimestamp: Date.now(),
    notification: {
      id: crypto.randomUUID(),
      type: action,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      userId: target.appUserId,
      ...fields,
    },
  } as unknown as AppUserNotificationWebhookPayloadWithNotification;
}
