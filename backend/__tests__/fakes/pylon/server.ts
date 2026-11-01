import { createHmac, randomUUID } from "node:crypto";
import { z } from "zod";
import type { FakeAnswer, FakeRequest } from "../base";

/**
 * **Pylon, faked** — in process, over Pylon's real REST API and webhook
 * signing, for the Pylon platform's suites. Pylon publishes no
 * machine-readable spec we could find, so every request body below is
 * validated against a schema we hold, each field citing the doc page it came
 * from (https://docs.usepylon.com/pylon-docs/developer/api/api-reference/…).
 * A call real Pylon would refuse is recorded `valid: false`; suites assert
 * there are none.
 *
 * **Regions.** One server plays both: `<url>/us` and `<url>/eu`. A token used
 * at the other region's origin answers `401 wrong_region_token` (errors.md).
 *
 * **Rate limits** per token per endpoint and minute, as each endpoint's page
 * states: `/note`, `/reply`, `/draft-reply` 30; `PATCH /issues/{id}`,
 * `/messages`, `/issues/search` 120; `GET /issues/{id}`, `/me` 300. Over the
 * limit: `429 rate_limited` with `Retry-After` and `X-Retry-After`
 * (rate-limits.md).
 *
 * **Webhooks** are what a Pylon admin configures: a webhook (its URL and its
 * secret) and Triggers whose "Send webhook" body is a template. A person's
 * action through the test controls fires the matching Trigger kickoffs; the
 * fake renders each template's `{{ variable }}`s as Pylon would (values
 * pasted in as text, not JSON-escaped) and signs the body with
 * `X-Pylon-Timestamp` and `X-Pylon-Signature-V2` = hex HMAC-SHA256 of
 * `<timestamp>.<body>` (webhooks.md), or — for a legacy webhook — only the
 * body, as `X-Pylon-Signature`. A note or reply posted through the API by a
 * token fires "Issue has a new message" too, as in Pylon.
 */

/** A token, and who it is. */
interface FakeToken {
  userId: string;
  region: "us" | "eu";
}

/** A Pylon issue as the fake holds it. */
export interface FakeIssue {
  id: string;
  number: number;
  title: string;
  body_html: string;
  link: string;
  state: string;
  source: string;
  tags: string[];
  account: { id: string } | null;
  requester: { id: string; email: string } | null;
  assignee: { id: string; email: string } | null;
  team: { id: string } | null;
}

/** A message or internal note as the fake holds it. */
export interface FakeMessage {
  id: string;
  issueId: string;
  is_private: boolean;
  message_html: string;
  source: string;
  timestamp: string;
  thread_id?: string;
  author: {
    name: string;
    contact?: { id: string; email: string };
    user?: { id: string; email: string };
  };
  /** A reply's `custom_source.external_id`. */
  externalId?: string;
}

/** A draft reply. */
export interface FakeDraft {
  id: string;
  issueId: string;
  userId: string;
  body_html: string;
}

/** One configured Trigger: its kickoff and its webhook body template. */
export interface FakeTrigger {
  kickoff: string;
  body: string;
}

/** A webhook delivery waiting to be sent. */
interface PendingDelivery {
  body: string;
  timestamp: number;
}

/** The kickoffs the fake fires. */
type Kickoff =
  | "New issue created"
  | "Issue has a new message"
  | "Issue assigned"
  | "Issue status changed";

// --- Request schemas, each citing its page. ---

/** messages.md — "Create an internal note on an issue". */
const noteBody = z
  .object({
    body_html: z.string().min(1),
    thread_id: z.string().optional(),
    message_id: z.string().optional(),
    thread_name: z.string().optional(),
    attachment_urls: z.array(z.string()).optional(),
    user_id: z.string().optional(),
  })
  .strict()
  .refine(
    (b) => !(b.thread_id && b.message_id),
    "thread_id and message_id together are a 400",
  );

