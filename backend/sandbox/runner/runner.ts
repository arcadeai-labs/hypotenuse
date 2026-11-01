/**
 * **The supervisor**: the one process Hypotenuse starts inside a sandbox. It
 * runs the coding CLI, turns its JSONL into events, and pushes everything to
 * the server over plain HTTPS — the server never holds a stream open to a
 * sandbox, so a deploy or a worker restart loses nothing:
 *
 * | Endpoint | When |
 * |---|---|
 * | `PUT /api/sandbox/events` | batched transcript (about 200 events, 2 s, or 256 KB) |
 * | `POST /api/sandbox/heartbeat` | every `HYPOTENUSE_HEARTBEAT_MS`, faster during an interactive turn; the answer is the only server → sandbox control: cancel, follow-up, steer |
 * | `POST /api/sandbox/complete` | the CLI exited: exit code, closing text, usage. An interactive job parks and waits for a follow-up; anything else ends |
 *
 * The job token travels in the body (`token`), because a Keryx action reads
 * params, not headers. Exit 143 after a cancel is `cancelled`, never
 * `failed`.
 *
 * **Imports nothing from the backend** — it runs inside the sandbox, beside
 * `parser.ts`, `batcher.ts`, and `usage.ts`, with only Bun.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { EventBatcher } from "./batcher";
import { parseLine, type RunnerEvent, splitLines } from "./parser";
import { accumulateRunUsage } from "./usage";

/** The exit code of a process stopped by SIGTERM. */
export const SIGTERM_EXIT_CODE = 143;

/** Where the prompt goes in `HYPOTENUSE_COMMAND`. */
export const PROMPT_PLACEHOLDER = "__HYPOTENUSE_PROMPT__";

/** Where the CLI's session id goes in `HYPOTENUSE_RESUME_COMMAND`. */
export const SESSION_PLACEHOLDER = "__HYPOTENUSE_SESSION_ID__";

/** Where a follow-up goes in `HYPOTENUSE_RESUME_COMMAND`. */
export const FOLLOW_UP_PLACEHOLDER = "__HYPOTENUSE_FOLLOW_UP__";

/** The heartbeat interval while an interactive job's turn runs. */
export const INTERACTIVE_TURN_HEARTBEAT_MS = 10_000;

/** What the supervisor reads from its environment. */
export interface SupervisorConfig {
  apiUrl: string;
  token: string;
  command: string[];
  resumeCommand: string[] | null;
  interactive: boolean;
  promptFile: string;
  cwd: string;
  heartbeatMs: number;
  logFile: string;
}

/**
 * Read the configuration the server wrote into the environment.
 * @param env - The environment.
 * @returns The configuration.
 * @throws {Error} When a required variable is missing.
 */
export function readConfig(
  env: Record<string, string | undefined> = process.env,
): SupervisorConfig {
  const required = (name: string) => {
    const value = env[name];
    if (!value) throw new Error(`${name} is not set`);
    return value;
  };
  const argv = (raw: string | undefined) =>
    raw ? (JSON.parse(raw) as string[]) : null;
  const cwd = env.HYPOTENUSE_CWD || "/work";
  return {
    apiUrl: required("HYPOTENUSE_API_URL").replace(/\/+$/, ""),
    token: required("HYPOTENUSE_JOB_TOKEN"),
    command: argv(required("HYPOTENUSE_COMMAND")) ?? [],
    resumeCommand: argv(env.HYPOTENUSE_RESUME_COMMAND),
    interactive: env.HYPOTENUSE_INTERACTIVE === "true",
    promptFile: env.HYPOTENUSE_PROMPT_FILE || `${cwd}/.hypotenuse/prompt.md`,
    cwd,
    heartbeatMs: Number(env.HYPOTENUSE_HEARTBEAT_MS) || 30_000,
    logFile: env.HYPOTENUSE_LOG_FILE || `${cwd}/.hypotenuse/supervisor.log`,
  };
}

/**
 * Fill a command's placeholders.
 * @param argv - The command with placeholders.
 * @param values - Placeholder → value.
 * @returns The argv to run.
 */
