import {
  DaemonToolAction,
  type ToolFunction,
} from "../../../classes/DaemonToolAction";
import { listLabels } from "../../../ops/DaemonToolOps";

/**
 * `daemon:linear-list-labels` — a coding agent's `linear_list_labels` tool, called through its runner's
 * daemon: lists a team's labels and the workspace's. Manager only; target rule: `readable`.
 *
 * Scoped by `DaemonSessionScopeMiddleware` to the session's live turn on
 * this runner; machine traffic, recorded in the turn's `linearWrites`, never
 * MCP for people, never wrapped by the CLI.
 */
export class DaemonLinearListLabels extends DaemonToolAction {
  name = "daemon:linear-list-labels";
  protected readonly invoke: ToolFunction = listLabels;

  /** Bind the action to its tool's row in `protocol/src/tools.ts`. */
  constructor() {
    super();
    this.bind();
  }
}
