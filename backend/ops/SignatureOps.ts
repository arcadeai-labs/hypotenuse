import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * The one signature scheme Hypotenuse speaks: the API channel's callbacks,
 * and the generic webhook platform in both directions.
 *
 * `Hypotenuse-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, t + "." + body)>`
 */

/** The prefix every callback secret carries, so one is recognizable in a leak. */
export const CALLBACK_SECRET_PREFIX = "hyp_cbs_";

/**
 * A fresh callback secret.
 * @returns The plaintext secret.
 */
export function generateCallbackSecret(): string {
  return `${CALLBACK_SECRET_PREFIX}${randomBytes(32).toString("base64url")}`;
}

/**
 * Sign a callback body.
 * @param secret - The bot's callback secret.
 * @param body - The exact body bytes, as text.
 * @param timestamp - Unix seconds.
 * @returns The `Hypotenuse-Signature` header value.
 */
export function signCallback(
  secret: string,
  body: string,
  timestamp: number,
): string {
  const mac = createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("hex");
  return `t=${timestamp},v1=${mac}`;
}

/**
 * Verify a callback signature the way a receiver should: recompute the HMAC
 * over the raw body, compare in constant time, and refuse an old timestamp.
 * @param secret - The bot's callback secret.
 * @param header - The `Hypotenuse-Signature` header.
 * @param body - The raw body, as text.
 * @param toleranceSeconds - How old a signature may be.
 * @returns Whether it is genuine and fresh.
 */
export function verifyCallbackSignature(
  secret: string,
  header: string,
  body: string,
  toleranceSeconds = 300,
): boolean {
  const parts = Object.fromEntries(
    header.split(",").map((p) => p.trim().split("=", 2) as [string, string]),
  );
  const t = Number(parts.t);
  if (!Number.isFinite(t) || !parts.v1) return false;
  if (Math.abs(Date.now() / 1000 - t) > toleranceSeconds) return false;
  const expected = Buffer.from(signCallback(secret, body, t).split("v1=")[1]);
  const given = Buffer.from(parts.v1);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/**
 * Verify a signature over the **bytes** that arrived, as ingress must: a
 * body with an invalid UTF-8 sequence decodes and re-encodes to different
 * bytes, so text would verify a body the sender never signed.
 * @param secret - The shared secret.
 * @param header - The `Hypotenuse-Signature` header.
 * @param bytes - The raw body.
 * @param toleranceSeconds - How old a signature may be.
 * @returns Whether it is genuine and fresh.
 */
export function verifySignatureBytes(
  secret: string,
  header: string,
  bytes: Uint8Array,
  toleranceSeconds = 300,
): boolean {
  const parts = Object.fromEntries(
    header.split(",").map((p) => p.trim().split("=", 2) as [string, string]),
  );
  const t = Number(parts.t);
  if (!Number.isFinite(t) || !parts.v1) return false;
  if (Math.abs(Date.now() / 1000 - t) > toleranceSeconds) return false;
  const expected = Buffer.from(
    createHmac("sha256", secret).update(`${t}.`).update(bytes).digest("hex"),
  );
  const given = Buffer.from(parts.v1);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
