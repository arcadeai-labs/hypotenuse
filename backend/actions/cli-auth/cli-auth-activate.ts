import { type ActionParams, HTTP_METHOD, RateLimitMiddleware } from "keryx";
import { z } from "zod";
import {
  AuditedAction,
  type AuditedConnection,
  type TxHandle,
} from "../../classes/AuditedAction";
import { BrowserSessionMiddleware } from "../../middleware/session";
import { approveDeviceCode, findDeviceCode } from "../../ops/CliTokenOps";

/**
 * `cli-auth:activate` — a signed-in person types the code a
 * `hypotenuse login --device` printed, approving that machine. The CLI's
 * next poll of `cli-auth:exchange` receives its token.
 *
 * A browser hop: never an MCP tool, and refused to a CLI token. Audited.
 */
export class CliAuthActivate extends AuditedAction {
  name = "cli-auth:activate";
  description =
    "Approve a hypotenuse CLI that is signing in with a device code, by the code it printed. Requires a browser session.";
  middleware = [RateLimitMiddleware, BrowserSessionMiddleware];
  web = { route: "/cli-auth/activate", method: HTTP_METHOD.POST };
  inputs = z.object({
    userCode: z
      .string()
      .min(1, "Enter the code the CLI printed")
      .max(32)
      .describe("The code the CLI printed, like WDJB-MJHT"),
  });

  /**
   * @param _tx - Unused: the approval lives in Redis; the audit row is the write.
   * @param params - The typed user code.
   * @param connection - The approving person's connection.
   * @returns The device the person approved.
   * @throws {TypedError} `CONNECTION_ACTION_PARAM_VALIDATION` for an unknown,
   *   expired, or already-used code.
   */
  async runWithAudit(
    _tx: TxHandle,
    params: ActionParams<CliAuthActivate>,
    connection: AuditedConnection,
  ) {
    const found = await findDeviceCode(params.userCode);
    await approveDeviceCode(found, connection.session!.data.userId!);
    connection.metadata.auditTargetType = "cli-token";
    connection.metadata.auditTargetPath = found.device;
    connection.metadata.auditAfter = { device: found.device, flow: "device" };
    return { device: found.device };
  }
}
