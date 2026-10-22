import {
  DaemonToolAction,
  type ToolFunction,
} from "../../../classes/DaemonToolAction";
import { createSubIssue } from "../../../ops/DaemonToolOps";

/**
 * `daemon:linear-create-sub-issue` — a coding agent's `linear_create_sub_issue` tool, called through its runner's
 * daemon: creates a sub-issue under a parent. Manager only; the parent must be `managed`.
 *
 * Scoped by `DaemonSessionScopeMiddleware` to the session's live turn on
 * this runner; machine traffic, recorded in the turn's `linearWrites`, never
 * MCP for people, never wrapped by the CLI.
 */
export class DaemonLinearCreateSubIssue extends DaemonToolAction {
  name = "daemon:linear-create-sub-issue";
  protected readonly invoke: ToolFunction = createSubIssue;

  /** Bind the action to its tool's row in `protocol/src/tools.ts`. */
  constructor() {
    super();
    this.bind();
  }
}
