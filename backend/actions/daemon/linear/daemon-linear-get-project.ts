import {
  DaemonToolAction,
  type ToolFunction,
} from "../../../classes/DaemonToolAction";
import { getProject } from "../../../ops/DaemonToolOps";

/**
 * `daemon:linear-get-project` — a coding agent's `linear_get_project` tool, called through its runner's
 * daemon: reads a project, the session issue's by default. Manager only; the project must be in a `readable` team.
 *
 * Scoped by `DaemonSessionScopeMiddleware` to the session's live turn on
 * this runner; machine traffic, recorded in the turn's `linearWrites`, never
 * MCP for people, never wrapped by the CLI.
 */
export class DaemonLinearGetProject extends DaemonToolAction {
  name = "daemon:linear-get-project";
  protected readonly invoke: ToolFunction = getProject;

  /** Bind the action to its tool's row in `protocol/src/tools.ts`. */
  constructor() {
    super();
    this.bind();
  }
}
