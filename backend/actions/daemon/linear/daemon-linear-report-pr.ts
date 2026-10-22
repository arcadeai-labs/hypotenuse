import {
  DaemonToolAction,
  type ToolFunction,
} from "../../../classes/DaemonToolAction";
import { reportPr } from "../../../ops/DaemonToolOps";

/**
 * `daemon:linear-report-pr` — a coding agent's `linear_report_pr` tool, called through its runner's
 * daemon: links a pull request on the session's repository to the session, through the activity outbox. Target: the session itself.
 *
 * Scoped by `DaemonSessionScopeMiddleware` to the session's live turn on
 * this runner; machine traffic, recorded in the turn's `linearWrites`, never
 * MCP for people, never wrapped by the CLI.
 */
export class DaemonLinearReportPr extends DaemonToolAction {
  name = "daemon:linear-report-pr";
  protected readonly invoke: ToolFunction = reportPr;

  /** Bind the action to its tool's row in `protocol/src/tools.ts`. */
  constructor() {
    super();
    this.bind();
  }
}
