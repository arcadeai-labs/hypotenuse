import { type Action, type Connection, HTTP_METHOD, secret } from "keryx";
import { z } from "zod";
import { handleDelivery } from "../../ops/IngressOps";
import { rawRequestOf } from "../../ops/RawRequestOps";

/**
 * `webhooks:pylon` — ingress for Pylon: one bot's Pylon webhook, fed by the
 * Triggers its admin built (a new issue, a new message or note, an
 * assignment, a status change), named by the routing key in its path, signed
 * with `X-Pylon-Signature-V2` over `<X-Pylon-Timestamp>.<raw body>` within
 * five minutes. Pylon waits 20 seconds and retries twice. Verifies, records a
 * trigger event, answers, and enqueues; never runs a model or calls Pylon
 * inline (the issue and message the body points at are read when the event
 * is processed). No middleware: no session, no rate limit. Never an MCP
 * tool. Not audited: machine ingress, recorded in `trigger_events`.
 */
export class WebhooksPylon implements Action {
  name = "webhooks:pylon";
  description =
    "Receive a signed webhook delivery from a bot's Pylon webhook. Not for people.";
  mcp = { tool: false };
  web = {
    route: "/webhooks/pylon/:routingKey",
    method: HTTP_METHOD.POST,
    rawBody: true,
  };
  inputs = z.object({
    routingKey: secret(z.string().max(200)).describe(
      "The installation's routing key",
    ),
  });

  /**
   * @param _params - The routing key (read again from the raw path).
   * @param connection - The HTTP connection, whose raw request is read.
   * @returns The response, built by ingress.
   */
  async run(_params: unknown, connection: Connection) {
    return handleDelivery("pylon", rawRequestOf(connection));
  }
}
