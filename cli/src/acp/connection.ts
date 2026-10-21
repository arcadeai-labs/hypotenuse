/**
 * The one module that imports `@agentclientprotocol/sdk`. Everything else in
 * the agent host talks to a coding agent through {@link AcpConnection}, so a
 * change of SDK major version touches this file only.
 *
 * An `AcpConnection` spawns the agent in its own process group with stdin and
 * stdout as the ACP stream and stderr handed to the caller line by line. It
 * filters stdout before the SDK sees it: a line that is not JSON (an agent
 * printing logs to stdout) is dropped and reported, so the host can fail the
 * turn after three in a row instead of the SDK answering each with a parse
 * error the agent never reads.
 */
import * as acp from "@agentclientprotocol/sdk";

export type {
  AgentCapabilities,
  AuthMethod,
  ContentBlock,
  CreateElicitationRequest,
  CreateElicitationResponse,
  InitializeResponse,
  McpServer,
  NewSessionResponse,
  PermissionOption,
  PlanEntry,
  ReadTextFileRequest,
  ReadTextFileResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionConfigOption,
  SessionNotification,
  SessionUpdate,
  StopReason,
  ToolCall,
  ToolCallContent,
  ToolCallUpdate,
  ToolKind,
  WriteTextFileRequest,
} from "@agentclientprotocol/sdk";

/** The ACP protocol version the daemon speaks. */
export const ACP_PROTOCOL_VERSION = 1;

/** JSON-RPC's "authentication required" error code. */
export const AUTH_REQUIRED = -32000;

/** The JSON-RPC error code for a resource the client will not touch. */
export const RESOURCE_REFUSED = -32002;

/** An error to answer an agent's request with. */
export class AcpError extends acp.RequestError {}

/** What the agent can ask of the client, answered by the host. */
export interface ClientHandlers {
  /** A `session/update` notification. */
  update(notification: acp.SessionNotification): void;
  /** `session/request_permission`. */
  requestPermission(
    params: acp.RequestPermissionRequest,
    signal: AbortSignal,
  ): Promise<acp.RequestPermissionResponse>;
  /** `fs/read_text_file`. */
  readTextFile(
    params: acp.ReadTextFileRequest,
  ): Promise<acp.ReadTextFileResponse>;
  /** `fs/write_text_file`. */
  writeTextFile(params: acp.WriteTextFileRequest): Promise<void>;
  /** `elicitation/create`. */
  createElicitation(
    params: acp.CreateElicitationRequest,
    signal: AbortSignal,
  ): Promise<acp.CreateElicitationResponse>;
  /** `elicitation/complete`. */
  elicitationComplete?(elicitationId: string): void;
  /** A method this client does not implement. */
  unknown?(method: string): void;
}

/** How to start an agent. */
export interface SpawnOptions {
  /** The command line, binary first. */
  command: string[];
  /** The agent's working directory. */
  cwd: string;
  /** Its whole environment. */
  env: Record<string, string>;
  /** Each line it writes to stderr. */
  stderr(line: string): void;
  /** Each line of stdout that is not JSON. */
  noise(line: string): void;
  /** One line per JSON-RPC message: direction, method (or id), size. */
  trace?(line: string, message: unknown): void;
  /** The client's handlers. */
  handlers: ClientHandlers;
}

/** The capabilities the daemon advertises in `initialize`. */
export function clientCapabilities(): acp.ClientCapabilities {
  return {
    fs: { readTextFile: true, writeTextFile: true },
    terminal: false,
    auth: { terminal: true },
    elicitation: { form: {}, url: {} },
    session: { configOptions: { boolean: {} } },
  };
}

/**
 * Whether an error from the agent is ACP's `auth_required`.
 * @param error - What a request rejected with.
 * @returns True for code -32000.
 */
export function isAuthRequired(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === AUTH_REQUIRED
  );
}

/**
 * The message of an error from the agent, or from anything else.
 * @param error - The error.
 * @returns One line.
 */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error)
    return String((error as { message: unknown }).message);
  return String(error);
}

/**
 * Split a byte stream into lines, calling back for each.
 * @param stream - The stream.
 * @param onLine - Called with each line, without its newline.
 */
