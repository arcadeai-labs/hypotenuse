import {
  DaemonToolAction,
  type ToolFunction,
} from "../../../classes/DaemonToolAction";
import { listComments } from "../../../ops/DaemonToolOps";

/**
 * `daemon:linear-list-comments` — a coding agent's `linear_list_comments` tool, called through its runner's
 * daemon: reads one page of an issue's comments, threaded. Target rule: `readable`.
 *
 * Scoped by `DaemonSessionScopeMiddleware` to the session's live turn on
 * this runner; machine traffic, recorded in the turn's `linearWrites`, never
 * MCP for people, never wrapped by the CLI.
 */
export class DaemonLinearListComments extends DaemonToolAction {
  name = "daemon:linear-list-comments";
  protected readonly invoke: ToolFunction = listComments;

  /** Bind the action to its tool's row in `protocol/src/tools.ts`. */
  constructor() {
    super();
    this.bind();
  }
}
