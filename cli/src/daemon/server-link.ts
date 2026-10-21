/**
 * ServerLink: the daemon's only conversation with the server about presence.
 *
 * - **Heartbeat** every `heartbeatIntervalMs` (15 s), and at once after a
 *   frame, a freed slot, a reconnect, or a reload. Its answer's offers and
 *   cancels are the work; the socket only makes them arrive sooner.
 * - **Socket**: after a heartbeat succeeds, `daemon:connect` trades the token
 *   for a session cookie, and the daemon opens the WebSocket and sends exactly
 *   one `subscribe` to `runner:<id>`. It never unsubscribes; to change
 *   anything it closes and reconnects.
 * - **Backoff**: a failed heartbeat or a dropped socket waits 1 s × 2ⁿ (cap
 *   30 s, full jitter); close code 1001 (a deploy) waits a random 1–5 s.
 * - **401 is not a network failure.** The runner was revoked or deleted; the
 *   link stops and says so instead of retrying a dead token for a week.
 */
import {
  type HeartbeatRequest,
  type HeartbeatResponse,
  MACHINE_IN_USE,
  PROTOCOL_UNSUPPORTED,
  RunnerFrame,
  runnerChannel,
} from "../../../protocol/src/index";
import { ApiError } from "../api/client";
import { Backoff } from "./backoff";
import type { DaemonApi } from "./daemon-api";
import type { DaemonLog } from "./log";

/** Skew beyond this between the server's clock and ours earns a warning. */
export const CLOCK_SKEW_WARN_MS = 30_000;

/** How often a persisting skew is warned about again. */
const SKEW_WARN_EVERY_MS = 3_600_000;

/** What the link tells the supervisor. */
export interface LinkHooks {
  /** A heartbeat was answered. */
  onBeat(answer: HeartbeatResponse): void | Promise<void>;
  /** The runner was revoked (a `revoked` frame, or a 401). */
  onRevoked(): void;
  /** Something that will not fix itself: another runner holds this machine. */
  onFatal(message: string): void;
  /** The server needs a newer protocol. */
  onProtocolUnsupported(message: string): void;
  /** The server answered again after a failure. */
  onHealthy(): void;
}

/** The link's state, for `daemon status` and `doctor`. */
export interface LinkStatus {
  url: string;
  connected: boolean;
  lastHeartbeatAt: number | null;
  socket: "open" | "connecting" | "closed";
  lastError: string | null;
  clockSkewMs: number | null;
  runnerId: number | null;
}

/** The heartbeat loop and the wake-up socket. */
export class ServerLink {
  private intervalMs = 15_000;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private beating: Promise<void> | null = null;
  private again = false;
  private stopped = false;
  private healthy = false;
  private readonly beatBackoff = new Backoff();
  private readonly socketBackoff = new Backoff();
  private socket: WebSocket | null = null;
  private socketState: LinkStatus["socket"] = "closed";
  private socketTimer: ReturnType<typeof setTimeout> | null = null;
  private lastHeartbeatAt: number | null = null;
  private lastError: string | null = null;
  private clockSkewMs: number | null = null;
  private lastSkewWarning = 0;
  private runnerId: number | null = null;

  /**
   * @param api - The daemon API.
   * @param machineId - This machine.
   * @param buildHeartbeat - Builds the next heartbeat from the supervisor's state.
   * @param log - The daemon log.
   * @param hooks - The supervisor's callbacks.
   * @param useSocket - Whether to open the WebSocket at all.
   */
  constructor(
    private readonly api: DaemonApi,
    private readonly machineId: string,
    private readonly buildHeartbeat: () => HeartbeatRequest,
    private readonly log: DaemonLog,
    private readonly hooks: LinkHooks,
    private readonly useSocket = true,
  ) {}

  /** Start beating. */
  start(): void {
    this.stopped = false;
    this.beatNow();
  }

