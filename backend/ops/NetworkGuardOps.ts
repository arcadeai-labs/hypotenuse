import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import { config } from "keryx";
// Type-only, for `config.network` (see `CryptoOps.ts`).
import type {} from "../config/network";

/**
 * The SSRF guard: every request the server makes to a URL a person typed goes
 * through here.
 *
 * A model provider's base URL is typed by an admin, and the process that calls
 * it runs inside the deployment's network. Without a check, "my OpenAI-compatible
 * endpoint is `http://169.254.169.254/`" reads the cloud's metadata service,
 * and `http://10.0.0.5:6379/` talks to Redis. So a URL must be `https`, carry no
 * credentials, and name a host every one of whose addresses is public — and the
 * request connects to exactly the addresses it checked, so a DNS answer that
 * changes between the check and the connection (rebinding) gains nothing.
 *
 * `config.network.allowPrivateHosts` lifts all of it. It is true only under
 * test, where the scripted model server listens on loopback.
 */

/** Resolves a host name to its addresses (injected by tests). */
export type Resolver = (host: string) => Promise<string[]>;

/** The system resolver: every A and AAAA record. */
export const systemResolver: Resolver = async (host) =>
  (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

/** Host names that are never public, whatever they resolve to. */
const PRIVATE_SUFFIXES = [".localhost", ".local", ".internal"];

/** A request refused by the guard: the URL or its host's addresses are not public. */
export class HostRefused extends Error {}

/**
 * Whether an IP address is not on the public internet: private, loopback,
 * link-local, carrier-grade NAT, multicast, reserved, or unspecified, in either
 * family (including IPv4 mapped into IPv6).
 * @param address - An IPv4 or IPv6 literal, brackets allowed.
 * @returns `true` when the address is not public; `false` for anything that is
 *   not an IP literal.
 */
export function isPrivateAddress(address: string): boolean {
  const host = address.replace(/^\[|\]$/g, "").toLowerCase();
  const family = isIP(host);
  if (family === 4) return isPrivateV4(host);
  if (family === 6) return isPrivateV6(host);
  return false;
}

/**
 * Whether a dotted-quad IPv4 address is not public.
 * @param host - The address.
 * @returns `true` when not public.
 */
function isPrivateV4(host: string): boolean {
  const [a, b] = host.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

/**
 * Whether an IPv6 address is loopback, unspecified, unique-local, link-local,
 * multicast, or an IPv4-mapped address that is not public.
 * @param host - The address, without brackets.
 * @returns `true` when not public.
 */
function isPrivateV6(host: string): boolean {
  if (host === "::1" || host === "::") return true;
  const mapped = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateV4(mapped[1]);
  // `URL` writes a mapped address in hex: `::ffff:a00:1` is 10.0.0.1.
  const hex = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const [hi, lo] = [parseInt(hex[1], 16), parseInt(hex[2], 16)];
    return isPrivateV4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(host);
}

/** What {@link urlRefusal} and {@link guardedFetch} accept besides the URL. */
export interface GuardOptions {
  /** Lift the guard (default: `config.network.allowPrivateHosts`). */
  allowPrivate?: boolean;
  /** The resolver (tests inject one). */
  resolve?: Resolver;
  /** How long the socket may sit idle (default: `config.network.requestTimeoutMs`). */
  timeoutMs?: number;
}

/**
 * The checks that need no DNS: scheme, credentials in the URL, `https`, and a
 * host that is a private name or a non-public IP literal.
 * @param url - The parsed URL.
 * @param allowPrivate - Whether the guard is lifted.
 * @returns A sentence naming the refusal, or `null`.
 */
function staticRefusal(url: URL, allowPrivate: boolean): string | null {
  if (url.protocol !== "https:" && url.protocol !== "http:")
    return "The base URL must be an http(s) URL.";
  if (url.username || url.password)
    return "The base URL may not carry credentials; the key goes in the API key field.";
  if (allowPrivate) return null;
  if (url.protocol !== "https:") return "The base URL must use https.";
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || PRIVATE_SUFFIXES.some((s) => host.endsWith(s)))
    return `${host} is not a public host.`;
  if (isIP(host) && isPrivateAddress(host))
    return `${host} is not a public address.`;
  return null;
}

/**
 * Why the server may not make a request to a URL, or `null` when it may. The
 * sentence is what a person reads when the base URL they typed is refused.
 * @param raw - The URL.
 * @param options - Whether private hosts are allowed, and the resolver.
 * @returns A sentence naming the refusal, or `null`.
 */
export async function urlRefusal(
  raw: string,
  options: GuardOptions = {},
): Promise<string | null> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "The base URL is not a URL.";
  }
  const allowPrivate = options.allowPrivate ?? config.network.allowPrivateHosts;
  const refusal = staticRefusal(url, allowPrivate);
  if (refusal || allowPrivate) return refusal;
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (isIP(host)) return null;
  let addresses: string[];
  try {
    addresses = await (options.resolve ?? systemResolver)(host);
  } catch {
    return `${host} does not resolve.`;
  }
  if (addresses.length === 0) return `${host} does not resolve.`;
  const bad = addresses.find((a) => isPrivateAddress(a));
  if (bad) return `${host} resolves to ${bad}, which is not a public address.`;
  return null;
}