/** messages.md — "Reply to an issue". */
const replyBody = z
  .object({
    body_html: z.string().min(1),
    message_id: z.string().min(1),
    attachment_urls: z.array(z.string()).optional(),
    user_id: z.string().optional(),
    contact_id: z.string().optional(),
    custom_source: z
      .object({
        external_id: z.string().min(1),
        created_at: z.string().optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      })
      .optional(),
    email_info: z
      .object({
        to_emails: z.array(z.string()).optional(),
        cc_emails: z.array(z.string()).optional(),
        bcc_emails: z.array(z.string()).optional(),
      })
      .optional(),
  })
  .strict()
  .refine(
    (b) => !(b.user_id && b.contact_id),
    "user_id and contact_id are mutually exclusive",
  );

/** messages.md — "Create or update a draft reply". */
const draftBody = z
  .object({
    body_html: z.string().min(1),
    to_emails: z.array(z.string()).optional(),
    cc_emails: z.array(z.string()).optional(),
    bcc_emails: z.array(z.string()).optional(),
    user_id: z.string().optional(),
  })
  .strict();

/** issues.md — "Update an issue". */
const patchBody = z
  .object({
    state: z.string().optional(),
    assignee_id: z.string().optional(),
    team_id: z.string().optional(),
    account_id: z.string().optional(),
    requester_id: z.string().optional(),
    title: z.string().optional(),
    tags: z.array(z.string()).optional(),
    custom_fields: z
      .array(
        z.object({
          slug: z.string(),
          value: z.string().optional(),
          values: z.array(z.string()).optional(),
        }),
      )
      .optional(),
    customer_portal_visible: z.boolean().optional(),
    type: z.enum(["conversation", "ticket"]).optional(),
  })
  .strict();

/** issues.md — "Search issues" (`SearchIssuesRequest`). */
const filterSchema: z.ZodType<unknown> = z.lazy(() =>
  z
    .object({
      field: z.string().optional(),
      operator: z.string().min(1),
      value: z.unknown().optional(),
      values: z.array(z.unknown()).optional(),
      subfilters: z.array(filterSchema).optional(),
    })
    .strict(),
);
const searchBody = z
  .object({
    filter: filterSchema.optional(),
    search_text: z.string().optional(),
    limit: z.number().int().min(1).max(1000).optional(),
    cursor: z.string().optional(),
  })
  .strict();

/** A running Pylon fake. */
export class FakePylon {
  /** Every API request Hypotenuse made, oldest first. */
  requests: FakeRequest[] = [];
  /** Scripted answers for the next API calls; empty means success. */
  answers: FakeAnswer[] = [];
  /** Webhook bodies delivered, oldest first, with their status. */
  deliveries: { body: string; status: number }[] = [];
  org = { id: `org_${randomUUID().slice(0, 8)}`, name: "Castle Support" };
  tokens = new Map<string, FakeToken>();
  users = new Map<string, { id: string; email: string; name: string }>();
  accounts = new Map<
    string,
    { id: string; name: string; domains: string[]; primary_domain: string }
  >();
  contacts = new Map<
    string,
    { id: string; name: string; email: string; account: { id: string } }
  >();
  issues = new Map<string, FakeIssue>();
  messages: FakeMessage[] = [];
  drafts: FakeDraft[] = [];
  /** The webhook: where it posts, its secret, whether it signs the legacy way. */
  webhook: { url: string; secret: string; legacy: boolean } | null = null;
  triggers: FakeTrigger[] = [];
  private pending: PendingDelivery[] = [];
  private counts = new Map<string, { minute: number; n: number }>();
  private nextNumber = 100;
  private server: ReturnType<typeof Bun.serve> | null = null;

  /** The fake's origin. */
  get url(): string {
    if (!this.server) throw new Error("The fake is not started");
    return `http://127.0.0.1:${this.server.port}`;
  }

