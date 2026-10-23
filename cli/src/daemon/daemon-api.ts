/**
 * The `daemon:*` actions as typed calls: every request carries the runner
 * token and `X-Hypotenuse-Protocol`, and every answer is parsed with the
 * shared protocol schemas, so a server that answers something else is a
 * loud error rather than a silent `undefined`.
 */
import {
  ClaimResponse,
  type CompleteRequest,
  CompleteResponse,
  ConnectResponse,
  type EventsRequest,
  EventsResponse,
  type HeartbeatRequest,
  HeartbeatResponse,
  type OtlpSignal,
  PROTOCOL_HEADER,
  PROTOCOL_VERSION,
  TELEMETRY_SIGNAL_HEADER,
  TELEMETRY_WORK_ITEM_HEADER,
  TelemetryResponse,
  ToolResult,
  TRACEPARENT_HEADER,
  type WorkAssignment,
} from "../../../protocol/src/index";
import pkg from "../../package.json";
import { ApiClient } from "../api/client";
import { platform } from "../runner/machine";

/** How long any one daemon request may take. */
export const REQUEST_TIMEOUT_MS = 20_000;

/**
 * How long an agent tool's call may take: the server waits up to 30 s for a
 * write's rate-limit token, then Linear up to twice its deadline.
 */
export const TOOL_REQUEST_TIMEOUT_MS = 75_000;

/** The runner's calls to the server. */
export class DaemonApi {
  private readonly client: ApiClient;

  /**
   * @param origin - The server origin.
   * @param token - The runner token.
   * @param debug - Called with one line per request.
   */
  constructor(
    readonly origin: string,
    token: string,
    debug: (line: string) => void = () => {},
  ) {
    this.client = new ApiClient(origin, token, debug);
  }

  /** The headers every daemon request carries. */
  private get headers(): Record<string, string> {
    return {
      [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
      "User-Agent": `hypotenuse/${pkg.version} (${platform()})`,
    };
  }

  /**
   * The headers of a call made for a turn: with its `traceparent`, so the
   * server's span for the call joins the turn's trace under the daemon's.
   * @param traceparent - The daemon span the call is made from, if traced.
   * @returns The headers.
   */
  private traced(traceparent?: string | null): Record<string, string> {
    return traceparent
      ? { ...this.headers, [TRACEPARENT_HEADER]: traceparent }
      : this.headers;
  }

  /**
   * `daemon:heartbeat`.
   * @param body - The heartbeat.
   * @returns Offers, cancels, and the server's clock.
   */
  async heartbeat(body: HeartbeatRequest): Promise<HeartbeatResponse> {
    const answer = await this.client.request("POST", "/daemon/heartbeat", {
      body,
      headers: this.headers,
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
    return HeartbeatResponse.parse(answer);
  }

  /**
   * `daemon:connect`: trade the token for the WebSocket's session cookie.
   * @param machineId - This machine.
   * @returns The answer and the `name=value` cookie to present.
   */
  async connect(
    machineId: string,
  ): Promise<{ answer: ConnectResponse; cookie: string }> {
    const { body, headers } = await this.client.exchange(
      "POST",
      "/daemon/connect",
      {
        body: { machineId },
        headers: this.headers,
        timeoutMs: REQUEST_TIMEOUT_MS,
      },
    );
    const cookie =
      (headers.get("set-cookie") ?? "").split(";")[0]?.trim() ?? "";
    if (!cookie.includes("="))
      throw new Error("daemon:connect set no session cookie");
    return { answer: ConnectResponse.parse(body), cookie };
  }

  /**
   * `daemon:claim`.
   * @param workItemIds - The offers to claim.
   * @returns The assignment, or null when nothing was claimable.
   */
  async claim(workItemIds: number[]): Promise<WorkAssignment | null> {
    const answer = await this.client.request("POST", "/daemon/claim", {
      body: { workItemIds },
      headers: this.headers,
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
    return ClaimResponse.parse(answer).assignment;
  }

  /**
   * `daemon:events`.
   * @param body - One work item's batch.
   * @param traceparent - The turn's daemon span, when traced.
   * @returns What the server took.
   */
  async events(
    body: EventsRequest,
    traceparent?: string | null,
  ): Promise<EventsResponse> {
    const answer = await this.client.request("POST", "/daemon/events", {
      body,
      headers: this.traced(traceparent),
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
    return EventsResponse.parse(answer);
  }

  /**
   * `daemon:complete`.
   * @param body - How the turn ended.
   * @param traceparent - The turn's daemon span, when traced.
   * @returns Whether it was already terminal.
   */
  async complete(
    body: CompleteRequest,
    traceparent?: string | null,
  ): Promise<CompleteResponse> {
    const answer = await this.client.request("POST", "/daemon/complete", {
      body,
      headers: this.traced(traceparent),
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
    return CompleteResponse.parse(answer);
  }

  /**
   * `daemon:telemetry`: relay one gzipped OTLP/JSON batch of a turn.
   * @param batch - The turn, its traceparent, the signal, and the gzipped body.
   * @returns Whether the server took it.
   * @throws {ApiError} 409 `NOT_YOUR_WORK` / `TELEMETRY_NOT_WANTED`, 410
   *   `TELEMETRY_LATE`, 429, or a transport failure.
   */
  async telemetry(batch: {
    workItemId: number;
    traceparent: string;
    signal: OtlpSignal;
    gzipped: Uint8Array;
  }): Promise<TelemetryResponse> {
    const answer = await this.client.request("POST", "/daemon/telemetry", {
      rawBody: batch.gzipped,
      headers: {
        ...this.headers,
        "Content-Type": "application/json",
        "Content-Encoding": "gzip",
        [TELEMETRY_SIGNAL_HEADER]: batch.signal,
        [TELEMETRY_WORK_ITEM_HEADER]: String(batch.workItemId),
        [TRACEPARENT_HEADER]: batch.traceparent,
      },
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
    return TelemetryResponse.parse(answer);
  }

  /**
   * An agent tool's `daemon:*` action.
   * @param route - The tool's route (`/daemon/linear/get-issue`).
   * @param body - The tool input and `agentSessionId`.
   * @param traceparent - The `mcp.call` span, when traced.
   * @returns The result's Markdown and data.
   */
  async tool(
    route: string,
    body: Record<string, unknown>,
    traceparent?: string | null,
  ): Promise<{ text: string; data: Record<string, unknown> }> {
    const answer = await this.client.request("POST", route, {
      body,
      headers: this.traced(traceparent),
      timeoutMs: TOOL_REQUEST_TIMEOUT_MS,
    });
    return ToolResult.parse(answer).result;
  }
}