/** The `lookup` callback node's `http.request` calls. */
type LookupCallback = (
  error: Error | null,
  address: string | { address: string; family: number }[],
  family?: number,
) => void;

/**
 * A `lookup` for `http.request` that resolves a host once, refuses it if any
 * address is not public, and hands back exactly what it checked — so the
 * connection is made to an address the guard approved.
 * @param resolve - The resolver.
 * @param allowPrivate - Whether non-public addresses are allowed.
 * @returns The lookup function.
 */
function pinnedLookup(resolve: Resolver, allowPrivate: boolean) {
  return (
    host: string,
    options: { all?: boolean } | number | undefined,
    callback: LookupCallback,
  ) => {
    resolve(host).then(
      (addresses) => {
        if (addresses.length === 0)
          return callback(new Error(`${host} does not resolve.`), "");
        const bad = addresses.find((a) => isPrivateAddress(a));
        if (bad && !allowPrivate)
          return callback(
            new HostRefused(
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
}

/**
 * Read a fetch body into bytes, for a request whose length must be known.
 * @param body - The `RequestInit.body`.
 * @returns The bytes, or `undefined` for no body.
 */
async function bodyBytes(
  body: RequestInit["body"],
): Promise<Buffer | undefined> {
  if (body === undefined || body === null) return undefined;
  return Buffer.from(await new Response(body).arrayBuffer());
}

/**
 * A `fetch` that refuses what {@link urlRefusal} refuses and connects only to
 * addresses it checked. Every model provider is handed this as its `fetch`, so
 * no AI SDK call reaches a host the guard did not approve. Redirects are not
 * followed: a 3xx comes back as the answer.
 * @param input - The URL (a `Request` is read for its URL, method, headers, body).
 * @param init - Method, headers, body, and abort signal.
 * @param options - Whether private hosts are allowed, and the resolver.
 * @returns The response, its body streamed.
 * @throws {HostRefused} When the URL or any address of its host is not public.
 */
export async function guardedFetch(
  input: string | URL | Request,
  init: RequestInit = {},
  options: GuardOptions = {},
): Promise<Response> {
  const request = input instanceof Request ? input : null;
  const target = new URL(request ? request.url : input.toString());
  const allowPrivate = options.allowPrivate ?? config.network.allowPrivateHosts;
  const resolve = options.resolve ?? systemResolver;

  // Everything but DNS here; the pinned lookup below resolves and checks
  // the addresses it connects to, once.
  const refusal = staticRefusal(target, allowPrivate);
  if (refusal) throw new HostRefused(refusal);
  const host = target.hostname.replace(/^\[|\]$/g, "");

  const headers = new Headers(request?.headers);
  for (const [key, value] of new Headers(init.headers)) headers.set(key, value);
  const method = (init.method ?? request?.method ?? "GET").toUpperCase();
  const body = await bodyBytes(
    init.body ?? (request && method !== "GET" ? await request.blob() : null),
  );
  if (body) headers.set("content-length", String(body.byteLength));
  const signal = init.signal ?? request?.signal ?? null;

  const client = target.protocol === "https:" ? https : http;
  return new Promise<Response>((resolvePromise, reject) => {
    const req = client.request(
      {
        protocol: target.protocol,
        hostname: host,
        port: target.port || undefined,
        path: `${target.pathname}${target.search}`,
        method,
        headers: Object.fromEntries(headers),
        // An IP literal is never looked up; it was checked above.
        lookup: pinnedLookup(resolve, allowPrivate) as never,
        timeout: options.timeoutMs ?? config.network.requestTimeoutMs,
      },
      (res) => {
        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(res.headers)) {
          if (value === undefined) continue;
          for (const v of Array.isArray(value) ? value : [value]) {
            responseHeaders.append(key, v);
          }
        }
        const status = res.statusCode ?? 0;
        const noBody = status === 204 || status === 304 || method === "HEAD";
        resolvePromise(
          new Response(
            noBody
              ? null
              : (Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>),
            {
              status,
              statusText: res.statusMessage,
              headers: responseHeaders,
            },
          ),
        );
      },
    );
    const abort = () => req.destroy(new Error("The request was aborted."));
    if (signal) {
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    }
    req.on("timeout", () => req.destroy(new Error("The request timed out.")));
    req.on("error", reject);
    req.end(body);
  });
}