export function fillCommand(
  argv: string[],
  values: Record<string, string>,
): string[] {
  return argv.map((arg) => {
    let out = arg;
    for (const [key, value] of Object.entries(values)) {
      out = out.split(key).join(value);
    }
    return out;
  });
}

/** The server's answer to a heartbeat. */
export interface HeartbeatAnswer {
  cancelRequested: boolean;
  followUp?: { id: number; body: string } | null;
  steer?: { id: number; body: string } | null;
}

/** The server's answer to `sandbox:complete`. */
interface CompleteAnswer {
  status: string;
  alreadyFinal?: boolean;
}

/** An endpoint answered with a status that retrying will not change. */
export class EndpointRefused extends Error {
  /**
   * @param status - The HTTP status.
   * @param body - What it said.
   */
  constructor(
    public status: number,
    body: string,
  ) {
    super(`HTTP ${status}: ${body.slice(0, 300)}`);
  }
}

/** One turn's outcome, as the supervisor saw it. */
interface TurnResult {
  exitCode: number;
  closingText: string | null;
  error: string | null;
  sessionId: string | null;
  usage: Record<string, unknown> | null;
}

/**
 * The supervisor itself.
 */
export class Supervisor {
  private seq = 0;
  private sessionId: string | null = null;
  private usage: Record<string, unknown> | null = null;
  private cancelRequested = false;
  private child: Bun.Subprocess<"ignore", "pipe", "pipe"> | null = null;
  private pendingSteer: string | null = null;
  private readonly batcher: EventBatcher;

  /**
   * @param config - What the environment said.
   * @param fetcher - `fetch`, injectable for tests.
   */
  constructor(
    private readonly config: SupervisorConfig,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.batcher = new EventBatcher({
      flush: async (events) => {
        await this.call("PUT", "/sandbox/events", { events });
      },
      onDropped: (events, error) =>
        this.log("events_dropped", {
          count: events.length,
          error: String(error),
        }),
    });
  }

  /**
   * Append a line to the supervisor's own log inside the sandbox.
   * @param event - What happened.
   * @param data - Details.
   */
  private log(event: string, data: Record<string, unknown> = {}): void {
    try {
      appendFileSync(
        this.config.logFile,
        `${JSON.stringify({ at: new Date().toISOString(), event, ...data })}\n`,
      );
    } catch {
      // The log is for a person debugging a sandbox; it never fails the job.
    }
  }

