#!/usr/bin/env bun
/**
 * The scripted fake ACP agent: speaks the agent side of ACP on stdio, one
 * JSON-RPC message per line, without a model. It answers `initialize` with
 * the auth methods named in `FAKE_ACP_AUTH_METHODS` (comma-separated), and
 * exits when stdin closes. The agent host's suites extend it with sessions
 * and prompts.
 */
const decoder = new TextDecoder();
let buffer = "";
for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk);
  let newline = buffer.indexOf("\n");
  while (newline !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    newline = buffer.indexOf("\n");
    if (!line) continue;
    const message = JSON.parse(line) as { id?: number; method?: string };
    if (message.method === "initialize") {
      const methods = (process.env.FAKE_ACP_AUTH_METHODS ?? "")
        .split(",")
        .filter(Boolean);
      process.stdout.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: 1,
            agentInfo: { name: "fake-agent", version: "1.2.3" },
            agentCapabilities: { loadSession: true },
            authMethods: methods.map((id) => ({ id, name: id })),
          },
        })}\n`,
      );
    } else if (message.id !== undefined) {
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "not scripted" } })}\n`,
      );
    }
  }
}

export {};
