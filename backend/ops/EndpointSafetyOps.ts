import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { config } from "keryx";
// Type-only, for `config.telemetry` (see `CryptoOps.ts`).
import type {} from "../config/telemetry";
import { isPrivateAddress } from "./AuthSignalOps";

/**
 * Whether the worker may POST to a URL a tenant chose.
 *
 * An exporter endpoint is a URL an admin typed, and the worker that exports
 * to it runs inside the deployment's network: without a check, "export to
 * `http://169.254.169.254/`" reads the cloud's metadata service, and
 * "export to `http://10.0.0.5:6379/`" talks to Redis. So an endpoint must be
 * `https`, carry no credentials in the URL, and every address its host
 * resolves to must be public. The host is resolved at create, at edit, and
 * again before every export — a name that resolved publicly yesterday may
 * not today. `TELEMETRY_ALLOW_PRIVATE_ENDPOINTS` lifts all of it, for
 * development and tests.
 */

/** Resolves a host name to its addresses (injected by tests). */
export type Resolver = (host: string) => Promise<string[]>;

/** The system resolver: every A and AAAA record. */
export const systemResolver: Resolver = async (host) =>
  (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

/** Host names that are never public, whatever they resolve to. */
const PRIVATE_SUFFIXES = [".localhost", ".local", ".internal"];

/**
 * Why an endpoint may not be exported to, or null when it may.
 * @param raw - The endpoint URL.
 * @param options - Whether private endpoints are allowed, and the resolver.
 * @returns A sentence naming the refusal, or null.
 */
export async function endpointRefusal(
  raw: string,
  options: { allowPrivate?: boolean; resolve?: Resolver } = {},
): Promise<string | null> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "The endpoint is not a URL.";
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    return "The endpoint must be an http(s) URL.";
  if (url.username || url.password)
    return "The endpoint may not carry credentials; put them in a header.";
  const allowPrivate =
    options.allowPrivate ?? Boolean(config.telemetry.allowPrivateEndpoints);
  if (allowPrivate) return null;
  if (url.protocol !== "https:") return "The endpoint must use https.";
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || PRIVATE_SUFFIXES.some((s) => host.endsWith(s)))
    return `${host} is not a public host.`;
  let addresses: string[];
  if (isIP(host)) {
    addresses = [host];
  } else {
    try {
      addresses = await (options.resolve ?? systemResolver)(host);
    } catch {
      return `${host} does not resolve.`;
    }
    if (addresses.length === 0) return `${host} does not resolve.`;
  }
  const private_ = addresses.find((a) => isPrivateAddress(a));
  if (private_)
    return `${host} resolves to ${private_}, which is not a public address.`;
  return null;
}

/**
 * Normalize an endpoint for storage: no trailing slash, no `/v1/<signal>`
 * (the signal path is appended per export), no query or fragment.
 * @param raw - The URL as typed.
 * @returns The base URL.
 */
export function normalizeEndpoint(raw: string): string {
  const url = new URL(raw);
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname
    .replace(/\/v1\/(traces|metrics|logs)\/?$/, "")
    .replace(/\/+$/, "");
  return url.toString().replace(/\/+$/, "");
}
