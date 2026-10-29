import { api, Initializer } from "keryx";
import { applyMcpToolPolicy } from "../ops/McpToolPolicyOps";

const namespace = "mcpToolPolicy";

/**
 * Stamp every action's `mcp.tool` from the publish policy before any MCP
 * session opens.
 *
 * Depends on `mcp` so it runs after Keryx's MCP initializer, and does its work
 * in `initialize` so the flags are set before `start` registers tools on the
 * first session. Runs even when MCP is disabled: `rbac.test.ts` reads the live
 * flags.
 *
 * `declaresAPIProperty = false`: nothing is attached to `api`.
 */
export class McpToolPolicy extends Initializer {
  constructor() {
    super(namespace);
    this.dependsOn = ["mcp"];
    this.declaresAPIProperty = false;
  }

  /** Overwrite `mcp.tool` on every registered action. */
  async initialize(): Promise<void> {
    applyMcpToolPolicy(api.actions.actions);
  }
}
