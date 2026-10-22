import {
  DaemonToolAction,
  type ToolFunction,
} from "../../../classes/DaemonToolAction";
import { updateDocument } from "../../../ops/DaemonToolOps";

/**
 * `daemon:linear-update-document` — a coding agent's `linear_update_document` tool, called through its runner's
 * daemon: replaces a document this session created, or one on the session issue's project or a managed issue. Manager only.
 *
 * Scoped by `DaemonSessionScopeMiddleware` to the session's live turn on
 * this runner; machine traffic, recorded in the turn's `linearWrites`, never
 * MCP for people, never wrapped by the CLI.
 */
export class DaemonLinearUpdateDocument extends DaemonToolAction {
  name = "daemon:linear-update-document";
  protected readonly invoke: ToolFunction = updateDocument;

  /** Bind the action to its tool's row in `protocol/src/tools.ts`. */
  constructor() {
    super();
    this.bind();
  }
}
