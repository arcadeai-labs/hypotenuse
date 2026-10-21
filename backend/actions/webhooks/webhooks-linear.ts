import { createHash } from "node:crypto";
import { type Action, api, type Connection, config, HTTP_METHOD } from "keryx";
import { z } from "zod";
import {
  checkTimestamp,
  installationForOrganization,
  verifySignature,
} from "../../ops/LinearWebhookOps";
import { rawRequestOf, readCappedBody } from "../../ops/RawRequestOps";
import { linearEvents } from "../../schema/linear_events";

/**
 * Every refusal of an unverified delivery answers exactly these bytes, so a
 * probe cannot tell a wrong signature from a right one that arrived late.
 */
const UNVERIFIED = JSON.stringify({ error: "invalid webhook signature" });

/**
 * A JSON response.
 * @param status - The HTTP status.
 * @param body - The serialized body.
 * @returns The response.
 */
function reply(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * `webhooks:linear` — `POST /api/webhooks/linear`, where Linear delivers every
 * webhook for every connected workspace.
 *
 * The order of the checks is the security argument, and each is tested:
 *
 * 1. **Cap** the body before reading it: over `LINEAR_WEBHOOK_MAX_BODY_BYTES`
 *    answers 413 without buffering the rest.
 * 2. **Signature** — `Linear-Signature`, a hex HMAC-SHA256 of the raw bytes,
 *    compared in constant time. Missing or wrong answers 401.
 * 3. **Timestamp** — the signed body's `webhookTimestamp` within ±60 s; the
 *    unsigned `Linear-Timestamp` header is not read. Stale answers the same
 *    401, byte for byte.
 * 4. **Dedupe** on `Linear-Delivery`, constant across Linear's retries: a
 *    retry answers 200 and does nothing.
 * 5. **Route** by `organizationId` to a live installation. None — never
 *    connected, or disconnected — still answers 200, recorded as
 *    `unknown_installation`: this one webhook serves every workspace, and
 *    Linear disables a webhook that keeps failing.
 * 6. **Record and answer 200**, then enqueue `linear:process-event`. Nothing
 *    here calls Linear or does the work; the row is the delivery, and the
 *    `linear:process-pending` clock finds it if the enqueue is lost.
 *
 * Machine ingress: not audited (the decision was a person's, in Linear, and
 * the row in `linear_events` is the record), never an MCP tool. Logs carry
 * the delivery id and the reason, never the body.
 *
 * **No rate-limit middleware.** Every workspace's deliveries come from Linear's
 * few addresses, so a per-IP limit is one shared limit — and the
 * unauthenticated one is 20 a minute, which one busy workspace's issue and
 * comment events exceed. A 429 is a failed delivery, and Linear disables a
 * webhook that keeps failing. The signature is checked before any database
 * work and the body is capped before it is read; flooding the endpoint is the
 * edge's to absorb.
 */
export class WebhooksLinear implements Action {
  name = "webhooks:linear";
  description =
    "Receive a signed webhook delivery from Linear. Called by Linear only; verifies the signature and timestamp, records the delivery once, and answers 200.";
  mcp = { tool: false };
  middleware = [];
  web = {
    route: "/webhooks/linear",
    method: HTTP_METHOD.POST,
    rawBody: true,
  };
  inputs = z.object({});

  /**
   * @param _params - Nothing: the body is read raw.
   * @param connection - The HTTP connection.
   * @returns The raw response Linear reads.
   */
  async run(_params: unknown, connection: Connection): Promise<Response> {
    const request = rawRequestOf(connection);
    const headerDelivery = request.headers.get("linear-delivery");
    const deliveryLog = { deliveryId: headerDelivery?.slice(0, 100) ?? null };

    const body = await readCappedBody(
      request,
      config.linear.webhookMaxBodyBytes,
    );
    if (body.oversized) {
      api.logger.warn("refused a Linear webhook", {
        ...deliveryLog,
        reason: "body over the size cap",
      });
      return reply(413, JSON.stringify({ error: "payload too large" }));
    }

    if (!verifySignature(body.bytes, request.headers.get("linear-signature"))) {
      api.logger.warn("refused a Linear webhook", {
        ...deliveryLog,
        reason: "signature",
      });
      return reply(401, UNVERIFIED);
    }

    let payload: Record<string, unknown>;
    try {
      const parsed = JSON.parse(new TextDecoder().decode(body.bytes));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("not an object");
      }
      payload = parsed as Record<string, unknown>;
    } catch {
      api.logger.warn("refused a Linear webhook", {
        ...deliveryLog,
        reason: "body is not a JSON object",
      });
      return reply(401, UNVERIFIED);
    }

    if (!checkTimestamp(payload)) {
      api.logger.warn("refused a Linear webhook", {
        ...deliveryLog,
        reason: "timestamp outside tolerance",
      });
      return reply(401, UNVERIFIED);
    }

    // Linear always sends the header; a delivery without one is deduplicated
    // by its bytes instead, so a byte-identical replay is still one row.
    const deliveryId =
      headerDelivery?.trim().slice(0, 200) ||
      `sha256:${createHash("sha256").update(body.bytes).digest("hex")}`;
    const eventType =
      typeof payload.type === "string" ? payload.type : "unknown";
    const headerType = request.headers.get("linear-event");
    if (headerType && headerType !== eventType) {
      api.logger.warn("Linear-Event disagrees with the signed body's type", {
        deliveryId,
        header: headerType.slice(0, 100),
        type: eventType,
      });
    }

    const installation = await installationForOrganization(
      payload.organizationId,
    );
    const [inserted] = await api.db.db
      .insert(linearEvents)
      .values({
        deliveryId,
        installationId: installation?.id ?? null,
        eventType,
        action: typeof payload.action === "string" ? payload.action : "",
        webhookTimestamp: new Date(payload.webhookTimestamp as number),
        payload,
        ...(installation
          ? {}
          : { outcome: "unknown_installation", processedAt: new Date() }),
      })
      .onConflictDoNothing({ target: linearEvents.deliveryId })
      .returning({ id: linearEvents.id });

    if (!inserted) {
      api.logger.info("a Linear webhook retry, already recorded", {
        deliveryId,
      });
      return reply(200, JSON.stringify({ ok: true }));
    }

    if (installation) {
      try {
        await api.actions.enqueue("linear:process-event", {
          eventId: inserted.id,
        });
      } catch (e) {
        // The row is the delivery; the sweep clock will process it.
        api.logger.warn("could not enqueue a Linear webhook for processing", {
          deliveryId,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    } else {
      api.logger.info("a Linear webhook for no connected workspace", {
        deliveryId,
        type: eventType,
      });
    }
    return reply(200, JSON.stringify({ ok: true }));
  }
}
