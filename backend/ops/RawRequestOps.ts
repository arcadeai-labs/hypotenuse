import { type Connection, config, ErrorType, TypedError } from "keryx";

/**
 * Reading a request the way it actually arrived.
 *
 * An action normally sees `params` — the query string, the path parameters, and
 * a JSON body all merged into one flat object — and that is the wrong shape for
 * signed machine ingress. Linear signs the **bytes** of each webhook delivery,
 * so verifying `Linear-Signature` over a `JSON.parse` → `JSON.stringify` round
 * trip would compare a signature against a body Linear never sent. And a bearer
 * credential arrives in `Authorization`, which the merge cannot carry at all.
 *
 * The framework's answer is `web.rawBody: true`: param parsing skips the body
 * for that route and leaves it on `connection.rawRequest`, which is the same
 * `Request` object Bun handed the server. Path and query parameters are still
 * parsed, so an action keeps its `inputs` schema — it just stops being handed a
 * mangled copy of its own body, and a body key can no longer overwrite a path
 * parameter.
 */

/** A request body read up to a cap, as the bytes that arrived. */
export interface CappedBody {
  /** The retained bytes — at most `cap`, never the whole of an oversized body. */
  bytes: Uint8Array;
  /** How many bytes the sender actually delivered before we stopped reading. */
  byteLength: number;
  /** True when the body ran past `cap`, in which case {@link CappedBody.bytes} is short. */
  oversized: boolean;
}

/**
 * Read a request body, stopping one byte past a cap.
 *
 * One byte past rather than at, so "exactly at the limit" and "over it" are
 * distinguishable — a body of precisely `cap` is accepted, and the check that
 * rejects is a strict comparison against a number we know is short of the truth.
 *
 * **Never retains more than `cap + 1` bytes, and never allocates the cap up
 * front.** A cap is a ceiling, not a typical size: pre-allocating `cap + 1` on
 * every request — then returning a `subarray` view that pins the whole
 * `ArrayBuffer` for as long as the caller holds it — makes every small delivery
 * cost the largest one. Grow from the chunks that arrived and copy into a
 * tightly-sized buffer so a 2 KB body costs 2 KB.
 *
 * Bytes rather than text, deliberately. A caller that wants a string decodes
 * one; a caller verifying a signature must not, because decoding a body with an
 * invalid UTF-8 sequence in it and re-encoding would change the bytes the
 * signature was computed over.
 * @param req - The request whose body may be consumed.
 * @param cap - The largest body to retain, in bytes.
 * @returns The retained bytes, how many arrived, and whether it ran over.
 */
export async function readCappedBody(
  req: Request,
  cap: number,
): Promise<CappedBody> {
  if (!req.body) {
    return { bytes: new Uint8Array(0), byteLength: 0, oversized: false };
  }

  // Enough to prove the body is over the cap, and not one byte more. Chunks
  // are kept until the end so a small body never materializes a 32 MB slab.
  const ceiling = cap + 1;
  const chunks: Uint8Array[] = [];
  let retained = 0;
  let received = 0;
  let oversized = false;

  const reader = req.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    received += value.byteLength;

    const room = ceiling - retained;
    if (room > 0) {
      if (value.byteLength <= room) {
        chunks.push(value);
        retained += value.byteLength;
      } else {
        chunks.push(value.subarray(0, room));
        retained += room;
      }
    }

    if (received >= ceiling) {
      oversized = true;
      await reader.cancel();
      break;
    }
  }

  return {
    bytes: concatBytes(chunks, retained),
    byteLength: received,
    oversized,
  };
}

/**
 * Copy chunks into one buffer sized to what actually arrived.
 *
 * A copy rather than a view: socket chunks and `subarray` slices share a
 * larger `ArrayBuffer`, and returning that would reintroduce the pin this
 * helper exists to avoid.
 * @param chunks - The retained pieces, in order.
 * @param total - Their combined length.
 * @returns A buffer of exactly `total` bytes.
 */
function concatBytes(chunks: Uint8Array[], total: number): Uint8Array {
  if (total === 0) return new Uint8Array(0);
  if (chunks.length === 1) return chunks[0].slice();
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * The bearer token on a request, if it carries one.
 *
 * Case-insensitive on the scheme because `Authorization: bearer …` is legal and
 * HTTP clients do not agree on capitalization.
 * @param req - The request to read.
 * @returns The token, or `null` when there is no bearer credential.
 */
export function bearerToken(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (!header) return null;
  const match = /^bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

/**
 * The path of a request, with the configured API prefix stripped.
 *
 * The prefix is stripped because every route in this application is written
 * without it — `web.route` is `/webhooks/linear`, not `/api/webhooks/linear` —
 * and an action reading its own target off the URL should be reading the same
 * string the router matched.
 * @param req - The request to read.
 * @returns The path, or `""` when the URL will not parse.
 */
export function requestPath(req: Request): string {
  try {
    const path = new URL(req.url).pathname;
    const prefix = config.server.web.apiRoute;
    return path.startsWith(prefix) ? path.slice(prefix.length) : path;
  } catch {
    return "";
  }
}

/**
 * The raw `Request` behind a connection, for an action that declared
 * `web.rawBody`.
 *
 * A helper rather than a bare `connection.rawRequest!` at each call site: the
 * non-null assertion is only sound because the action set the flag *and* was
 * reached over HTTP, and centralizing it means an action that forgets either
 * gets a clear error instead of a `TypeError` three lines later. The CLI and
 * task transports genuinely have no request, which is why this is a real check
 * rather than a cast.
 * @param connection - The connection the action was invoked on.
 * @returns The underlying request.
 * @throws {TypedError} `CONNECTION_ACTION_RUN` when there is no HTTP request.
 */
export function rawRequestOf(connection: Connection): Request {
  const request = connection.rawRequest;
  if (!request) {
    throw new TypedError({
      message:
        "This endpoint can only be reached over HTTP; there is no request to read.",
      type: ErrorType.CONNECTION_ACTION_RUN,
    });
  }
  return request;
}
