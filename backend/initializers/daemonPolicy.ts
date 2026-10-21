import { isSupportedProtocol, PROTOCOL_HEADER } from "@hypotenuse/protocol";
import { api, Initializer } from "keryx";
import {
  isDaemonRequest,
  protocolUnsupportedResponse,
} from "../ops/DaemonPolicyOps";

const namespace = "daemonPolicy";

/**
 * Require `X-Hypotenuse-Protocol` on every daemon request, at the HTTP edge.
 *
 * A web `beforeRequest` hook rather than action middleware because the answer
 * is a **426**, and Keryx's typed errors map to a fixed set of statuses that
 * does not include it. Every daemon action routes under `/daemon/`
 * (`runner-policy.test.ts` asserts it), so the path is the action family. It
 * runs before authentication: a daemon too old to speak the protocol is told
 * to upgrade whether or not its token is good. A runner's WebSocket session
 * was minted by `daemon:connect`, which passed this check.
 *
 * `declaresAPIProperty = false`: nothing is attached to `api`.
 */
export class DaemonPolicy extends Initializer {
  constructor() {
    super(namespace);
    this.declaresAPIProperty = false;
  }

  /** Register the hook. */
  async initialize(): Promise<void> {
    api.hooks.web.beforeRequest((req) => {
      if (req.method === "OPTIONS" || !isDaemonRequest(req)) return undefined;
      return isSupportedProtocol(req.headers.get(PROTOCOL_HEADER))
        ? undefined
        : protocolUnsupportedResponse();
    });
  }
}