  /**
   * Start listening.
   * @param port - The port (a free one by default).
   * @returns The fake.
   */
  start(port = 0): this {
    this.server = Bun.serve({
      port,
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

  /** Forget recorded requests, deliveries, scripted answers, and rate counts. */
  clearRequests(): void {
    this.requests = [];
    this.answers = [];
    this.deliveries = [];
    this.pending = [];
    this.counts.clear();
  }

  // --- Seeding ---

  /**
   * Create an API token for a user (a token with its own identity is a user).
   * @param name - The identity's name.
   * @param region - Its region.
   * @returns The token and the user's id.
   */
  createToken(
    name: string,
    region: "us" | "eu" = "us",
  ): { token: string; userId: string } {
    const userId = `usr_${randomUUID().slice(0, 12)}`;
    this.users.set(userId, { id: userId, email: "", name });
    const token = `pylon_${randomUUID().replace(/-/g, "")}`;
    this.tokens.set(token, { userId, region });
    return { token, userId };
  }

  /**
   * Accept a known token (a fixed one, for a long-running process).
   * @param token - The token.
   * @param name - Its identity's name.
   * @returns The user id it acts as.
   */
  addToken(token: string, name: string): string {
    const userId = `usr_${name.toLowerCase().replace(/\W+/g, "")}`;
    this.users.set(userId, { id: userId, email: "", name });
    this.tokens.set(token, { userId, region: "us" });
    return userId;
  }

  /**
   * Add a teammate.
   * @param name - Their name.
   * @returns Their user id.
   */
  addUser(name: string): string {
    const id = `usr_${randomUUID().slice(0, 12)}`;
    this.users.set(id, {
      id,
      name,
      email: `${name.toLowerCase().replace(/\W+/g, ".")}@castle.test`,
    });
    return id;
  }

  /**
   * Add a customer account and one contact in it.
   * @param name - The company.
   * @param domain - Its domain.
   * @returns The account's and the contact's ids.
   */
  addAccount(
    name: string,
    domain: string,
  ): { accountId: string; contactId: string } {
    const accountId = `acc_${randomUUID().slice(0, 12)}`;
    this.accounts.set(accountId, {
      id: accountId,
      name,
      domains: [domain],
      primary_domain: domain,
    });
    const contactId = `con_${randomUUID().slice(0, 12)}`;
    this.contacts.set(contactId, {
      id: contactId,
      name: `Pat at ${name}`,
      email: `pat@${domain}`,
      account: { id: accountId },
    });
    return { accountId, contactId };
  }

  // --- People acting in Pylon (each fires its Triggers) ---

  /**
   * A customer opens an issue: its first message is theirs.
   * @param input - The account's contact, the title, the body, team, tags.
   * @returns The issue.
   */
  openIssue(input: {
    contactId: string;
    title: string;
    body: string;
    teamId?: string;
    tags?: string[];
  }): FakeIssue {
    const contact = this.contacts.get(input.contactId);
    if (!contact) throw new Error("No such contact");
    const id = randomUUID();
    const number = this.nextNumber++;
    const issue: FakeIssue = {
      id,
      number,
      title: input.title,
      body_html: `<p>${input.body}</p>`,
      link: `https://app.usepylon.com/issues?issueNumber=${number}`,
      state: "new",
      source: "email",
      tags: input.tags ?? [],
      account: contact.account,
      requester: { id: contact.id, email: contact.email },
      assignee: null,
      team: input.teamId ? { id: input.teamId } : null,
    };
    this.issues.set(id, issue);
    this.addMessage(issue, {
      is_private: false,
      message_html: issue.body_html,
      author: {
        name: contact.name,
        contact: { id: contact.id, email: contact.email },
      },
    });
    this.fire("New issue created", issue);
    this.fire("Issue has a new message", issue);
    return issue;
  }

  /**
   * A customer writes on an issue.
   * @param issueId - The issue.
   * @param text - What they write.
   * @returns The message.
   */
  customerWrites(issueId: string, text: string): FakeMessage {
    const issue = this.mustIssue(issueId);
    const contact = this.contacts.get(issue.requester?.id ?? "");
    const m = this.addMessage(issue, {
      is_private: false,
      message_html: `<p>${text}</p>`,
      author: {
        name: contact?.name ?? "Customer",
        contact: { id: contact?.id ?? "", email: contact?.email ?? "" },
      },
    });
    this.fire("Issue has a new message", issue);
    return m;
  }

  /**
   * A teammate writes an internal note (or, `publicReply`, a reply).
   * @param issueId - The issue.
   * @param userId - The teammate.
   * @param text - What they write.
   * @param publicReply - A customer-facing reply instead of a note.
   * @returns The message.
   */
  teammateWrites(
    issueId: string,
    userId: string,
    text: string,
    publicReply = false,
  ): FakeMessage {
    const issue = this.mustIssue(issueId);
    const user = this.users.get(userId);
    if (!user) throw new Error("No such user");
    const m = this.addMessage(issue, {
      is_private: !publicReply,
      message_html: `<p>${text}</p>`,
      author: { name: user.name, user: { id: user.id, email: user.email } },
      ...(publicReply ? {} : { thread_id: `thr_${issue.id.slice(0, 8)}` }),
    });
    this.fire("Issue has a new message", issue);
    return m;
  }

  /**
   * Move an issue to another account (Pylon fires no Trigger for this here).
   * @param issueId - The issue.
   * @param accountId - The account it now belongs to.
   */
  moveToAccount(issueId: string, accountId: string): void {
    const issue = this.mustIssue(issueId);
    issue.account = { id: accountId };
  }

  /**
   * Assign an issue (to a user id, or to nobody).
   * @param issueId - The issue.
   * @param userId - The assignee, or `null`.
   */
  assign(issueId: string, userId: string | null): void {
    const issue = this.mustIssue(issueId);
    const user = userId ? this.users.get(userId) : null;
    issue.assignee = user ? { id: user.id, email: user.email } : null;
    this.fire("Issue assigned", issue);
  }

  /**
   * Move an issue to a state.
   * @param issueId - The issue.
   * @param state - The state's slug.
   */
  setState(issueId: string, state: string): void {
    const issue = this.mustIssue(issueId);
    issue.state = state;
    this.fire("Issue status changed", issue);
  }

  /**
   * Post every webhook delivery waiting, in order. A delivery that fails is
   * retried (Pylon makes three attempts in all).
   * @param opts.timestampOffsetSeconds - Sign with a timestamp this far off.
   * @returns How many were delivered.
   */
  async drain(opts: { timestampOffsetSeconds?: number } = {}): Promise<number> {
    let n = 0;
    while (this.pending.length > 0) {
      const d = this.pending.shift() as PendingDelivery;
      for (let attempt = 0; attempt < 3; attempt++) {
        const status = await this.deliver(
          d.body,
          d.timestamp + (opts.timestampOffsetSeconds ?? 0),
          attempt,
        );
        this.deliveries.push({ body: d.body, status });
        if (status >= 200 && status < 300) break;
      }
      n++;
    }
    return n;
  }

  /**
   * Sign and post one body to the webhook, as Pylon does.
   * @param body - The rendered body.
   * @param timestamp - `X-Pylon-Timestamp`, Unix seconds.
   * @param retry - The retry number (0 for the first attempt).
   * @param secret - Sign with another secret.
   * @returns The HTTP status.
   */
  async deliver(
    body: string,
    timestamp = Math.floor(Date.now() / 1000),
    retry = 0,
    secret?: string,
  ): Promise<number> {
    if (!this.webhook) throw new Error("No webhook is configured");
    const key = secret ?? this.webhook.secret;
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (this.webhook.legacy) {
      headers["x-pylon-signature"] = createHmac("sha256", key)
        .update(body)
        .digest("hex");
    } else {
      headers["x-pylon-timestamp"] = String(timestamp);
      headers["x-pylon-signature-v2"] = createHmac("sha256", key)
        .update(`${timestamp}.${body}`)
        .digest("hex");
    }
    if (retry > 0) headers["x-pylon-retry-number"] = String(retry);
    const res = await fetch(this.webhook.url, {
      method: "POST",
      headers,
      body,
    });
    await res.body?.cancel().catch(() => {});
    return res.status;
  }

  /** Notes posted on an issue, oldest first. */
  notesOn(issueId: string): FakeMessage[] {
    return this.messages.filter((m) => m.issueId === issueId && m.is_private);
  }

  /** Customer-visible replies posted on an issue by a token. */
  repliesOn(issueId: string): FakeMessage[] {
    return this.messages.filter(
      (m) => m.issueId === issueId && !m.is_private && m.author.user,
    );
  }

  // --- Internals ---

  /**
   * An issue by id, or throw.
   * @param id - The issue.
   * @returns It.
   */
  private mustIssue(id: string): FakeIssue {
    const issue = this.issues.get(id);
    if (!issue) throw new Error("No such issue");
    return issue;
  }

  /**
   * Store a message.
   * @param issue - Its issue.
   * @param m - Its fields.
   * @returns It.
   */
  private addMessage(
    issue: FakeIssue,
    m: Omit<FakeMessage, "id" | "issueId" | "timestamp" | "source"> & {
      source?: string;
    },
  ): FakeMessage {
    const message: FakeMessage = {
      id: randomUUID(),
      issueId: issue.id,
      timestamp: new Date().toISOString(),
      source: m.source ?? "email",
      ...m,
    };
    this.messages.push(message);
    return message;
  }

  /**
   * Queue the webhook bodies of every Trigger with this kickoff.
   * @param kickoff - What happened.
   * @param issue - The issue it happened to.
   */
  private fire(kickoff: Kickoff, issue: FakeIssue): void {
    if (!this.webhook) return;
    const last = this.messages.filter((m) => m.issueId === issue.id).at(-1);
    const vars: Record<string, string> = {
      "issue.id": issue.id,
      "issue.number": String(issue.number),
      "issue.title": issue.title,
      "issue.status": issue.state,
      "issue.assignee.id": issue.assignee?.id ?? "",
      "issue.account.id": issue.account?.id ?? "",
      "issue.last_message.id": last?.id ?? "",
      "issue.last_message.is_private": String(last?.is_private ?? false),
    };
    for (const t of this.triggers.filter((t) => t.kickoff === kickoff)) {
      const body = t.body.replace(
        /\{\{\s*([\w.]+)\s*\}\}/g,
        (_, name: string) => vars[name] ?? "",
      );
      this.pending.push({ body, timestamp: Math.floor(Date.now() / 1000) });
    }
  }

  /**
   * Count a call against its limit.
   * @param token - The token.
   * @param bucket - The endpoint's bucket name.
   * @param limit - Its per-minute limit.
   * @returns Seconds to wait, or 0.
   */
  private limited(token: string, bucket: string, limit: number): number {
    const minute = Math.floor(Date.now() / 60_000);
    const key = `${token}:${bucket}`;
    const c = this.counts.get(key);
    if (!c || c.minute !== minute) {
      this.counts.set(key, { minute, n: 1 });
      return 0;
    }
    c.n++;
    if (c.n <= limit) return 0;
    return 60 - Math.floor((Date.now() % 60_000) / 1000);
  }

  /**
   * Answer an error in Pylon's shape (errors.md).
   * @param status - The HTTP status.
   * @param code - Pylon's code.
   * @param message - Pylon's message.
   * @param headers - Extra headers.
   * @returns The response.
   */
  private error(
    status: number,
    code: string,
    message: string,
    headers: Record<string, string> = {},
  ): Response {
    return Response.json(
      { errors: [message], code, request_id: randomUUID() },
      { status, headers },
    );
  }

  /**
   * Answer `{ data, request_id }`.
   * @param data - The data.
   * @returns The response.
   */
  private ok(data: unknown): Response {
    return Response.json({ data, request_id: randomUUID() });
  }

  /**
   * Route one API call.
   * @param req - The request.
   * @returns The response.
   */
  private async dispatch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const [, region, ...rest] = url.pathname.split("/");
    const path = `/${rest.join("/")}`;
    const text = await req.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    const headers = Object.fromEntries(req.headers.entries());
    const route = this.route(req.method, path);
    const checked = route ? this.validate(route.name, json) : "unknown route";
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
    const auth = /^Bearer (.+)$/.exec(headers.authorization ?? "");
    if (!auth) {
      return this.error(401, "invalid_authorization_header", "missing bearer");
    }
    const token = this.tokens.get(auth[1]);
    if (!token) return this.error(401, "invalid_api_token", "token rejected");
    if (token.region !== region) {
      return this.error(
        401,
        "wrong_region_token",
        "this token belongs to another region; use that region's API URL",
      );
    }
    if (!route) return this.error(404, "not_found", "not an API endpoint");
    if (checked !== true) return this.error(400, "invalid_request", checked);
    const wait = this.limited(auth[1], route.name, route.limit);
    if (wait > 0) {
      return this.error(429, "rate_limited", "rate limit exceeded", {
        "retry-after": String(wait),
        "x-retry-after": String(wait),
      });
    }
    return this.handle(route.name, route.id, json, token);
  }

  /**
   * Which endpoint a call is, and its limit.
   * @param method - The method.
   * @param path - The path, region removed.
   * @returns The route, or `null`.
   */
  private route(
    method: string,
    path: string,
  ): { name: string; id: string; limit: number } | null {
    const m = (re: RegExp) => re.exec(path);
    let r: RegExpExecArray | null;
    if (method === "GET" && path === "/me")
      return { name: "me", id: "", limit: 300 };
    if (method === "POST" && path === "/issues/search")
      return { name: "search", id: "", limit: 120 };
    if ((r = m(/^\/issues\/([^/]+)$/))) {
      if (method === "GET") return { name: "issue", id: r[1], limit: 300 };
      if (method === "PATCH") return { name: "patch", id: r[1], limit: 120 };
    }
    if ((r = m(/^\/issues\/([^/]+)\/messages$/)) && method === "GET")
      return { name: "messages", id: r[1], limit: 120 };
    if ((r = m(/^\/issues\/([^/]+)\/note$/)) && method === "POST")
      return { name: "note", id: r[1], limit: 30 };
    if ((r = m(/^\/issues\/([^/]+)\/reply$/)) && method === "POST")
      return { name: "reply", id: r[1], limit: 30 };
    if ((r = m(/^\/issues\/([^/]+)\/draft-reply$/)) && method === "POST")
      return { name: "draft", id: r[1], limit: 30 };
    if ((r = m(/^\/accounts\/([^/]+)$/)) && method === "GET")
      return { name: "account", id: r[1], limit: 120 };
    if ((r = m(/^\/contacts\/([^/]+)$/)) && method === "GET")
      return { name: "contact", id: r[1], limit: 120 };
    return null;
  }

  /**
   * Check a body against the endpoint's schema.
   * @param name - The endpoint.
   * @param json - The body.
   * @returns `true`, or why not.
   */
  private validate(name: string, json: unknown): true | string {
    const schema = {
      note: noteBody,
      reply: replyBody,
      draft: draftBody,
      patch: patchBody,
      search: searchBody,
    }[name];
    if (!schema) return json === null ? true : "this endpoint takes no body";
    const r = schema.safeParse(json);
    return r.success
      ? true
      : r.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ");
  }

  /**
   * Answer a valid, authenticated call.
   * @param name - The endpoint.
   * @param id - The path's id.
   * @param json - The body.
   * @param token - Who calls.
   * @returns The response.
   */
  private handle(
    name: string,
    id: string,
    json: unknown,
    token: FakeToken,
  ): Response {
    const me = this.users.get(token.userId);
    const issue = id ? this.issues.get(id) : undefined;
    const needsIssue = ["issue", "patch", "messages", "note", "reply", "draft"];
    if (needsIssue.includes(name) && !issue) {
      return this.error(404, "not_found", "issue not found");
    }
    const body = (json ?? {}) as Record<string, unknown>;
    switch (name) {
      case "me":
        return this.ok({
          id: this.org.id,
          name: this.org.name,
          user: { id: token.userId, email: me?.email ?? "" },
        });
      case "issue":
        return this.ok(issue);
      case "patch": {
        const i = issue as FakeIssue;
        if (typeof body.state === "string") i.state = body.state;
        if (Array.isArray(body.tags)) i.tags = body.tags as string[];
        if (typeof body.assignee_id === "string") {
          const u = this.users.get(body.assignee_id);
          i.assignee = u ? { id: u.id, email: u.email } : null;
        }
        return this.ok(i);
      }
      case "search": {
        const accountId = JSON.stringify(body.filter ?? {}).match(
          /"field":"account_id","operator":"equals","value":"([^"]+)"/,
        )?.[1];
        const found = [...this.issues.values()].filter(
          (i) => !accountId || i.account?.id === accountId,
        );
        return Response.json({
          data: found,
          pagination: { cursor: "", has_next_page: false },
          request_id: randomUUID(),
        });
      }
      case "messages":
        return this.ok(
          this.messages
            .filter((m) => m.issueId === id)
            .map(({ issueId: _i, externalId: _e, ...m }) => ({
              ...m,
              author_unverified: false,
            })),
        );
      case "note": {
        const i = issue as FakeIssue;
        let thread = body.thread_id as string | undefined;
        if (body.message_id) {
          const parent = this.messages.find(
            (m) => m.id === body.message_id && m.is_private,
          );
          if (!parent)
            return this.error(400, "invalid_request", "no such internal note");
          thread = parent.thread_id;
        }
        const m = this.addMessage(i, {
          is_private: true,
          message_html: String(body.body_html),
          source: "api",
          thread_id: thread ?? `thr_${randomUUID().slice(0, 8)}`,
          author: {
            name: me?.name ?? "API",
            user: { id: token.userId, email: me?.email ?? "" },
          },
        });
        this.fire("Issue has a new message", i);
        return this.ok({ id: m.id, issue_id: i.id });
      }
      case "reply": {
        const i = issue as FakeIssue;
        const target = this.messages.find((m) => m.id === body.message_id);
        if (!target || target.is_private) {
          return this.error(
            400,
            "invalid_request",
            "message_id must name a customer-visible message",
          );
        }
        const ext = (body.custom_source as { external_id?: string } | undefined)
          ?.external_id;
        const again = ext
          ? this.messages.find((m) => m.externalId === ext)
          : undefined;
        if (again) return this.ok({ id: again.id, issue_id: i.id });
        const m = this.addMessage(i, {
          is_private: false,
          message_html: String(body.body_html),
          source: "api",
          author: {
            name: me?.name ?? "API",
            user: { id: token.userId, email: me?.email ?? "" },
          },
          ...(ext ? { externalId: ext } : {}),
        });
        this.fire("Issue has a new message", i);
        return this.ok({ id: m.id, issue_id: i.id });
      }
      case "draft": {
        const i = issue as FakeIssue;
        const userId = String(body.user_id ?? token.userId);
        const existing = this.drafts.find(
          (d) => d.issueId === i.id && d.userId === userId,
        );
        if (existing) {
          existing.body_html = String(body.body_html);
          return this.ok({
            id: existing.id,
            issue_id: i.id,
            status: "updated",
            updated_at: new Date().toISOString(),
            user_id: userId,
          });
        }
        const d: FakeDraft = {
          id: randomUUID(),
          issueId: i.id,
          userId,
          body_html: String(body.body_html),
        };
        this.drafts.push(d);
        return this.ok({
          id: d.id,
          issue_id: i.id,
          status: "created",
          updated_at: new Date().toISOString(),
          user_id: userId,
        });
      }
      case "account": {
        const a = this.accounts.get(id);
        return a ? this.ok(a) : this.error(404, "not_found", "no account");
      }
      case "contact": {
        const c = this.contacts.get(id);
        return c ? this.ok(c) : this.error(404, "not_found", "no contact");
      }
      default:
        return this.error(404, "not_found", "not an API endpoint");
    }
  }
}

/**
 * Start a Pylon fake.
 * @returns It, listening.
 */
export function startPylon(): FakePylon {
  return new FakePylon().start();
}
