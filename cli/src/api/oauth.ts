/**
 * Signing the CLI in through the dashboard. The person signs in on the web,
 * with whatever sign-in the web offers; the CLI never sees a password. Two
 * flows end at the same `cli-auth:exchange` and the same `hyp_cli_` token:
 *
 * - **Loopback + PKCE** (RFC 8252), the default. The CLI listens on an ephemeral
 *   `127.0.0.1` port and opens `{dashboard}/cli/authorize`; the person approves;
 *   the page redirects to the listener with a one-time code, which the CLI
 *   redeems with its PKCE verifier.
 * - **Device code** (RFC 8628), for `--no-browser`, SSH, and headless machines.
 *   The CLI prints a URL and a short code, the person types it into
 *   `{dashboard}/cli/activate` on any device, and the CLI polls until approved.
 */
import { register, unregister } from "../shutdown";
import type { ApiClient } from "./client";

/** What a successful exchange answers. */
export interface ExchangedToken {
  token: string;
  cliToken: { id: number; device: string; expiresAt: number };
}

/** The exchange's answer, approved or still waiting. */
interface ExchangeResponse {
  status: "approved" | "pending";
  token: string | null;
  cliToken: ExchangedToken["cliToken"] | null;
}

/** How long either flow waits for a person before giving up. */
export const SIGN_IN_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Random bytes as unpadded base64url.
 * @param bytes - How many random bytes.
 * @returns The encoded string.
 */
export function randomBase64Url(bytes: number): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString(
    "base64url",
  );
}

/**
 * The PKCE S256 challenge for a verifier.
 * @param verifier - The code verifier.
 * @returns base64url(sha256(verifier)), unpadded.
 */
export function s256(verifier: string): string {
  return new Bun.CryptoHasher("sha256").update(verifier).digest("base64url");
}

/**
 * Open a URL in the person's browser, best effort. `BROWSER=none` opens
 * nothing (the URL is printed either way); any other `BROWSER` is the command
 * to open it with.
 * @param url - The URL.
 * @param env - Environment variables.
 * @returns Whether an opener was started.
 */
export function openBrowser(
  url: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (env.BROWSER === "none") return false;
  const cmd = env.BROWSER
    ? [env.BROWSER, url]
    : process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];
  try {
    const proc = Bun.spawn(cmd, {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    proc.unref();
    return true;
  } catch {
    return false;
  }
}

/** Inputs to the loopback flow. */
export interface LoopbackOptions {
  /** An unauthenticated client for the server. */
  client: ApiClient;
  /** The dashboard origin, from `/api/status`. */
  dashboardUrl: string;
  /** The device name to show the person and store on the token. */
  device: string;
  /** Prints a line the person must see. */
  tell: (line: string) => void;
  /** Opens a URL; defaults to {@link openBrowser}. */
  open?: (url: string) => boolean;
  /** How long to wait for the person. */
  timeoutMs?: number;
}

/**
 * Sign in through the dashboard with a loopback redirect and PKCE.
 * @param options - See {@link LoopbackOptions}.
 * @returns The exchanged token.
 * @throws {Error} When the person cancels, the state does not match, or time runs out.
 */
export async function loopbackSignIn(
  options: LoopbackOptions,
): Promise<ExchangedToken> {
  const verifier = randomBase64Url(48);
  const state = randomBase64Url(16);
  const dashboard = options.dashboardUrl.replace(/\/$/, "");

  let settle!: {
    resolve: (code: string) => void;
    reject: (error: Error) => void;
  };
  const codeArrived = new Promise<string>((resolve, reject) => {
    settle = { resolve, reject };
  });

  // The listener answers the browser with a redirect back to the dashboard,
  // so the page the person ends on is painted by the design system rather
  // than by a string in this file.
  const doneUrl = (status: string) =>
    `${dashboard}/cli/authorize?status=${status}`;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== "/callback") {
        return new Response("Not found", { status: 404 });
      }
      if (url.searchParams.get("state") !== state) {
        settle.reject(
          new Error(
            "The sign-in callback did not match this login; try again.",
          ),
        );
        return Response.redirect(doneUrl("error"), 302);
      }
      const error = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      if (error || !code) {
        settle.reject(new Error("Sign-in was cancelled in the browser."));
        return Response.redirect(doneUrl("cancelled"), 302);
      }
      settle.resolve(code);
      return Response.redirect(doneUrl("done"), 302);
    },
  });
  const closeable = { close: async () => void server.stop(true) };
  register(closeable);

  const authorizeUrl = new URL(`${dashboard}/cli/authorize`);
  authorizeUrl.searchParams.set("port", String(server.port));
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("code_challenge", s256(verifier));
  authorizeUrl.searchParams.set("device", options.device);

  const opened = (options.open ?? openBrowser)(authorizeUrl.toString());
  options.tell(
    opened
      ? "Opening your browser to approve this CLI. If it did not open, visit:"
      : "Open this URL in a browser to approve this CLI:",
  );
  options.tell(`  ${authorizeUrl.toString()}`);

  const timeout = setTimeout(
    () => settle.reject(new Error("Timed out waiting for the browser.")),
    options.timeoutMs ?? SIGN_IN_TIMEOUT_MS,
  );
  try {
    const code = await codeArrived;
    const exchanged = await options.client.request<ExchangeResponse>(
      "POST",
      "/cli-auth/exchange",
      { body: { code, codeVerifier: verifier }, anonymous: true },
    );
    return approved(exchanged);
  } finally {
    clearTimeout(timeout);
    // Let the redirect response reach the browser before the listener goes.
    setTimeout(() => server.stop(true), 250).unref();
    unregister(closeable);
  }
}

/** Inputs to the device flow. */
export interface DeviceOptions {
  /** An unauthenticated client for the server. */
  client: ApiClient;
  /** The device name to show the person and store on the token. */
  device: string;
  /** Prints a line the person must see. */
  tell: (line: string) => void;
  /** Waits between polls; injectable so tests do not. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Sign in with a device code: print where to go and what to type, then poll.
 * @param options - See {@link DeviceOptions}.
 * @returns The exchanged token.
 * @throws {Error} When the code expires before anyone approves it.
 */
export async function deviceSignIn(
  options: DeviceOptions,
): Promise<ExchangedToken> {
  const started = await options.client.request<{
    deviceCode: string;
    userCode: string;
    verificationUrl: string;
    expiresIn: number;
    interval: number;
  }>("PUT", "/cli-auth/device", {
    body: { device: options.device },
    anonymous: true,
  });
  options.tell(`On any device, open ${started.verificationUrl}`);
  options.tell(`and enter the code: ${started.userCode}`);

  const sleep = options.sleep ?? Bun.sleep;
  const deadline = Date.now() + started.expiresIn * 1000;
  while (Date.now() < deadline) {
    await sleep(started.interval * 1000);
    const polled = await options.client.request<ExchangeResponse>(
      "POST",
      "/cli-auth/exchange",
      { body: { deviceCode: started.deviceCode }, anonymous: true },
    );
    if (polled.status === "approved") return approved(polled);
  }
  throw new Error("The code expired before it was approved. Run login again.");
}

/**
 * Narrow an approved exchange.
 * @param response - The exchange's answer.
 * @returns The token and its row.
 * @throws {Error} If the server answered approved without a token.
 */
function approved(response: ExchangeResponse): ExchangedToken {
  if (response.status !== "approved" || !response.token || !response.cliToken) {
    throw new Error("The server did not issue a token.");
  }
  return { token: response.token, cliToken: response.cliToken };
}
