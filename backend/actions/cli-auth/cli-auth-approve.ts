import { type ActionParams, HTTP_METHOD, RateLimitMiddleware } from "keryx";
import { z } from "zod";
import {
  AuditedAction,
  type AuditedConnection,
  type TxHandle,
} from "../../classes/AuditedAction";
import { BrowserSessionMiddleware } from "../../middleware/session";
import { createLoopbackCode, deviceInput } from "../../ops/CliTokenOps";

/**
 * `cli-auth:approve` — a signed-in person approves a `hypotenuse login` on one
 * of their machines. Answers a one-time code, bound to them and to the CLI's
 * PKCE challenge, that the dashboard page hands to the CLI's loopback listener.
 * The code redeems for a CLI token at `cli-auth:exchange`.
 *
 * A browser hop: never an MCP tool, and refused to a CLI token. Audited — the
 * approval is the person's decision; the exchange that follows is machine
 * ingress.
 */
export class CliAuthApprove extends AuditedAction {
  name = "cli-auth:approve";
  description =
    "Approve signing in the hypotenuse CLI on one of your machines (the loopback + PKCE flow). Returns a one-time code for the CLI's local listener. Requires a browser session.";
  middleware = [RateLimitMiddleware, BrowserSessionMiddleware];
  web = { route: "/cli-auth/approve", method: HTTP_METHOD.PUT };
  inputs = z.object({
    codeChallenge: z
      .string()
      .regex(
        /^[A-Za-z0-9_-]{43}$/,
        "codeChallenge must be a base64url S256 PKCE challenge",
      )
      .describe("The CLI's PKCE code challenge (S256, base64url)"),
    device: deviceInput,
  });

  /**
   * @param _tx - Unused: the code lives in Redis; the audit row is the write.
   * @param params - The challenge and the device name.
   * @param connection - The approving person's connection.
   * @returns The one-time code and its lifetime in seconds.
   */
  async runWithAudit(
    _tx: TxHandle,
    params: ActionParams<CliAuthApprove>,
    connection: AuditedConnection,
  ) {
    const { code, expiresIn } = await createLoopbackCode({
      userId: connection.session!.data.userId!,
      codeChallenge: params.codeChallenge,
      device: params.device,
    });
    connection.metadata.auditTargetType = "cli-token";
    connection.metadata.auditTargetPath = params.device;
    connection.metadata.auditAfter = {
      device: params.device,
      flow: "loopback",
    };
    return { code, expiresIn };
  }
}
