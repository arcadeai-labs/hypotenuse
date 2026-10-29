/**
 * Reading the link `hypotenuse login` opens. The CLI listens on
 * `127.0.0.1:<port>` and puts the port, its PKCE challenge, a state value, and
 * the machine's name in the query. The page approves through `cli-auth:approve`
 * and then sends the browser to the listener — never anywhere else: the
 * redirect target is built here from a port number, not taken from the link.
 */

/** A well-formed authorize link. */
export interface CliAuthorizeRequest {
  port: number;
  state: string;
  codeChallenge: string;
  device: string;
}

/** How the CLI's listener reports back after the redirect. */
export type CliAuthorizeOutcome = "done" | "cancelled" | "error";

/**
 * Parse the authorize link's query.
 * @param params - The page's search params.
 * @returns The request, or null when any part is missing or malformed.
 */
export function parseAuthorizeRequest(
  params: URLSearchParams,
): CliAuthorizeRequest | null {
  const port = Number(params.get("port"));
  const state = params.get("state") ?? "";
  const codeChallenge = params.get("code_challenge") ?? "";
  const device = (params.get("device") ?? "").trim();
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(state)) return null;
  if (!/^[A-Za-z0-9_-]{43}$/.test(codeChallenge)) return null;
  if (!device || device.length > 256) return null;
  return { port, state, codeChallenge, device };
}

/**
 * The outcome the listener redirected back with, if this is that visit.
 * @param params - The page's search params.
 * @returns The outcome, or null on the first visit.
 */
export function parseOutcome(
  params: URLSearchParams,
): CliAuthorizeOutcome | null {
  const status = params.get("status");
  return status === "done" || status === "cancelled" || status === "error"
    ? status
    : null;
}

/**
 * Where to send the browser once the person decides: the CLI's loopback
 * listener, with the code on approval or `error=access_denied` on cancel.
 * @param request - The parsed request.
 * @param answer - The one-time code, or `{ denied: true }`.
 * @returns The callback URL.
 */
export function callbackUrl(
  request: CliAuthorizeRequest,
  answer: { code: string } | { denied: true },
): string {
  const url = new URL(`http://127.0.0.1:${request.port}/callback`);
  if ("code" in answer) url.searchParams.set("code", answer.code);
  else url.searchParams.set("error", "access_denied");
  url.searchParams.set("state", request.state);
  return url.toString();
}
