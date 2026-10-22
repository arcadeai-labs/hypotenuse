import {
  DaemonToolAction,
  type ToolFunction,
} from "../../../classes/DaemonToolAction";
import { getIssue } from "../../../ops/DaemonToolOps";

/**
 * `daemon:linear-get-issue` — a coding agent's `linear_get_issue` tool, called through its runner's
 * daemon: reads an issue, the session's own by default. Target rule: `readable`.
 *
 * Scoped by `DaemonSessionScopeMiddleware` to the session's live turn on
 * this runner; machine traffic, recorded in the turn's `linearWrites`, never
 * MCP for people, never wrapped by the CLI.
 */
export class DaemonLinearGetIssue extends DaemonToolAction {
  name = "daemon:linear-get-issue";
  protected readonly invoke: ToolFunction = getIssue;

  /** Bind the action to its tool's row in `protocol/src/tools.ts`. */
  constructor() {
    super();
    this.bind();
  }
}
