import { type Action, type Connection, HTTP_METHOD } from "keryx";
import { z } from "zod";
import { handleGitHubDelivery } from "../../ops/GitHubEventOps";
import { rawRequestOf } from "../../ops/RawRequestOps";

/**
 * `webhooks:github` — ingress for the deployment's GitHub App: one URL for
 * the one App. Verifies `X-Hub-Signature-256` over the raw body, records a
 * `trigger_events` row per project that attached the event's installation
 * (deduped on `X-GitHub-Delivery`), answers, and enqueues; never calls GitHub
 * or runs a model inline (`GitHubEventOps`). No middleware: no session, no
 * rate limit. Never an MCP tool. Not audited: machine ingress, recorded in
 * `trigger_events`.
 */
export class WebhooksGithub implements Action {
  name = "webhooks:github";
  description =
    "Receive a signed webhook delivery from the deployment's GitHub App. Not for people.";
  mcp = { tool: false };
  web = {
    route: "/webhooks/github",
    method: HTTP_METHOD.POST,
    rawBody: true,
  };
  inputs = z.object({});

  /**
   * @param _params - Nothing: everything is in the raw request.
   * @param connection - The HTTP connection, whose raw request is read.
   * @returns The response, built by ingress.
   */
  async run(_params: unknown, connection: Connection) {
    return handleGitHubDelivery(rawRequestOf(connection));
  }
}
