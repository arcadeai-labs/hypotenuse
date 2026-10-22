import {
  DaemonToolAction,
  type ToolFunction,
} from "../../../classes/DaemonToolAction";
import { setPlan } from "../../../ops/DaemonToolOps";

/**
 * `daemon:linear-set-plan` — a coding agent's `linear_set_plan` tool, called through its runner's
 * daemon: replaces the session's plan, through the activity outbox. Target: the session itself.
 *
 * Scoped by `DaemonSessionScopeMiddleware` to the session's live turn on
 * this runner; machine traffic, recorded in the turn's `linearWrites`, never
 * MCP for people, never wrapped by the CLI.
 */
export class DaemonLinearSetPlan extends DaemonToolAction {
  name = "daemon:linear-set-plan";
  protected readonly invoke: ToolFunction = setPlan;

  /** Bind the action to its tool's row in `protocol/src/tools.ts`. */
  constructor() {
    super();
    this.bind();
  }
}
