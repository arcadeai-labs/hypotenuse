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
  PROTOCOL_HEADER,
  PROTOCOL_VERSION,
  type WorkAssignment,
} from "../../../protocol/src/index";
import pkg from "../../package.json";
import { ApiClient } from "../api/client";
import { platform } from "../runner/machine";

/** How long any one daemon request may take. */
export const REQUEST_TIMEOUT_MS = 20_000;

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
   * @returns What the server took.
   */
  async events(body: EventsRequest): Promise<EventsResponse> {
    const answer = await this.client.request("POST", "/daemon/events", {
      body,
      headers: this.headers,
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
    return EventsResponse.parse(answer);
  }

  /**
   * `daemon:complete`.
   * @param body - How the turn ended.
   * @returns Whether it was already terminal.
   */
  async complete(body: CompleteRequest): Promise<CompleteResponse> {
    const answer = await this.client.request("POST", "/daemon/complete", {
      body,
      headers: this.headers,
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
    return CompleteResponse.parse(answer);
  }
}
