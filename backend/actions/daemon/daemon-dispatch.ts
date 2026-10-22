import {
  DaemonToolAction,
  type ToolFunction,
} from "../../classes/DaemonToolAction";
import { dispatch } from "../../ops/DaemonToolOps";

/**
 * `daemon:dispatch` — a manager agent's `hypotenuse_dispatch` tool, called
 * through its runner's daemon: delegates an issue the manager manages to the
 * app, starts a Linear session on it, and queues a worker turn on that
 * session as the manager's child — or, with `mode: "changes"`, sends a
 * finished child back to its own session and worktree. Every guard and the
 * order of the writes are in `ops/DispatchOps.ts`.
 *
 * Scoped by `DaemonSessionScopeMiddleware` to the session's live turn on
 * this runner; never MCP for people, never wrapped by the CLI. Machine
 * traffic like every `daemon:*` action, with one exception to their being
 * unaudited: it delegates work to the app on a person's issue, so it writes
 * an `agent:dispatch` audit row.
 */
export class DaemonDispatch extends DaemonToolAction {
  name = "daemon:dispatch";
  protected readonly invoke: ToolFunction = dispatch;

  /** Bind the action to its tool's row in `protocol/src/tools.ts`. */
  constructor() {
    super();
    this.bind();
  }
}