  /** Stop beating and close the socket. */
  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.socketTimer) clearTimeout(this.socketTimer);
    this.timer = null;
    this.socketTimer = null;
    this.closeSocket();
  }

  /** The link's state. */
  status(): LinkStatus {
    return {
      url: this.api.origin,
      connected: this.healthy,
      lastHeartbeatAt: this.lastHeartbeatAt,
      socket: this.socketState,
      lastError: this.lastError,
      clockSkewMs: this.clockSkewMs,
      runnerId: this.runnerId,
    };
  }

  /** Heartbeat now, coalescing with one in flight. */
  beatNow(): void {
    if (this.stopped) return;
    if (this.beating) {
      this.again = true;
      return;
    }
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.beating = this.beat().finally(() => {
      this.beating = null;
      if (this.stopped) return;
      if (this.again) {
        this.again = false;
        this.beatNow();
      }
    });
  }

  /**
   * Wait for any heartbeat in flight.
   * @returns When it settles.
   */
  async settle(): Promise<void> {
    while (this.beating) await this.beating;
  }

  /**
   * Schedule the next heartbeat.
   * @param delayMs - When.
   */
  private schedule(delayMs: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.beatNow();
    }, delayMs);
  }

  /** One heartbeat and its consequences. */
  private async beat(): Promise<void> {
    let answer: HeartbeatResponse;
    try {
      answer = await this.api.heartbeat(this.buildHeartbeat());
    } catch (error) {
      this.failed(error);
      return;
    }
    const wasHealthy = this.healthy;
    this.healthy = true;
    this.lastError = null;
    this.lastHeartbeatAt = Date.now();
    this.intervalMs = answer.heartbeatIntervalMs;
    this.beatBackoff.succeed();
    this.checkSkew(answer.serverTime);
    if (!wasHealthy) {
      this.log.info("connected to the server", { url: this.api.origin });
      this.hooks.onHealthy();
    }
    this.schedule(this.intervalMs);
    if (this.useSocket && this.socketState === "closed" && !this.socketTimer)
      void this.openSocket();
    try {
      await this.hooks.onBeat(answer);
    } catch (error) {
      this.log.error(
        `handling a heartbeat failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * React to a failed heartbeat.
   * @param error - What went wrong.
   */
  private failed(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof ApiError) {
      if (error.status === 401) {
        this.log.error("the server refused the runner token", { status: 401 });
        this.stop();
        this.hooks.onRevoked();
        return;
      }
      if (error.status === 409 && error.type === MACHINE_IN_USE) {
        this.stop();
        this.hooks.onFatal(message);
        return;
      }
      if (error.status === 426 || error.type === PROTOCOL_UNSUPPORTED) {
        this.hooks.onProtocolUnsupported(message);
      }
    }
    if (this.healthy) this.log.warn(`lost the server: ${message}`);
    this.healthy = false;
    this.lastError = message;
    const delay =
      error instanceof ApiError && error.retryAfterMs !== undefined
        ? error.retryAfterMs
        : this.beatBackoff.fail();
    this.log.debug(`heartbeat failed; retrying in ${delay} ms`, {
      error: message,
    });
    this.schedule(delay);
  }

  /**
   * Warn (at most hourly) when the server's clock and ours disagree.
   * @param serverTime - The server's clock, epoch ms.
   */
  private checkSkew(serverTime: number): void {
    const skew = Date.now() - serverTime;
    this.clockSkewMs = skew;
    if (
      Math.abs(skew) > CLOCK_SKEW_WARN_MS &&
      Date.now() - this.lastSkewWarning > SKEW_WARN_EVERY_MS
    ) {
      this.lastSkewWarning = Date.now();
      this.log.warn(
        `this machine's clock is ${Math.round(skew / 1000)}s ${skew > 0 ? "ahead of" : "behind"} the server's; agents that sign things (git, gh) may fail`,
      );
    }
  }

  /** Connect, open the socket, and subscribe once. */
  private async openSocket(): Promise<void> {
    if (this.stopped || this.socketState !== "closed") return;
    this.socketState = "connecting";
    let cookie: string;
    let channel: string;
    try {
      const connected = await this.api.connect(this.machineId);
      cookie = connected.cookie;
      channel = connected.answer.channel;
      this.runnerId = connected.answer.runnerId;
    } catch (error) {
      this.socketState = "closed";
      if (error instanceof ApiError && error.status === 401) {
        this.stop();
        this.hooks.onRevoked();
        return;
      }
      if (
        error instanceof ApiError &&
        error.status === 409 &&
        error.type === MACHINE_IN_USE
      ) {
        this.stop();
        this.hooks.onFatal(error.message);
        return;
      }
      this.reconnectLater(this.socketBackoff.fail());
      return;
    }
    if (this.stopped) {
      this.socketState = "closed";
      return;
    }
    const url = `${this.api.origin.replace(/^http/, "ws")}/`;
    const socket = new WebSocket(url, {
      headers: { Cookie: cookie },
    } as unknown as string[]);
    this.socket = socket;
    const messageId = crypto.randomUUID();
    socket.addEventListener("open", () => {
      socket.send(
        JSON.stringify({ messageType: "subscribe", channel, messageId }),
      );
    });
    socket.addEventListener("message", (event) =>
      this.onFrame(String(event.data), channel, messageId),
    );
    socket.addEventListener("close", (event) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.socketState = "closed";
      if (this.stopped) return;
      this.log.debug("the socket closed", { code: event.code });
      // 1001: the server is going away for a deploy; come back soon, not slowly.
      this.reconnectLater(
        event.code === 1001
          ? 1_000 + Math.floor(Math.random() * 4_000)
          : this.socketBackoff.fail(),
      );
    });
    socket.addEventListener("error", () => {
      // A close event follows; reconnecting is handled there.
    });
  }

  /**
   * Handle one socket message.
   * @param data - The raw frame.
   * @param channel - This runner's channel.
   * @param messageId - The subscribe's id.
   */
  private onFrame(data: string, channel: string, messageId: string): void {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(data);
    } catch {
      return;
    }
    if (frame.messageId === messageId) {
      if (frame.subscribed) {
        this.socketState = "open";
        this.socketBackoff.succeed();
        this.log.debug("subscribed", { channel });
        // Anything published before the subscribe landed is found by a heartbeat.
        this.beatNow();
      } else if (frame.error) {
        this.log.warn("the server refused the socket subscription", {
          error: (frame.error as { message?: string }).message,
        });
        this.closeSocket();
        this.reconnectLater(this.socketBackoff.fail());
      }
      return;
    }
    const inner = frame.message as
      | { channel?: string; message?: unknown }
      | undefined;
    if (
      inner?.channel !== channel ||
      inner.channel !== runnerChannel(this.runnerId ?? -1)
    )
      return;
    let payload: unknown = inner.message;
    if (typeof payload === "string") {
      try {
        payload = JSON.parse(payload);
      } catch {
        return;
      }
    }
    const parsed = RunnerFrame.safeParse(payload);
    if (!parsed.success) return;
    this.log.debug("frame", { event: parsed.data.event });
    if (parsed.data.event === "revoked") {
      this.stop();
      this.hooks.onRevoked();
      return;
    }
    this.beatNow();
  }

  /**
   * Reconnect the socket after a delay.
   * @param delayMs - How long.
   */
  private reconnectLater(delayMs: number): void {
    if (this.stopped || this.socketTimer) return;
    this.socketTimer = setTimeout(() => {
      this.socketTimer = null;
      // Only while heartbeats work; a successful one reopens it otherwise.
      if (this.healthy) void this.openSocket();
    }, delayMs);
  }

  /** Close the socket without reconnecting. */
  private closeSocket(): void {
    const socket = this.socket;
    this.socket = null;
    this.socketState = "closed";
    try {
      socket?.close();
    } catch {
      // Already closed.
    }
  }
}