async function eachLine(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for await (const chunk of stream) {
      buffer += decoder.decode(chunk, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        onLine(buffer.slice(0, newline).replace(/\r$/, ""));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
    }
  } catch {
    // The process went away; what was read is all there is.
  }
  if (buffer) onLine(buffer);
}

/** A running agent and the ACP connection to it. */
export class AcpConnection {
  /** Resolves when the process exits, with its code (null on a signal). */
  readonly exited: Promise<number | null>;
  private readonly connection: acp.ClientConnection;
  private exitCode: number | null | undefined;

  /**
   * @param proc - The agent process.
   * @param options - How it was started.
   */
  private constructor(
    private readonly proc: Bun.Subprocess<"pipe", "pipe", "pipe">,
    options: SpawnOptions,
  ) {
    this.exited = proc.exited.then((code) => {
      this.exitCode = code;
      return proc.signalCode ? null : code;
    });
    void eachLine(proc.stderr, options.stderr);

    // Only JSON reaches the SDK; anything else is noise.
    const encoder = new TextEncoder();
    let pending = "";
    const decoder = new TextDecoder();
    const filtered = proc.stdout.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          pending += decoder.decode(chunk, { stream: true });
          let newline = pending.indexOf("\n");
          while (newline !== -1) {
            const line = pending.slice(0, newline);
            pending = pending.slice(newline + 1);
            newline = pending.indexOf("\n");
            const trimmed = line.trim();
            if (!trimmed) continue;
            if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
              try {
                JSON.parse(trimmed);
                controller.enqueue(encoder.encode(`${trimmed}\n`));
                continue;
              } catch {
                // fall through
              }
            }
            options.noise(trimmed);
          }
        },
      }),
    );
    const sink = proc.stdin;
    const output = new WritableStream<Uint8Array>({
      write(chunk) {
        sink.write(chunk);
        sink.flush();
      },
      close() {
        sink.end();
      },
      abort() {
        sink.end();
      },
    });
    const stream = acp.ndJsonStream(output, filtered);
    const traced = options.trace ? traceStream(stream, options.trace) : stream;

    const h = options.handlers;
    this.connection = acp
      .client({ name: "hypotenuse" })
      .onNotification(acp.methods.client.session.update, ({ params }) =>
        h.update(params),
      )
      .onNotification(acp.methods.client.elicitation.complete, ({ params }) =>
        h.elicitationComplete?.(params.elicitationId),
      )
      .onRequest(
        acp.methods.client.session.requestPermission,
        ({ params, signal }) => h.requestPermission(params, signal),
      )
      .onRequest(acp.methods.client.fs.readTextFile, ({ params }) =>
        h.readTextFile(params),
      )
      .onRequest(acp.methods.client.fs.writeTextFile, async ({ params }) => {
        await h.writeTextFile(params);
        return {};
      })
      .onRequest(acp.methods.client.elicitation.create, ({ params, signal }) =>
        h.createElicitation(params, signal),
      )
      .onRequest("*", ({ method }) => {
        h.unknown?.(method);
        throw acp.RequestError.methodNotFound(method);
      })
      .onNotification("*", ({ method }) => {
        h.unknown?.(method);
      })
      .connect(traced);
  }

  /**
   * Start an agent.
   * @param options - Its command, directory, environment, and handlers.
   * @returns The connection.
   * @throws When the binary cannot be started.
   */
  static spawn(options: SpawnOptions): AcpConnection {
    const proc = Bun.spawn(options.command, {
      cwd: options.cwd,
      env: options.env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    });
    return new AcpConnection(proc, options);
  }

  /** The agent's process id. */
  get pid(): number {
    return this.proc.pid;
  }

  /** Whether the process has exited. */
  get hasExited(): boolean {
    return this.exitCode !== undefined || this.proc.exitCode !== null;
  }

  /** Fires when the ACP connection closes. */
  get closedSignal(): AbortSignal {
    return this.connection.signal;
  }

  /**
   * `initialize`.
   * @param version - The daemon's version.
   * @returns The agent's answer.
   */
  initialize(version: string): Promise<acp.InitializeResponse> {
    return this.connection.agent.request(acp.methods.agent.initialize, {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: clientCapabilities(),
      clientInfo: { name: "hypotenuse", title: "Hypotenuse", version },
    });
  }

  /**
   * `authenticate`.
   * @param methodId - The advertised method to use.
   */
  async authenticate(methodId: string): Promise<void> {
    await this.connection.agent.request(acp.methods.agent.authenticate, {
      methodId,
    });
  }

  /**
   * `session/new`.
   * @param request - Working directory, MCP servers, extra directories.
   * @returns The new session.
   */
  newSession(request: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
    return this.connection.agent.request(
      acp.methods.agent.session.new,
      request,
    );
  }

  /**
   * `session/load`: the agent replays history as updates before answering.
   * @param request - The session and its directory.
   * @returns The agent's answer.
   */
  async loadSession(
    request: acp.LoadSessionRequest,
  ): Promise<acp.LoadSessionResponse> {
    return (
      (await this.connection.agent.request(
        acp.methods.agent.session.load,
        request,
      )) ?? {}
    );
  }

  /**
   * `session/resume`: no replay.
   * @param request - The session and its directory.
   * @returns The agent's answer.
   */
  resumeSession(
    request: acp.ResumeSessionRequest,
  ): Promise<acp.ResumeSessionResponse> {
    return this.connection.agent.request(
      acp.methods.agent.session.resume,
      request,
    );
  }

  /**
   * `session/set_config_option`.
   * @param sessionId - The session.
   * @param configId - The option.
   * @param value - Its new value.
   */
  async setConfigOption(
    sessionId: string,
    configId: string,
    value: string,
  ): Promise<void> {
    await this.connection.agent.request(
      acp.methods.agent.session.setConfigOption,
      { sessionId, configId, value },
    );
  }

  /**
   * `session/set_mode`.
   * @param sessionId - The session.
   * @param modeId - The mode.
   */
  async setMode(sessionId: string, modeId: string): Promise<void> {
    await this.connection.agent.request(acp.methods.agent.session.setMode, {
      sessionId,
      modeId,
    });
  }

  /**
   * `session/prompt`: resolves when the turn ends.
   * @param sessionId - The session.
   * @param prompt - The content blocks.
   * @returns Why the turn ended.
   */
  prompt(
    sessionId: string,
    prompt: acp.ContentBlock[],
  ): Promise<acp.PromptResponse> {
    return this.connection.agent.request(acp.methods.agent.session.prompt, {
      sessionId,
      prompt,
    });
  }

  /**
   * `session/cancel`, a notification.
   * @param sessionId - The session.
   */
  async cancel(sessionId: string): Promise<void> {
    await this.connection.agent
      .notify(acp.methods.agent.session.cancel, { sessionId })
      .catch(() => {});
  }

  /**
   * Signal the agent's whole process group.
   * @param signal - The signal.
   */
  signal(signal: NodeJS.Signals): void {
    if (this.hasExited) return;
    try {
      process.kill(-this.proc.pid, signal);
    } catch {
      try {
        this.proc.kill(signal);
      } catch {
        // already gone
      }
    }
  }

  /** Close the connection and the agent's stdin. */
  close(): void {
    this.connection.close();
    try {
      this.proc.stdin.end();
    } catch {
      // already closed
    }
  }
}

/**
 * Wrap a stream so each message is traced in both directions.
 * @param stream - The SDK stream.
 * @param trace - Called with a one-line summary and the message.
 * @returns The traced stream.
 */
function traceStream(
  stream: acp.Stream,
  trace: (line: string, message: unknown) => void,
): acp.Stream {
  const describe = (direction: string, message: acp.AnyMessage) => {
    const m = message as { id?: unknown; method?: string; error?: unknown };
    const what = m.method ?? (m.error ? `error #${m.id}` : `result #${m.id}`);
    const size = JSON.stringify(message).length;
    trace(`${direction} ${what} ${size}B`, message);
  };
  const readable = stream.readable.pipeThrough(
    new TransformStream<acp.AnyMessage, acp.AnyMessage>({
      transform(message, controller) {
        describe("<-", message);
        controller.enqueue(message);
      },
    }),
  );
  const writer = stream.writable.getWriter();
  const writable = new WritableStream<acp.AnyMessage>({
    async write(message) {
      describe("->", message);
      await writer.write(message);
    },
    async close() {
      await writer.close();
    },
    async abort(reason) {
      await writer.abort(reason);
    },
  });
  return { readable, writable };
}
