/**
 * The version of the server ⇄ daemon wire contract described in
 * `docs/RUNNER_PROTOCOL.md`. Bumped only for a change that is not additive;
 * the server refuses a daemon whose version it does not speak.
 */
export const PROTOCOL_VERSION = 1;

/**
 * The protocol versions this build of the server accepts, inclusive. A daemon
 * outside it is answered 426 `PROTOCOL_UNSUPPORTED` carrying this range.
 */
export const SUPPORTED_PROTOCOL_RANGE: readonly [min: number, max: number] = [
  1, 1,
];

/** The request header every `daemon:*` call carries its protocol version in. */
export const PROTOCOL_HEADER = "X-Hypotenuse-Protocol";

/** The `error.type` of the 426 a daemon outside the supported range receives. */
export const PROTOCOL_UNSUPPORTED = "PROTOCOL_UNSUPPORTED";

/**
 * Whether a protocol version, as sent in {@link PROTOCOL_HEADER}, is one this
 * server speaks.
 * @param value - The header's value (or a number), possibly absent.
 * @returns True when it is an integer inside {@link SUPPORTED_PROTOCOL_RANGE}.
 */
export function isSupportedProtocol(
  value: string | number | null | undefined,
): boolean {
  if (value === null || value === undefined || value === "") return false;
  const version = typeof value === "number" ? value : Number(value);
  const [min, max] = SUPPORTED_PROTOCOL_RANGE;
  return Number.isInteger(version) && version >= min && version <= max;
}
