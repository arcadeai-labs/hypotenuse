import {
  DaemonToolAction,
  type ToolFunction,
} from "../../../classes/DaemonToolAction";
import { updateIssue } from "../../../ops/DaemonToolOps";

/**
 * `daemon:linear-update-issue` — a coding agent's `linear_update_issue` tool, called through its runner's
 * daemon: edits an issue's title, description, labels, priority, project, or estimate — never its assignee. Manager only; target rule: `managed`.
 *
 * Scoped by `DaemonSessionScopeMiddleware` to the session's live turn on
 * this runner; machine traffic, recorded in the turn's `linearWrites`, never
 * MCP for people, never wrapped by the CLI.
 */
export class DaemonLinearUpdateIssue extends DaemonToolAction {
  name = "daemon:linear-update-issue";
  protected readonly invoke: ToolFunction = updateIssue;

  /** Bind the action to its tool's row in `protocol/src/tools.ts`. */
  constructor() {
    super();
    this.bind();
  }
}
