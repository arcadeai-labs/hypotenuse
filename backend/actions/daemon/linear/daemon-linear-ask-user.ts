import {
  DaemonToolAction,
  type ToolFunction,
} from "../../../classes/DaemonToolAction";
import { askUser } from "../../../ops/DaemonToolOps";

/**
 * `daemon:linear-ask-user` — a coding agent's `linear_ask_user` tool, called through its runner's
 * daemon: posts an `elicitation` (a `select` with options) through the activity outbox; it answers the turn, which then ends without a `response`. Target: the session itself.
 *
 * Scoped by `DaemonSessionScopeMiddleware` to the session's live turn on
 * this runner; machine traffic, recorded in the turn's `linearWrites`, never
 * MCP for people, never wrapped by the CLI.
 */
export class DaemonLinearAskUser extends DaemonToolAction {
  name = "daemon:linear-ask-user";
  protected readonly invoke: ToolFunction = askUser;

  /** Bind the action to its tool's row in `protocol/src/tools.ts`. */
  constructor() {
    super();
    this.bind();
  }
}
