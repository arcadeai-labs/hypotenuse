/**
 * `hypotenuse mcp --session <id> --nonce <n>` — hidden: the stdio MCP server
 * the daemon hands a coding agent for one turn (`mcp/server.ts`). Not for
 * people to run; it is useful by hand only with a live turn's nonce, e.g.
 * under `bunx @modelcontextprotocol/inspector`.
 */
import { join } from "node:path";
import type { Command } from "commander";
import { resolveConfigPath, resolveStateDir } from "../config/paths";
import { callDaemon } from "../daemon/control-client";
import { serveStdio } from "../mcp/server";

/**
 * Register the hidden `mcp` command.
 * @param program - The root program.
 */
export function registerMcpCommand(program: Command): void {
  program
    .command("mcp", { hidden: true })
    .description(
      "serve a turn's Hypotenuse tools to a coding agent (stdio MCP)",
    )
    .requiredOption("--session <id>", "the Hypotenuse session id")
    .requiredOption("--nonce <nonce>", "the turn's nonce")
    .action(async (options: { session: string; nonce: string }) => {
      const globals = program.opts<{ config?: string; stateDir?: string }>();
      const stateDir =
        process.env.HYPOTENUSE_STATE_DIR ||
        resolveStateDir(resolveConfigPath(globals.config), globals.stateDir);
      const socket = join(stateDir, "daemon.sock");
      await serveStdio({
        agentSessionId: Number(options.session),
        nonce: options.nonce,
        call: (method, params, timeoutMs) =>
          callDaemon(socket, method, params, timeoutMs),
        log: (line) => process.stderr.write(`${line}\n`),
      });
      process.exit(0);
    });
}
