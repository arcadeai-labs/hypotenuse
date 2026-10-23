import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
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

/** A connection refused because its host resolved to a non-public address. */
export class EndpointRefused extends Error {}

/** What {@link postToEndpoint} sends. */
export interface EndpointRequest {
  headers: Record<string, string>;
  body: Uint8Array;
  timeoutMs: number;
  /** Lift the private-address rule (default: `TELEMETRY_ALLOW_PRIVATE_ENDPOINTS`). */
  allowPrivate?: boolean;
  /** The resolver (tests inject one). */
  resolve?: Resolver;
}

/**
 * POST to a tenant-chosen URL, connecting only to an address that was checked.
 *
 * Checking a host's addresses and then letting `fetch` resolve it again is
 * open to DNS rebinding: a short-lived answer can be public when checked and
 * private when connected to. So the request resolves the host **once**, in
 * its own `lookup`, refuses it there if any address is not public, and
 * connects to exactly what it checked; TLS still verifies the certificate
 * against the host name. Redirects are not followed.
 * @param url - The full URL.
 * @param init - Headers, body, timeout, and the private-address rule.
 * @returns The status and response headers (the body is discarded).
 * @throws {EndpointRefused} When the host resolves to a non-public address.
 * @throws {Error} On a DNS or network failure or a timeout — retryable.
 */
export function postToEndpoint(
  url: string,
  init: EndpointRequest,
): Promise<{ status: number; headers: Record<string, string | undefined> }> {
  const target = new URL(url);
  const allowPrivate =
    init.allowPrivate ?? Boolean(config.telemetry.allowPrivateEndpoints);
  const resolve = init.resolve ?? systemResolver;
  const pinned = (
    host: string,
    options: { all?: boolean } | number | undefined,
    callback: (
      error: Error | null,
      address: string | { address: string; family: number }[],
      family?: number,
    ) => void,
  ) => {
    resolve(host).then(
      (addresses) => {
        // Not resolving may be a passing DNS failure: retryable, not a refusal.
        if (addresses.length === 0)
          return callback(new Error(`${host} does not resolve.`), "");
        const bad = addresses.find((a) => isPrivateAddress(a));
        if (bad && !allowPrivate)
          return callback(
            new EndpointRefused(
              `${host} resolves to ${bad}, which is not a public address.`,
            ),
            "",
          );
        const all = addresses.map((address) => ({
          address,
          family: isIP(address) === 6 ? 6 : 4,
        }));
        if (typeof options === "object" && options?.all)
          return callback(null, all);
        const first = all[0] as { address: string; family: number };
        callback(null, first.address, first.family);
      },
      (error: unknown) =>
        callback(
          new Error(
            `${host} does not resolve: ${error instanceof Error ? error.message : String(error)}`,
          ),
          "",
        ),
    );
  };
  const client = target.protocol === "https:" ? https : http;
  return new Promise((resolvePromise, reject) => {
    const req = client.request(
      {
        protocol: target.protocol,
        hostname: target.hostname.replace(/^\[|\]$/g, ""),
        port: target.port || undefined,
        path: `${target.pathname}${target.search}`,
        method: "POST",
        headers: {
          ...init.headers,
          "Content-Length": String(init.body.byteLength),
        },
        // An IP literal is never looked up; `endpointRefusal` checks it.
        lookup: pinned as never,
        timeout: init.timeoutMs,
      },
      (res) => {
        res.resume();
        res.on("end", () =>
          resolvePromise({
            status: res.statusCode ?? 0,
            headers: res.headers as Record<string, string | undefined>,
          }),
        );
        res.on("error", reject);
      },
    );
    // `timeout` above is the socket's idle time; this bounds the whole
    // request, so a collector that answers a byte at a time cannot hold it.
    const deadline = setTimeout(
      () => req.destroy(new Error("timed out")),
      init.timeoutMs,
    );
    req.on("close", () => clearTimeout(deadline));
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", reject);
    req.end(Buffer.from(init.body));
  });
}
