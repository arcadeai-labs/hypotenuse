/**
 * The non-interactive handshake `doctor --agent` and `agents login` run: start
 * the agent, `initialize`, and (optionally) open a session in a scratch
 * directory, then stop it. It answers what the agent says about itself and
 * whether it is ready to work — the question a turn would otherwise find out
 * in Linear.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pkg from "../../package.json";
import {
  AcpConnection,
  type AuthMethod,
  errorMessage,
  isAuthRequired,
} from "./connection";

/** What the handshake found. */
export interface HandshakeResult {
  /** `initialize` answered. */
  ok: boolean;
  protocolVersion?: number;
  agentInfo?: { name?: string; title?: string | null; version?: string };
  authMethods: {
    id: string;
    name: string;
    type: string;
    args: string[];
    env: Record<string, string>;
  }[];
  /** A session opened (null when not tried, or `initialize` failed). */
  session: boolean | null;
  /** `session/new` asked for authentication. */
  authRequired: boolean;
  /** Why it failed. */
  error?: string;
}

/** Options for one handshake. */
export interface HandshakeOptions {
  /** The command line. */
  command: string[];
  /** The environment. */
  env: Record<string, string>;
  /** Time allowed for `initialize`. */
  timeoutMs: number;
  /** Also open a session. */
  session: boolean;
  /** Authenticate with this agent-run method before opening the session. */
  authenticate?: string;
}

/**
 * A method's shape, as `agents login` and `doctor` show it.
 * @param m - The advertised method.
 * @returns The id, name, type, and the terminal method's args and env.
 */
function describeMethod(m: AuthMethod): HandshakeResult["authMethods"][number] {
  const terminal = m as {
    type?: string;
    args?: string[];
    env?: Record<string, string>;
  };
  return {
    id: m.id,
    name: m.name,
    type: terminal.type ?? "agent",
    args: terminal.args ?? [],
    env: terminal.env ?? {},
  };
}

/**
 * Run the handshake.
 * @param options - The agent and what to try.
 * @returns What it found.
 */
export async function handshake(
  options: HandshakeOptions,
): Promise<HandshakeResult> {
  const cwd = mkdtempSync(join(tmpdir(), "hyp-handshake-"));
  const stderr: string[] = [];
  let conn: AcpConnection;
  const result: HandshakeResult = {
    ok: false,
    authMethods: [],
    session: null,
    authRequired: false,
  };
  try {
    conn = AcpConnection.spawn({
      command: options.command,
      cwd,
      env: options.env,
      stderr: (line) => {
        stderr.push(line);
        if (stderr.length > 5) stderr.shift();
      },
      noise: () => {},
      handlers: {
        update: () => {},
        requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
        readTextFile: async () => ({ content: "" }),
        writeTextFile: async () => {},
        createElicitation: async () => ({ action: "cancel" }),
      },
    });
  } catch (error) {
    rmSync(cwd, { recursive: true, force: true });
    return { ...result, error: errorMessage(error) };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), options.timeoutMs);
  });
  const exited = conn.exited.then((code) => ({ exited: code }));
  try {
    const init = await Promise.race([
      conn.initialize(pkg.version),
      timeout,
      exited,
    ]);
    if (init === "timeout") {
      result.error = `no answer to initialize within ${options.timeoutMs / 1000}s`;
      return result;
    }
    if ("exited" in init) {
      result.error = `the agent exited (code ${init.exited ?? "signal"}) without answering initialize${stderr.length ? `: ${stderr.at(-1)}` : ""}`;
      return result;
    }
    result.ok = true;
    result.protocolVersion = init.protocolVersion;
    result.agentInfo = init.agentInfo ?? undefined;
    result.authMethods = (init.authMethods ?? []).map(describeMethod);
    if (!options.session) return result;
    if (options.authenticate) await conn.authenticate(options.authenticate);
    try {
      await Promise.race([conn.newSession({ cwd, mcpServers: [] }), timeout]);
      result.session = true;
    } catch (error) {
      result.session = false;
      result.authRequired = isAuthRequired(error);
      if (!result.authRequired) result.error = errorMessage(error);
    }
    return result;
  } catch (error) {
    result.error = errorMessage(error);
    return result;
  } finally {
    clearTimeout(timer);
    conn.close();
    if (
      (await Promise.race([
        conn.exited,
        Bun.sleep(2_000).then(() => "timeout"),
      ])) === "timeout"
    )
      conn.signal("SIGKILL");
    rmSync(cwd, { recursive: true, force: true });
  }
}
