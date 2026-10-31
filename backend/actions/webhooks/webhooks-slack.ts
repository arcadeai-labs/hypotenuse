import { type Action, type Connection, HTTP_METHOD, secret } from "keryx";
import { z } from "zod";
import { handleDelivery } from "../../ops/IngressOps";
import { rawRequestOf } from "../../ops/RawRequestOps";

/**
 * `webhooks:slack` — ingress for Slack: an Events API delivery (JSON) or an
 * interactivity payload (a form), v0-signed, for one bot's Slack app, named
 * by the routing key in its path. `url_verification` is answered with its
 * challenge. Slack wants a 2xx within three seconds and retries otherwise.
 * Verifies, records a trigger event, answers, and enqueues; never runs a
 * model or calls a platform inline. No middleware: no session, no rate
 * limit. Never an MCP tool. Not audited: machine ingress, recorded in
 * `trigger_events`.
 */
export class WebhooksSlack implements Action {
  name = "webhooks:slack";
  description =
    "Receive a signed Events API or interactivity delivery from a bot's Slack app. Not for people.";
  mcp = { tool: false };
  web = {
    route: "/webhooks/slack/:routingKey",
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
    return handleDelivery("slack", rawRequestOf(connection));
  }
}
