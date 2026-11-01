import { config } from "keryx";
// Type-only, purely for the `declare module "keryx"` augmentation inside.
import type {} from "../config/platforms";
import { platformAdapter } from "../platforms/registry";
import { installationForRoutingKey, openInstallation } from "./InstallationOps";
import { readCappedBody, requestPath } from "./RawRequestOps";
import { enqueueProcessing, recordTriggerEvent } from "./TriggerEventOps";

/**
 * **Platform ingress**: what `webhooks:<type>` does with a delivery. It
 * answers within the platform's clock and never calls the platform inline:
 *
 * 1. Read the routing key from the raw path and find the installation by its
 *    hash. Unknown, pending, errored, or uninstalled: **the 404** — except
 *    on a platform that must never see a refusal (`acknowledgeWhileInactive`,
 *    Linear), where an installation that still holds its signing secret is
 *    verified and answered 200, and the delivery dropped.
 * 2. Verify the signature over the raw bytes (constant time, a timestamp
 *    window). A failure: **the same 404**, byte for byte, so a prober learns
 *    nothing about which keys exist.
 * 3. Answer a handshake the platform expects, only after verification —
 *    for Slack, even before the app is installed. Anything else sent to an
 *    installation that is not active is acknowledged and dropped.
 * 4. Record a `trigger_events` row, `ON CONFLICT DO NOTHING` on the
 *    platform's delivery id, and answer 200.
 * 5. Enqueue `triggers:process-event`; `triggers:process-pending` sweeps what
 *    that loses.
 *
 * No rate limit applies: a platform delivers from a few addresses, and a 429
 * is a failed delivery that can disable the webhook for everyone.
 */

/** The one refusal: no envelope, no timestamp, nothing that varies. */
const REFUSAL_BODY = '{"error":"not found"}\n';

/**
 * The byte-identical refusal for every routing or signature failure.
 * @returns A fresh 404 response.
 */
export function refusal(): Response {
  return new Response(REFUSAL_BODY, {
    status: 404,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Handle one delivery for a platform.
 * @param type - The platform the route serves.
 * @param req - The request as it arrived.
 * @returns The response to send.
 */
export async function handleDelivery(
  type: string,
  req: Request,
): Promise<Response> {
  const adapter = platformAdapter(type);
  if (!adapter) return refusal();
  const segments = requestPath(req).split("/").filter(Boolean);
  const routingKey = segments[2] ?? "";
  const installation = await installationForRoutingKey(
    type,
    routingKey,
    adapter.handshakeWhilePending === true,
    adapter.acknowledgeWhileInactive === true,
  );
  if (!installation) {
    // Drain the body so a keep-alive connection stays usable.
    await req.body?.cancel().catch(() => {});
    return refusal();
  }

  const body = await readCappedBody(req, config.platforms.maxBodyBytes);
  if (body.oversized) {
    return new Response('{"error":"too large"}\n', {
      status: 413,
      headers: { "content-type": "application/json" },
    });
  }
  const text = new TextDecoder().decode(body.bytes);
  const inst = openInstallation(installation);
  const verified = adapter.verifyInbound(
    { bytes: body.bytes, text, headers: req.headers },
    inst,
  );
  if (!verified.ok) return refusal();

  const raw = { bytes: body.bytes, text, headers: req.headers };
  let parsed: unknown;
  try {
    parsed = adapter.decodeBody ? adapter.decodeBody(raw) : JSON.parse(text);
  } catch {
    return new Response('{"error":"not JSON"}\n', {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }
  const handshake = adapter.handshake?.(parsed);
  if (handshake) return handshake;
  // Not installed yet: only the handshake is answered; the rest is dropped.
  if (installation.status !== "active") return ok();

  let messageKey: string | null = null;
  try {
    messageKey = adapter.parseInbound(parsed, inst)[0]?.messageKey ?? null;
  } catch {
    // Processing records why it cannot be read; ingress only records it.
  }
  const eventId = adapter.eventId(parsed, raw);
  const id = await recordTriggerEvent(
    installation,
    eventId,
    messageKey,
    parsed,
  );
  if (id !== null) await enqueueProcessing(id);
  return ok();
}

/**
 * The acknowledgement: 200, the same body for a new delivery and a retry.
 * @returns A fresh response.
 */
function ok(): Response {
  return new Response('{"ok":true}\n', {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
