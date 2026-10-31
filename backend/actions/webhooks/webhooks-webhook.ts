import { type Action, type Connection, HTTP_METHOD } from "keryx";
import { z } from "zod";
import { handleDelivery } from "../../ops/IngressOps";
import { rawRequestOf } from "../../ops/RawRequestOps";

/**
 * `webhooks:webhook` — ingress for the generic webhook platform: a signed
 * JSON delivery for one installation, named by the routing key in its path.
 * Verifies, records a trigger event, answers, and enqueues; never runs a
 * model or calls a platform inline. No middleware: no session, no rate
 * limit. Never an MCP tool. Not audited: machine ingress, recorded in
 * `trigger_events`.
 */
export class WebhooksWebhook implements Action {
  name = "webhooks:webhook";
  description =
    "Receive a signed delivery from a system connected as a webhook platform. Not for people.";
  mcp = { tool: false };
  web = {
    route: "/webhooks/webhook/:routingKey",
    method: HTTP_METHOD.POST,
    rawBody: true,
  };
  inputs = z.object({
    routingKey: z.string().max(200).describe("The installation's routing key"),
  });

  /**
   * @param _params - The routing key (read again from the raw path).
   * @param connection - The HTTP connection, whose raw request is read.
   * @returns The response, built by ingress.
   */
  async run(_params: unknown, connection: Connection) {
    return handleDelivery("webhook", rawRequestOf(connection));
  }
}
