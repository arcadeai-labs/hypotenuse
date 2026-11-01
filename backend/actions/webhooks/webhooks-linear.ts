import { type Action, type Connection, HTTP_METHOD, secret } from "keryx";
import { z } from "zod";
import { handleDelivery } from "../../ops/IngressOps";
import { rawRequestOf } from "../../ops/RawRequestOps";

/**
 * `webhooks:linear` — ingress for Linear: one bot's Linear app webhook (agent
 * sessions, inbox notifications, permission changes, issues, revocation),
 * named by the routing key in its path, signed with `Linear-Signature` over
 * the raw body and a `webhookTimestamp` within 60 seconds. Linear wants a 200
 * within five seconds and disables a webhook that keeps failing, so a
 * workspace is never refused: an installation that is not active, or a
 * delivery from another workspace, is answered 200 and recorded or dropped.
 * Verifies, records a trigger event, answers, and enqueues; never runs a
 * model or calls Linear inline. No middleware: no session, no rate limit.
 * Never an MCP tool. Not audited: machine ingress, recorded in
 * `trigger_events`.
 */
export class WebhooksLinear implements Action {
  name = "webhooks:linear";
  description =
    "Receive a signed webhook delivery from a bot's Linear app. Not for people.";
  mcp = { tool: false };
  web = {
    route: "/webhooks/linear/:routingKey",
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
    return handleDelivery("linear", rawRequestOf(connection));
  }
}
