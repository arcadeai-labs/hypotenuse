/**
 * The daemon's half of the Hypotenuse MCP server: the per-turn nonces, and
 * the `mcp.hello` / `mcp.call` control-socket methods `hypotenuse mcp` uses.
 *
 * The MCP process is a child of the coding agent, so it holds nothing worth
 * stealing: a session id and a 128-bit nonce, both in its argv. The runner
 * token stays here; every call is checked against the nonce (known, for this
 * session, turn not over) and the role's tools, then made as the matching
 * `daemon:*` action with the runner token.
 *
 * **What the nonce buys, and what it does not.** The socket is `0600`, so any
 * process of this user — the agent included, which can read its MCP
 * server's argv — can call it; the nonce is not a secret from the agent. It
 * stops a process left from an earlier turn acting after the turn ended, one
 * session's agent acting as another session on this runner, and anything
 * off this machine. What limits a compromised agent is the server's scope
 * check, which would hold even if the agent called the daemon directly.
 */
import { randomBytes } from "node:crypto";
import type { RunnerRole } from "../../../protocol/src/index";
import { ApiError } from "../api/client";
import { ReadCache } from "../mcp/cache";
import { CACHED_TOOLS, checkCall, toolNamesFor } from "../mcp/tools";
import { INVALID_PARAMS, RpcError } from "./control-socket";

/** The JSON-RPC code of a refused nonce. */
export const NONCE_REFUSED = -32001;

/** What `mcp.hello` answers. */
export interface HelloAnswer {
  role: RunnerRole;
  tools: string[];
  issueIdentifier: string | null;
}

/** What `mcp.call` answers: the tool result, or a tool error. */
export interface CallAnswer {
  text: string;
  data?: Record<string, unknown>;
  isError?: boolean;
}

/** A turn the broker serves, and how it reaches back into the turn. */
export interface BrokerTurn {
  agentSessionId: number;
  workItemId: number;
  role: RunnerRole;
  issueIdentifier: string | null;
  /**
   * The agent is asking the person (true), or the ask failed (false). Called
   * before the question is posted, so the turn stops writing activities that
   * would land after it.
   */
  askingUser(asking: boolean): void;
  /** Wait until every event the turn emitted has reached the server. */
  settle(): Promise<void>;
  /** A pull request was linked through `linear_report_pr`. */
  reportedPullRequest(url: string): void;
}

/** How the broker reaches the server. */
export interface ToolTransport {
  tool(
    route: string,
    body: Record<string, unknown>,
  ): Promise<{ text: string; data: Record<string, unknown> }>;
}

/** The registry of live turns' nonces. */
export class McpBroker {
  private readonly turns = new Map<string, BrokerTurn>();
  private readonly cache: ReadCache<CallAnswer>;

  /**
   * @param transport - The server.
   * @param log - Where a refusal or failure is noted.
   * @param cache - The per-turn read cache (tests pass a clock).
   */
  constructor(
    private readonly transport: ToolTransport,
    private readonly log: (line: string) => void = () => {},
    cache?: ReadCache<CallAnswer>,
  ) {
    this.cache = cache ?? new ReadCache();
  }

  /**
   * Start serving a turn.
   * @param turn - The turn.
   * @returns Its nonce: 128 random bits, hex.
   */
  register(turn: BrokerTurn): string {
    const nonce = randomBytes(16).toString("hex");
    this.turns.set(nonce, turn);
    return nonce;
  }

  /**
   * Stop serving a turn: its nonce is refused from now on, and its cached
   * reads are dropped.
   * @param nonce - The turn's nonce.
   */
  end(nonce: string): void {
    const turn = this.turns.get(nonce);
    this.turns.delete(nonce);
    if (turn) this.cache.invalidate(turn.workItemId);
  }

  /**
   * The turn a nonce names, checked against the session it claims.
   * @param params - `{ agentSessionId, nonce }`.
   * @returns The turn.
   * @throws {RpcError} {@link NONCE_REFUSED} for an unknown nonce, another
   *   session's, or a turn that has ended.
   */
  private turnFor(params: Record<string, unknown>): BrokerTurn {
    const { agentSessionId, nonce } = params;
    if (typeof nonce !== "string" || typeof agentSessionId !== "number") {
      throw new RpcError(
        INVALID_PARAMS,
        "agentSessionId and nonce are required",
      );
    }
    const turn = this.turns.get(nonce);
    if (!turn || turn.agentSessionId !== agentSessionId) {
      this.log(
        `refused an MCP call for session ${agentSessionId}: no live turn has that nonce`,
      );
      throw new RpcError(
        NONCE_REFUSED,
        "this MCP server's turn has ended, or it was started for another session",
      );
    }
    return turn;
  }

  /**
   * `mcp.hello`: who the MCP process serves.
   * @param params - `{ agentSessionId, nonce }`.
   * @returns The role, its tools, and the issue.
   */
  hello(params: Record<string, unknown>): HelloAnswer {
    const turn = this.turnFor(params);
    return {
      role: turn.role,
      tools: toolNamesFor(turn.role),
      issueIdentifier: turn.issueIdentifier,
    };
  }

  /**
   * `mcp.call`: one tool call, made as its `daemon:*` action.
   *
   * - The tool must be the role's and its input valid (else a tool error).
   * - A cached read within 60 s is answered from the cache; any write
   *   empties the turn's cache.
   * - A write to the session's own activity — the plan, a question, a pull
   *   request link — waits for the turn's queued events to land first, so
   *   it takes its place after them. Before a question, the turn is told it
   *   is asking, so nothing it writes afterwards lands after the question.
   * @param params - `{ agentSessionId, nonce, tool, input }`.
   * @returns The tool's result, or a tool error.
   */
  async call(params: Record<string, unknown>): Promise<CallAnswer> {
    const turn = this.turnFor(params);
    const name = typeof params.tool === "string" ? params.tool : "";
    const checked = checkCall(turn.role, name, params.input);
    if (!checked.ok) return { text: checked.message, isError: true };
    const { tool, input } = checked;

    const cached = CACHED_TOOLS.has(tool.name);
    if (cached) {
      const hit = this.cache.get(turn.workItemId, tool.name, input);
      if (hit) return hit;
    }
    if (tool.kind === "write") this.cache.invalidate(turn.workItemId);

    const asking = tool.name === "linear_ask_user";
    const ownActivity =
      asking ||
      tool.name === "linear_set_plan" ||
      tool.name === "linear_report_pr";
    if (asking) turn.askingUser(true);
    if (ownActivity) await turn.settle();

    let answer: CallAnswer;
    try {
      const result = await this.transport.tool(tool.route, {
        ...input,
        agentSessionId: turn.agentSessionId,
      });
      answer = { text: result.text, data: result.data };
    } catch (error) {
      if (asking) turn.askingUser(false);
      answer = { text: toolErrorText(error), isError: true };
      this.log(`${tool.name} failed: ${answer.text}`);
      return answer;
    }
    if (cached) this.cache.set(turn.workItemId, tool.name, input, answer);
    if (tool.name === "linear_report_pr" && answer.data?.linked)
      turn.reportedPullRequest(String(input.url));
    return answer;
  }
}

/**
 * What the agent reads when a tool's action failed.
 * @param error - What the server call threw.
 * @returns One sentence.
 */
export function toolErrorText(error: unknown): string {
  if (error instanceof ApiError) {
    if (
      error.status === 403 &&
      error.message === "not permitted for this session"
    )
      return "Not permitted: this tool cannot act for this session now (its turn may have ended).";
    if (error.status === 0)
      return "Hypotenuse could not reach its server; try again shortly.";
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}
