import { z } from "zod";
import { MachineId } from "./heartbeat";

/** `daemon:connect`'s body. */
export const ConnectRequest = z.strictObject({
  machineId: MachineId,
});
export type ConnectRequest = z.infer<typeof ConnectRequest>;

/**
 * `daemon:connect`'s answer. The response also sets the `__session` cookie
 * the daemon presents on its WebSocket upgrade.
 */
export const ConnectResponse = z.looseObject({
  runnerId: z.number().int().positive(),
  channel: z.string().regex(/^runner:\d+$/),
  heartbeatIntervalMs: z.number().int().positive(),
  leaseMs: z.number().int().positive(),
  serverTime: z.number().int(),
});
export type ConnectResponse = z.infer<typeof ConnectResponse>;

/** The `error.type` of the 409 a second live runner on one machine receives. */
export const MACHINE_IN_USE = "MACHINE_IN_USE";

/**
 * The events published on `runner:<id>`. Content-free: each one only tells the
 * daemon to heartbeat now (or, for `revoked`, to stop).
 */
export const RUNNER_FRAME_EVENTS = ["work", "cancel", "revoked"] as const;

/** One frame on a runner's channel. */
export const RunnerFrame = z.object({ event: z.enum(RUNNER_FRAME_EVENTS) });
export type RunnerFrame = z.infer<typeof RunnerFrame>;

/**
 * The name of a runner's wake-up channel.
 * @param runnerId - The runner.
 * @returns `runner:<id>`.
 */
export function runnerChannel(runnerId: number): string {
  return `runner:${runnerId}`;
}
