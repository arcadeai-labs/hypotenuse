/**
 * **The fake-platform pattern.** Every platform Hypotenuse talks to is faked
 * in process over its real wire protocol, never by mocking our own code:
 *
 * - the fake is an HTTP server implementing the slice of the platform's API
 *   the adapter calls, validating each request against the platform's
 *   published schema (for the webhook platform, `webhookOutboundSchema`
 *   below; for Slack and Pylon, their OpenAPI specs; Linear is finear);
 * - it signs and delivers webhooks exactly as the platform does, retries
 *   included, so ingress verifies real signatures over real bytes;
 * - it records every request it receives, and exposes `/__test/*` control
 *   routes (and the same controls as methods) to post a message as a person,
 *   press a button, lose a response, answer 429 with the platform's headers,
 *   or uninstall the app.
 *
 * A behavior the fake cannot show yet is filed against the fake, and driven
 * through a control route meanwhile — never faked inside `backend/`.
 */

/** One request the fake received from Hypotenuse. */
export interface FakeRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
  /** The parsed JSON body, or `null`. */
  json: unknown;
  /** Whether the fake's schema check passed. */
  valid: boolean;
  /** Why it did not, when it did not. */
  invalid?: string;
}

/** How the fake answers the next platform API call. */
export type FakeAnswer =
  | { status: number; headers?: Record<string, string>; body?: unknown }
  /** Process the call, then drop the response (the client times out). */
  | { lose: true; delayMs: number };

/**
 * The base every platform fake extends: a server, a request log, a queue of
 * scripted answers, and the `/__test/*` dispatcher.
 */
export abstract class FakePlatform {
  /** Every request Hypotenuse made to the platform, oldest first. */
  requests: FakeRequest[] = [];
  /** Scripted answers for the next API calls; empty means success. */
  answers: FakeAnswer[] = [];
  private server: ReturnType<typeof Bun.serve> | null = null;

  /** The fake's origin, `http://127.0.0.1:<port>`. */
  get url(): string {
    if (!this.server) throw new Error("The fake is not started");
    return `http://127.0.0.1:${this.server.port}`;
  }

  /** Start listening on a free port. */
  start(): this {
    this.server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (req) => this.dispatch(req),
    });
    return this;
  }

  /** Stop listening. */
  async stop(): Promise<void> {
    await this.server?.stop(true);
    this.server = null;
  }

  /** Forget recorded requests and scripted answers. */
  reset(): void {
    this.requests = [];
    this.answers = [];
  }

  /**
   * Route a request: `/__test/<control>` to {@link control}, anything else to
   * the platform's API, recorded and answered as scripted.
   * @param req - The request.
   * @returns The response.
   */
  private async dispatch(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname;
    if (path.startsWith("/__test/")) {
      const body =
        req.method === "POST" ? await req.json().catch(() => ({})) : {};
      const result = await this.control(path.slice("/__test/".length), body);
      return Response.json(result ?? { ok: true });
    }
    const text = await req.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    const headers = Object.fromEntries(req.headers.entries());
    const checked = this.validate(path, headers, text, json);
    this.requests.push({
      method: req.method,
      path,
      headers,
      body: text,
      json,
      valid: checked === true,
      ...(checked === true ? {} : { invalid: checked }),
    });
    const answer = this.answers.shift();
    if (answer && "lose" in answer) {
      await Bun.sleep(answer.delayMs);
      return new Response(null, { status: 200 });
    }
    if (answer) {
      return new Response(
        answer.body === undefined ? null : JSON.stringify(answer.body),
        { status: answer.status, headers: answer.headers },
      );
    }
    if (checked !== true)
      return Response.json({ error: checked }, { status: 400 });
    return this.handle(path, json);
  }

  /**
   * Check a request against the platform's published schema and signing.
   * @param path - The API path.
   * @param headers - Its headers.
   * @param body - Its raw body.
   * @param json - Its parsed body.
   * @returns `true`, or why it is invalid.
   */
  protected abstract validate(
    path: string,
    headers: Record<string, string>,
    body: string,
    json: unknown,
  ): true | string;

  /**
   * Answer a valid API call as the platform does.
   * @param path - The API path.
   * @param json - Its parsed body.
   * @returns The response.
   */
  protected abstract handle(path: string, json: unknown): Response;

  /**
   * Run a `/__test/*` control.
   * @param name - The control, e.g. `post`.
   * @param body - Its arguments.
   * @returns What it returns, as JSON.
   */
  protected abstract control(name: string, body: unknown): Promise<unknown>;
}
