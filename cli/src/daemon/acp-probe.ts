/**
 * `doctor --agent <id>`'s handshake: start the agent, send ACP `initialize`
 * over stdio, and report what it says about itself — its version, and the
 * `authMethods` it would need before a session. One JSON-RPC request, read
 * line by line; the agent is killed afterwards.
 */
import pkg from "../../package.json";

/** What an agent's `initialize` answered. */
export interface ProbeResult {
  ok: boolean;
  protocolVersion?: number;
  agentInfo?: { name?: string; version?: string };
  authMethods: { id: string; name?: string }[];
  error?: string;
}

/** The ACP protocol version the daemon speaks. */
export const ACP_PROTOCOL_VERSION = 1;

/**
 * Run the handshake.
 * @param command - The agent's command line.
 * @param env - Its environment.
 * @param timeoutMs - How long it has to answer.
 * @returns What it answered.
 */
export async function probeAgent(
  command: string[],
  env: Record<string, string | undefined>,
  timeoutMs: number,
): Promise<ProbeResult> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(command, {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
      env: env as Record<string, string>,
    });
  } catch (error) {
    return {
      ok: false,
      authMethods: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const request = {
    jsonrpc: "2.0",
    id: 0,
    method: "initialize",
    params: {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: "hypotenuse", version: pkg.version },
    },
  };
  const stdin = proc.stdin as import("bun").FileSink;
  stdin.write(`${JSON.stringify(request)}\n`);
  stdin.flush();

  const read = (async (): Promise<ProbeResult> => {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
      buffer += decoder.decode(chunk);
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        let message: {
          id?: unknown;
          result?: Record<string, unknown>;
          error?: { message?: string };
        };
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id !== 0) continue;
        if (message.error)
          return {
            ok: false,
            authMethods: [],
            error: message.error.message ?? "initialize failed",
          };
        const result = message.result ?? {};
        return {
          ok: true,
          protocolVersion: result.protocolVersion as number | undefined,
          agentInfo: result.agentInfo as ProbeResult["agentInfo"],
          authMethods: (
            (result.authMethods as ProbeResult["authMethods"]) ?? []
          ).map((m) => ({ id: m.id, name: m.name })),
        };
      }
    }
    return {
      ok: false,
      authMethods: [],
      error: "the agent exited without answering initialize",
    };
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<ProbeResult>((resolve) => {
    timer = setTimeout(
      () =>
        resolve({
          ok: false,
          authMethods: [],
          error: `no answer to initialize within ${timeoutMs / 1000}s`,
        }),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([read, timeout]);
  } finally {
    clearTimeout(timer);
    proc.kill();
  }
}
