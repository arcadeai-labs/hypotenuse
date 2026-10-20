import {
  type Action,
  type ActionParams,
  ErrorType,
  HTTP_METHOD,
  RateLimitMiddleware,
  secret,
  TypedError,
} from "keryx";
import { z } from "zod";
import {
  mintCliToken,
  pollDeviceCode,
  redeemLoopbackCode,
  serializeCliToken,
} from "../../ops/CliTokenOps";

/**
 * `cli-auth:exchange` — the CLI redeems a person's approval for a CLI token.
 *
 * Two shapes, one per flow: `{ code, codeVerifier }` after the loopback redirect,
 * or `{ deviceCode }` while polling a device flow. A device code nobody has
 * approved yet answers `status: "pending"`; an approved one answers the token
 * exactly once. Every failure — unknown, expired, reused, or a verifier that does
 * not match — is the same 406.
 *
 * Unauthenticated machine ingress: never an MCP tool, rate-limited, and not
 * audited. The decision was the person's approve or activate, which was.
 */
export class CliAuthExchange implements Action {
  name = "cli-auth:exchange";
  description =
    "Redeem an approved CLI sign-in for a CLI token: a loopback code with its PKCE verifier, or a device code.";
  middleware = [RateLimitMiddleware];
  web = { route: "/cli-auth/exchange", method: HTTP_METHOD.POST };
  inputs = z.object({
    code: secret(z.string().min(1).max(128))
      .optional()
      .describe("The one-time code from the loopback redirect"),
    codeVerifier: secret(z.string().min(43).max(128))
      .optional()
      .describe("The PKCE verifier whose S256 challenge was approved"),
    deviceCode: secret(z.string().min(1).max(128))
      .optional()
      .describe("The device code from cli-auth:device"),
  });

  /**
   * @param params - Either `code` + `codeVerifier`, or `deviceCode`.
   * @returns `{ status: "approved", token, cliToken }`, or `{ status: "pending" }`
   *   with null token fields while a device code waits for its person.
   * @throws {TypedError} `CONNECTION_ACTION_PARAM_VALIDATION` for a malformed
   *   request or any code that does not redeem.
   */
  async run(params: ActionParams<CliAuthExchange>) {
    let grant: { userId: number; device: string };
    if (params.deviceCode !== undefined && params.code === undefined) {
      const polled = await pollDeviceCode(params.deviceCode);
      if (polled.status === "pending") {
        return { status: "pending" as const, token: null, cliToken: null };
      }
      grant = polled;
    } else if (
      params.code !== undefined &&
      params.codeVerifier !== undefined &&
      params.deviceCode === undefined
    ) {
      grant = await redeemLoopbackCode(params.code, params.codeVerifier);
    } else {
      throw new TypedError({
        message: "Send either code and codeVerifier, or deviceCode",
        type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
      });
    }

    const { token, row } = await mintCliToken(grant.userId, grant.device);
    return {
      status: "approved" as const,
      token: token as string | null,
      cliToken: serializeCliToken(row, row.id) as ReturnType<
        typeof serializeCliToken
      > | null,
    };
  }
}
