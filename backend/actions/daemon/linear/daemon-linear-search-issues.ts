import {
  DaemonToolAction,
  type ToolFunction,
} from "../../../classes/DaemonToolAction";
import { searchIssues } from "../../../ops/DaemonToolOps";

/**
 * `daemon:linear-search-issues` — a coding agent's `linear_search_issues` tool, called through its runner's
 * daemon: searches issues by text and filters, at most 25, in readable teams only. Target rule: `readable`.
 *
 * Scoped by `DaemonSessionScopeMiddleware` to the session's live turn on
 * this runner; machine traffic, recorded in the turn's `linearWrites`, never
 * MCP for people, never wrapped by the CLI.
 */
export class DaemonLinearSearchIssues extends DaemonToolAction {
  name = "daemon:linear-search-issues";
  protected readonly invoke: ToolFunction = searchIssues;

  /** Bind the action to its tool's row in `protocol/src/tools.ts`. */
  constructor() {
    super();
    this.bind();
  }
}
