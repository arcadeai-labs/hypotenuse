import {
  DaemonToolAction,
  type ToolFunction,
} from "../../../classes/DaemonToolAction";
import { createIssue } from "../../../ops/DaemonToolOps";

/**
 * `daemon:linear-create-issue` — a coding agent's `linear_create_issue` tool, called through its runner's
 * daemon: creates an issue as the app, attributed to the session's creator (`createAsUser`); never assigns. Manager only; the team must be `readable`, a parent `managed`.
 *
 * Scoped by `DaemonSessionScopeMiddleware` to the session's live turn on
 * this runner; machine traffic, recorded in the turn's `linearWrites`, never
 * MCP for people, never wrapped by the CLI.
 */
export class DaemonLinearCreateIssue extends DaemonToolAction {
  name = "daemon:linear-create-issue";
  protected readonly invoke: ToolFunction = createIssue;

  /** Bind the action to its tool's row in `protocol/src/tools.ts`. */
  constructor() {
    super();
    this.bind();
  }
}
