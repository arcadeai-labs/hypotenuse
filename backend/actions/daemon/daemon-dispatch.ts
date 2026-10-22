import {
  DaemonToolAction,
  type ToolFunction,
} from "../../classes/DaemonToolAction";
import { dispatch } from "../../ops/DaemonToolOps";

/**
 * `daemon:dispatch` — a coding agent's `hypotenuse_dispatch` tool, called through its runner's
 * daemon: hands an issue the manager manages to a worker. It validates the target (`managed`) and records the hand-off in the turn's ledger; starting the worker's turn is the manager's dispatch, which this server does not run yet, and the answer says so.
 *
 * Scoped by `DaemonSessionScopeMiddleware` to the session's live turn on
 * this runner; machine traffic, recorded in the turn's `linearWrites`, never
 * MCP for people, never wrapped by the CLI.
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
