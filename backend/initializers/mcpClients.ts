import { Initializer, logger } from "keryx";
import { closeAllClients, closeIdleClients } from "../ops/McpClientOps";

const namespace = "mcpClients";

/** How often idle clients are looked for. */
const SWEEP_MS = 60_000;

/**
 * The MCP client pool's lifecycle: a sweep that closes clients idle past
 * `MCP_CLIENT_IDLE_MS`, and closing every client when the process stops. The
 * pool itself lives in `ops/McpClientOps.ts`, reached like any other ops
 * module, so nothing is attached to `api`.
 */
export class McpClients extends Initializer {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    super(namespace);
    this.declaresAPIProperty = false;
  }

  /** Start the idle sweep. */
  async start(): Promise<void> {
    this.timer = setInterval(() => {
      closeIdleClients().then(
        (n) => {
          if (n > 0) logger.debug(`closed ${n} idle MCP client(s)`);
        },
        () => {},
      );
    }, SWEEP_MS);
    this.timer.unref?.();
  }

  /** Stop the sweep and close every client. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await closeAllClients();
  }
}
