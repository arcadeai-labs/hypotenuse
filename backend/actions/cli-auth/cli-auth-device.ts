import {
  type Action,
  type ActionParams,
  config,
  HTTP_METHOD,
  RateLimitMiddleware,
} from "keryx";
import { z } from "zod";
import { createDeviceCode, deviceInput } from "../../ops/CliTokenOps";

/**
 * `cli-auth:device` — start a device-code sign-in for a CLI with no browser
 * (`hypotenuse login --device`, an SSH session). Answers a secret
 * `deviceCode` for the CLI to poll `cli-auth:exchange` with, and a short
 * `userCode` for the person to type at `verificationUrl`.
 *
 * Unauthenticated machine ingress: never an MCP tool, rate-limited, and not
 * audited — nothing is decided until a person activates the code.
 */
export class CliAuthDevice implements Action {
  name = "cli-auth:device";
  description =
    "Start a device-code sign-in for the hypotenuse CLI. Returns a code for a person to enter in the dashboard and a secret for the CLI to poll with.";
  middleware = [RateLimitMiddleware];
  web = { route: "/cli-auth/device", method: HTTP_METHOD.PUT };
  inputs = z.object({ device: deviceInput });

  /**
   * @param params - The device name.
   * @returns The device code, user code, where to enter it, its lifetime, and
   *   how often to poll, in seconds.
   */
  async run(params: ActionParams<CliAuthDevice>) {
    const { deviceCode, userCode, expiresIn } = await createDeviceCode(
      params.device,
    );
    return {
      deviceCode,
      userCode,
      verificationUrl: `${config.frontend.url.replace(/\/$/, "")}/cli/activate`,
      expiresIn,
      interval: config.cliAuth.pollIntervalSeconds,
    };
  }
}