  /**
   * Call one of the server's sandbox endpoints, with the token in the body.
   * Retries network failures and 5xx with backoff; a 4xx is final.
   * @param method - `PUT` or `POST`.
   * @param path - The path under `/api`.
   * @param body - The body, without the token.
   * @param attempts - How many tries.
   * @returns The parsed answer.
   * @throws {EndpointRefused} On a 4xx, or after the last attempt.
   */
  async call<T = unknown>(
    method: string,
    path: string,
    body: Record<string, unknown>,
    attempts = 5,
  ): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const res = await this.fetcher(`${this.config.apiUrl}/api${path}`, {
          method,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...body, token: this.config.token }),
        });
        const text = await res.text();
        if (res.ok) return (text ? JSON.parse(text) : {}) as T;
        if (res.status < 500) throw new EndpointRefused(res.status, text);
        lastError = new EndpointRefused(res.status, text);
      } catch (e) {
        if (e instanceof EndpointRefused && e.status < 500) throw e;
        lastError = e;
      }
      await Bun.sleep(Math.min(250 * 2 ** attempt, 5_000));
    }
    throw lastError;
  }

  /**
   * Queue an event with its sequence number and time, stamped once.
   * @param event - The parsed event.
   */
  private async emit(event: RunnerEvent): Promise<void> {
    this.seq += 1;
    await this.batcher.add({ ...event, seq: this.seq, occurredAt: Date.now() });
  }

  /**
   * Send one heartbeat and act on its answer.
   * @param phase - What the supervisor is doing.
   * @returns The answer, or `null` when it could not be sent.
   */
  async heartbeat(phase: "turn" | "idle"): Promise<HeartbeatAnswer | null> {
    try {
      const answer = await this.call<HeartbeatAnswer>(
        "POST",
        "/sandbox/heartbeat",
        { phase },
        2,
      );
      if (answer.cancelRequested && !this.cancelRequested) {
        this.cancelRequested = true;
        this.log("cancel_requested");
        this.child?.kill("SIGTERM");
      }
      if (answer.steer && phase === "turn") {
        // Kept even with no CLI running (between spawns): the server has
        // already marked it delivered, so the next turn starts with it.
        this.pendingSteer = answer.steer.body;
        this.log("steer", { id: answer.steer.id });
        this.child?.kill("SIGTERM");
      }
      return answer;
    } catch (e) {
      this.log("heartbeat_failed", { error: String(e) });
      if (e instanceof EndpointRefused && e.status === 401) {
        // The job ended on the server: stop working for it.
        this.cancelRequested = true;
        this.child?.kill("SIGTERM");
      }
      return null;
    }
  }

  /**
   * Run one CLI process to exit, streaming its events.
   * @param argv - The command.
   * @returns What the turn produced.
   */
  async runTurn(argv: string[]): Promise<TurnResult> {
    this.log("spawn", { argv: argv.map((a) => a.slice(0, 120)) });
    const child = Bun.spawn(argv, {
      cwd: this.config.cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    });
    this.child = child;
    const interval = this.config.interactive
      ? Math.min(INTERACTIVE_TURN_HEARTBEAT_MS, this.config.heartbeatMs)
      : this.config.heartbeatMs;
    const beat = setInterval(() => void this.heartbeat("turn"), interval);
    const flusher = setInterval(() => void this.batcher.maybeFlush(), 500);
    let closingText: string | null = null;
    let resultError: string | null = null;
    let failedMcp: string | null = null;
    const stderrText = new Response(child.stderr).text();
    try {
      const decoder = new TextDecoder();
      let rest = "";
      const handle = async (line: string) => {
        const parsed = parseLine("claude_code", line);
        if (parsed.sessionId) this.sessionId = parsed.sessionId;
        if (parsed.failedMcpServers?.length) {
          failedMcp = parsed.failedMcpServers
            .map((s) => `${s.name} (${s.status})`)
            .join(", ");
        }
        if (parsed.usage)
          this.usage = accumulateRunUsage(this.usage, parsed.usage);
        if (parsed.finalText !== undefined) {
          closingText = parsed.finalText ?? null;
          resultError = parsed.events.some((e) => e.type === "error")
            ? (parsed.finalText ?? "the coding agent reported an error")
            : null;
        }
        for (const event of parsed.events) await this.emit(event);
      };
      for await (const chunk of child.stdout) {
        const split = splitLines(rest, decoder.decode(chunk, { stream: true }));
        rest = split.rest;
        for (const line of split.lines) await handle(line);
      }
      if (rest.trim()) await handle(rest);
    } finally {
      clearInterval(beat);
      clearInterval(flusher);
    }
    const exitCode = await child.exited;
    this.child = null;
    const stderr = (await stderrText).trim();
    if (stderr) {
      await this.emit({
        type: "daemon",
        text: stderr.slice(-4_000),
        payload: { stream: "stderr" },
      });
    }
    await this.batcher.flush();
    let error: string | null = null;
    if (failedMcp) {
      error = `MCP servers failed to start: ${failedMcp}`;
    } else if (exitCode !== 0 && exitCode !== SIGTERM_EXIT_CODE) {
      error =
        resultError ??
        `The coding agent exited with code ${exitCode}${stderr ? `: ${stderr.slice(-500)}` : ""}`;
    } else if (resultError) {
      error = resultError;
    }
    this.log("exit", { exitCode });
    return {
      exitCode: failedMcp && exitCode === 0 ? 1 : exitCode,
      closingText,
      error,
      sessionId: this.sessionId,
      usage: this.usage,
    };
  }

  /**
   * Report a turn's end.
   * @param turn - The turn.
   * @returns The server's answer.
   */
  private async complete(turn: TurnResult): Promise<CompleteAnswer> {
    const cancelled =
      this.cancelRequested ||
      (turn.exitCode === SIGTERM_EXIT_CODE && this.pendingSteer === null);
    return this.call<CompleteAnswer>("POST", "/sandbox/complete", {
      exitCode: turn.exitCode,
      outcome: cancelled
        ? "cancelled"
        : turn.error || turn.exitCode !== 0
          ? "failed"
          : "succeeded",
      closingText: turn.closingText,
      error: turn.error,
      cliSessionId: turn.sessionId,
      usage: turn.usage,
    });
  }

  /**
   * Wait for an interactive job's next instruction.
   * @returns The follow-up's text, or `null` when the job ended.
   */
  private async awaitFollowUp(): Promise<string | null> {
    for (;;) {
      if (this.cancelRequested) return null;
      // A steer that landed as the last turn ended is the next instruction.
      if (this.pendingSteer !== null) {
        const steer = this.pendingSteer;
        this.pendingSteer = null;
        return steer;
      }
      const answer = await this.heartbeat("idle");
      if (answer?.followUp) return answer.followUp.body;
      if (answer?.steer) return answer.steer.body;
      if (this.cancelRequested) return null;
      await Bun.sleep(
        Math.min(INTERACTIVE_TURN_HEARTBEAT_MS, this.config.heartbeatMs),
      );
    }
  }

  /**
   * Run the job: the first turn, then — for an interactive job, or after a
   * steer — every turn after it, until the server says it has ended.
   * @returns The process exit code.
   */
  async run(): Promise<number> {
    const prompt = readFileSync(this.config.promptFile, "utf8");
    await this.heartbeat("turn");
    // A steer that arrived before the CLI started is part of its task.
    const early = this.pendingSteer;
    this.pendingSteer = null;
    let argv = fillCommand(this.config.command, {
      [PROMPT_PLACEHOLDER]: early
        ? `${prompt}\n\n## A change from the person who asked\n\n${early}`
        : prompt,
    });
    for (;;) {
      if (this.cancelRequested) {
        await this.complete({
          exitCode: SIGTERM_EXIT_CODE,
          closingText: null,
          error: null,
          sessionId: this.sessionId,
          usage: this.usage,
        });
        return 0;
      }
      const turn = await this.runTurn(argv);
      const steer = this.pendingSteer;
      this.pendingSteer = null;
      if (
        steer !== null &&
        !this.cancelRequested &&
        this.config.resumeCommand
      ) {
        argv = this.resumeWith(steer);
        continue;
      }
      let answer: CompleteAnswer;
      try {
        answer = await this.complete(turn);
      } catch (e) {
        this.log("complete_failed", { error: String(e) });
        return 1;
      }
      if (answer.status !== "awaiting_input") return 0;
      const next = await this.awaitFollowUp();
      if (next === null) {
        // Cancelled while waiting between turns: say so, so the job ends now
        // rather than when the reaper forces an unacknowledged cancel. A
        // refusal here means the job already ended on the server.
        await this.complete({
          exitCode: SIGTERM_EXIT_CODE,
          closingText: null,
          error: null,
          sessionId: this.sessionId,
          usage: this.usage,
        }).catch((e) => this.log("complete_failed", { error: String(e) }));
        return 0;
      }
      argv = this.resumeWith(next);
    }
  }

  /**
   * The resume command for a follow-up, or the first command again when the
   * CLI gave no session to resume.
   * @param text - The follow-up.
   * @returns The argv.
   */
  private resumeWith(text: string): string[] {
    if (this.config.resumeCommand && this.sessionId) {
      return fillCommand(this.config.resumeCommand, {
        [SESSION_PLACEHOLDER]: this.sessionId,
        [FOLLOW_UP_PLACEHOLDER]: text,
      });
    }
    return fillCommand(this.config.command, { [PROMPT_PLACEHOLDER]: text });
  }
}

if (import.meta.main) {
  const supervisor = new Supervisor(readConfig());
  supervisor
    .run()
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
