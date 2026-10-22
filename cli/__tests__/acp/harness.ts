import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkAssignment } from "../../../protocol/src/index";
import { AcpSessionExecutor, type HostOptions } from "../../src/acp/host";
import { parseConfigText } from "../../src/config/loader";
import type { Config } from "../../src/config/schema";
import type { EventInput } from "../../src/daemon/event-sink";
import type {
  StopReason,
  TurnContext,
  TurnReply,
  TurnResult,
} from "../../src/daemon/executor";
import { DaemonLog } from "../../src/daemon/log";

/**
 * The real agent host against the fake ACP agent, with a capturing sink in
 * place of the daemon: every event a turn emits, the replies it is handed,
 * and what the fake agent recorded.
 */

/** The fake agent's entry point. */
export const FAKE_AGENT = join(
  import.meta.dir,
  "..",
  "fixtures",
  "fake-acp-agent.ts",
);

/**
 * A config with the fake agent as the worker's agent.
 * @param root - The temporary home.
 * @param extra - More TOML (roles, sessions).
 * @param worker - The `[roles.worker]` table's extra lines.
 * @returns The config.
 */
export function fakeConfig(root: string, extra = "", worker = ""): Config {
  const text = [
    "config_version = 1",
    "[runner]",
    'name = "test-runner"',
    "[agents.fake]",
    `command = ["bun", "${FAKE_AGENT}"]`,
    "[roles.worker]",
    'agent = "fake"',
    worker,
    extra,
  ].join("\n");
  const result = parseConfigText(text, join(root, "config.toml"), {
    baseDir: root,
    env: { HOME: root },
    cpuCount: 4,
    hostname: "test",
  });
  if (!result.config) throw new Error(JSON.stringify(result.issues));
  return result.config;
}

/**
 * A work assignment.
 * @param overrides - Fields to change.
 * @returns The assignment.
 */
export function assignment(
  overrides: Partial<WorkAssignment> = {},
): WorkAssignment {
  return {
    workItemId: 1,
    agentSessionId: 42,
    type: "linear",
    externalSessionId: "ext-42",
    externalSessionUrl:
      "https://linear.app/acme/issue/ENG-1#agent-session-ext-42",
    dashboardUrl: "https://hypotenuse.test/sessions/42",
    kind: "session_created",
    role: "worker",
    agentId: "fake",
    fresh: true,
    repository: null,
    branch: null,
    issue: {
      id: "issue-1",
      identifier: "ENG-1",
      title: "Fix checkout rounding",
      description: "Totals are off by a cent.",
      url: "https://linear.app/acme/issue/ENG-1/fix-checkout-rounding",
      teamKey: "ENG",
      labels: [],
      state: null,
      parent: null,
      project: null,
    },
    instruction: null,
    promptContext: '<issue identifier="ENG-1">Fix checkout rounding</issue>',
    guidance: [],
    previousComments: null,
    history: [],
    prompt: null,
    origin: "delegation",
    humanDelegated: true,
    leaseExpiresAt: Date.now() + 60_000,
    ...overrides,
  };
}

/** The disclosure block a final response ends with (`responseSignature`). */
export const SIGNATURE = /\n\n\+\+\+ — Hypotenuse \([^)]*\)\n[^\n]*\n\+\+\+$/;

/**
 * A response's body without its disclosure block, so a test can compare what
 * the agent said; `host.test.ts` asserts the block itself.
 * @param body - The body.
 * @returns It, unsigned.
 */
export function unsigned(body: string): string {
  return body.replace(SIGNATURE, "");
}

/** One turn under test. */
export class TestTurn {
  readonly events: EventInput[] = [];
  readonly controller = new AbortController();
  reason: StopReason | null = null;
  replyHandler: ((reply: TurnReply) => boolean | null) | null = null;
  askingHandler: ((asking: boolean) => void) | null = null;
  pids: (number | null)[] = [];
  availability: { available: boolean; error?: string }[] = [];
  result: Promise<TurnResult>;
  readonly record: string;

  /**
   * @param config - The config.
   * @param scenario - The fake agent's scenario.
   * @param options - The assignment, state dir, previous ACP session, env, host options.
   */
  constructor(
    readonly config: Config,
    scenario: string,
    options: {
      assignment?: WorkAssignment;
      stateDir?: string;
      previousAcpSessionId?: string | null;
      env?: Record<string, string>;
      host?: HostOptions;
    } = {},
  ) {
    const stateDir =
      options.stateDir ?? mkdtempSync(join(tmpdir(), "hyp-acp-"));
    this.record = join(stateDir, "record.jsonl");
    const ctx: TurnContext = {
      assignment: options.assignment ?? assignment(),
      config,
      runnerName: "test-runner",
      signal: this.controller.signal,
      stopReason: () => this.reason,
      emit: (event) => this.events.push(event),
      log: new DaemonLog(join(stateDir, "daemon.log"), "debug", false),
      stateDir,
      env: {
        ...process.env,
        FAKE_ACP_SCENARIO: scenario,
        FAKE_ACP_RECORD: this.record,
        ...options.env,
      },
      previousAcpSessionId: options.previousAcpSessionId ?? null,
      onReply: (handler) => {
        this.replyHandler = handler;
      },
      onAskingUser: (handler) => {
        this.askingHandler = handler;
      },
      setPid: (pid) => this.pids.push(pid),
      agentAvailability: (available, error) =>
        this.availability.push({ available, ...(error ? { error } : {}) }),
      setState: () => {},
    };
    this.result = new AcpSessionExecutor({
      tickMs: 50,
      killGraceMs: 500,
      ...options.host,
    }).run(ctx);
  }

  /**
   * Stop the turn as the supervisor would.
   * @param reason - Why.
   */
  stop(reason: StopReason): void {
    this.reason = reason;
    this.controller.abort(reason);
  }

  /**
   * Wait for an event matching a predicate.
   * @param match - The predicate.
   * @param timeoutMs - How long.
   * @returns The event.
   */
  async waitFor(
    match: (e: EventInput) => boolean,
    timeoutMs = 10_000,
  ): Promise<EventInput> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.events.find(match);
      if (found) return found;
      if (Date.now() > deadline)
        throw new Error(
          `timed out; events: ${JSON.stringify(this.events, null, 2)}`,
        );
      await Bun.sleep(20);
    }
  }

  /** What the fake agent received, in order. */
  received(): {
    method: string;
    params: Record<string, unknown>;
    pid: number;
  }[] {
    try {
      return readFileSync(this.record, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  }

  /** The events without status events, for exact comparisons. */
  visible(): EventInput[] {
    return this.events
      .filter((e) => e.type !== "status")
      .map((e) =>
        e.type === "response" ? { ...e, body: unsigned(e.body) } : e,
      );
  }
}
