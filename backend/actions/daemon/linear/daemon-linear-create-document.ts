import {
  DaemonToolAction,
  type ToolFunction,
} from "../../../classes/DaemonToolAction";
import { createDocument } from "../../../ops/DaemonToolOps";

/**
 * `daemon:linear-create-document` — a coding agent's `linear_create_document` tool, called through its runner's
 * daemon: creates a document on the session issue's project or an issue it manages. Manager only.
 *
 * Scoped by `DaemonSessionScopeMiddleware` to the session's live turn on
 * this runner; machine traffic, recorded in the turn's `linearWrites`, never
 * MCP for people, never wrapped by the CLI.
 */
export class DaemonLinearCreateDocument extends DaemonToolAction {
  name = "daemon:linear-create-document";
  protected readonly invoke: ToolFunction = createDocument;

  /** Bind the action to its tool's row in `protocol/src/tools.ts`. */
  constructor() {
    super();
    this.bind();
  }
}
