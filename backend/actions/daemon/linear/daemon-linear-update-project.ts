import {
  DaemonToolAction,
  type ToolFunction,
} from "../../../classes/DaemonToolAction";
import { updateProject } from "../../../ops/DaemonToolOps";

/**
 * `daemon:linear-update-project` — a coding agent's `linear_update_project` tool, called through its runner's
 * daemon: writes the session issue's project's content, summary, or status — never its lead or members. Manager only.
 *
 * Scoped by `DaemonSessionScopeMiddleware` to the session's live turn on
 * this runner; machine traffic, recorded in the turn's `linearWrites`, never
 * MCP for people, never wrapped by the CLI.
 */
export class DaemonLinearUpdateProject extends DaemonToolAction {
  name = "daemon:linear-update-project";
  protected readonly invoke: ToolFunction = updateProject;

  /** Bind the action to its tool's row in `protocol/src/tools.ts`. */
  constructor() {
    super();
    this.bind();
  }
}
