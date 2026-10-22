import {
  DaemonToolAction,
  type ToolFunction,
} from "../../../classes/DaemonToolAction";
import { createRelation } from "../../../ops/DaemonToolOps";

/**
 * `daemon:linear-create-relation` — a coding agent's `linear_create_relation` tool, called through its runner's
 * daemon: relates two issues. Manager only; both `readable`, at least one `managed`.
 *
 * Scoped by `DaemonSessionScopeMiddleware` to the session's live turn on
 * this runner; machine traffic, recorded in the turn's `linearWrites`, never
 * MCP for people, never wrapped by the CLI.
 */
export class DaemonLinearCreateRelation extends DaemonToolAction {
  name = "daemon:linear-create-relation";
  protected readonly invoke: ToolFunction = createRelation;

  /** Bind the action to its tool's row in `protocol/src/tools.ts`. */
  constructor() {
    super();
    this.bind();
  }
}
