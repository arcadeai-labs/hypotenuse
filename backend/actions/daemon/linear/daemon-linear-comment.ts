import {
  DaemonToolAction,
  type ToolFunction,
} from "../../../classes/DaemonToolAction";
import { comment } from "../../../ops/DaemonToolOps";

/**
 * `daemon:linear-comment` — a coding agent's `linear_comment` tool, called through its runner's
 * daemon: posts a comment as the app. Target rule: `session-issue` for a worker, `managed` for a manager.
 *
 * Scoped by `DaemonSessionScopeMiddleware` to the session's live turn on
 * this runner; machine traffic, recorded in the turn's `linearWrites`, never
 * MCP for people, never wrapped by the CLI.
 */
export class DaemonLinearComment extends DaemonToolAction {
  name = "daemon:linear-comment";
  protected readonly invoke: ToolFunction = comment;

  /** Bind the action to its tool's row in `protocol/src/tools.ts`. */
  constructor() {
    super();
    this.bind();
  }
}
