import {
  DaemonToolAction,
  type ToolFunction,
} from "../../../classes/DaemonToolAction";
import { setIssueState } from "../../../ops/DaemonToolOps";

/**
 * `daemon:linear-set-issue-state` — a coding agent's `linear_set_issue_state` tool, called through its runner's
 * daemon: moves an issue to a state by name or type; a worker may not choose a `canceled` one. Target rule: `session-issue` for a worker, `managed` for a manager.
 *
 * Scoped by `DaemonSessionScopeMiddleware` to the session's live turn on
 * this runner; machine traffic, recorded in the turn's `linearWrites`, never
 * MCP for people, never wrapped by the CLI.
 */
export class DaemonLinearSetIssueState extends DaemonToolAction {
  name = "daemon:linear-set-issue-state";
  protected readonly invoke: ToolFunction = setIssueState;

  /** Bind the action to its tool's row in `protocol/src/tools.ts`. */
  constructor() {
    super();
    this.bind();
  }
}
