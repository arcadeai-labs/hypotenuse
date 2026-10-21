/**
 * Questions for a person, and the queue that asks them one at a time.
 *
 * An agent asks in two ways that wait for an answer inside its turn:
 * `session/request_permission` under an `ask` policy, and ACP
 * `elicitation/create`. Each becomes a {@link Question}: the Linear
 * `elicitation` to post, how to read a reply, and what to answer if nobody
 * does. The {@link QuestionQueue} posts one question at a time (an agent
 * running tools in parallel can ask several), hands each reply to the
 * question at its head, and answers every pending one on cancel — the spec
 * requires that, and agents block otherwise.
 *
 * A reply that answers nothing (free text to a `select`) is not lost: the
 * question answers "rejected" or "declined", and the reply is reported
 * unconsumed, so the server queues it as the session's next prompt.
 */
import type { EventInput } from "../daemon/event-sink";
import type {
  CreateElicitationRequest,
  CreateElicitationResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "./connection";
import {
  type Choice,
  matchReply,
  permissionElicitation,
  rejectOption,
} from "./permissions";
import { truncate } from "./summarize";

/** A person's reply, as the server delivers it. */
export interface Reply {
  /** The inbound prompt activity it came from. */
  activityId: number;
  /** What they wrote. */
  body: string;
}

/** How a question read a reply. */
export interface Interpretation<A> {
  /** What to answer the agent. */
  answer: A;
  /** False when the reply was not an answer and is the next prompt instead. */
  consumed: boolean;
}

/** One question waiting on a person. */
export interface Question<A> {
  /** The elicitation to post. */
  event: EventInput;
  /**
   * Read a reply.
   * @param body - What the person wrote.
   */
  interpret(body: string): Interpretation<A>;
  /** The answer when the turn is cancelled. */
  cancelled(): A;
  /** The answer when the person moved on without answering. */
  declined(): A;
}

/**
 * A permission request, asked as a `select`.
 * @param request - The agent's request.
 * @param where - The repository, for the sentence.
 * @param cwd - The worktree.
 * @returns The question.
 */
export function permissionQuestion(
  request: RequestPermissionRequest,
  where: string,
  cwd: string,
): Question<RequestPermissionResponse> {
  const choices: Choice[] = request.options.map((o) => ({
    value: o.optionId,
    label: o.name,
    kind: o.kind,
  }));
  const declined = (): RequestPermissionResponse => {
    const reject = rejectOption(request.options);
    return reject
      ? { outcome: { outcome: "selected", optionId: reject } }
      : { outcome: { outcome: "cancelled" } };
  };
  return {
    event: permissionElicitation(request, where, cwd),
    interpret(body) {
      const chosen = matchReply(body, choices);
      if (chosen)
        return {
          answer: { outcome: { outcome: "selected", optionId: chosen } },
          consumed: true,
        };
      return { answer: declined(), consumed: false };
    },
    cancelled: () => ({ outcome: { outcome: "cancelled" } }),
    declined,
  };
}

/** One field of a form, as far as the host reads forms. */
interface FormField {
  name: string;
  type: string;
  title: string;
  description: string | null;
  choices: Choice[] | null;
  required: boolean;
}

/**
 * The fields of a form elicitation's schema.
 * @param request - The request.
 * @returns The fields, in schema order.
 */
function formFields(request: CreateElicitationRequest): FormField[] {
  const schema = (request as { requestedSchema?: Record<string, unknown> })
    .requestedSchema;
  const properties = (schema?.properties ?? {}) as Record<
    string,
    Record<string, unknown>
  >;
  const required = new Set((schema?.required as string[] | undefined) ?? []);
  return Object.entries(properties).map(([name, prop]) => {
    const oneOf = prop.oneOf as { const: string; title: string }[] | undefined;
    const enumValues = prop.enum as string[] | undefined;
    const choices = oneOf?.length
      ? oneOf.map((o) => ({ value: o.const, label: o.title || o.const }))
      : enumValues?.length
        ? enumValues.map((v) => ({ value: v, label: v }))
        : null;
    return {
      name,
      type: String(prop.type ?? "string"),
      title: String(prop.title ?? name),
      description: (prop.description as string | undefined) ?? null,
      choices,
      required: required.has(name),
    };
  });
}

/**
 * An agent's `elicitation/create`.
 * - `form` with a single enum field: a `select` over the enum.
 * - any other `form`: a plain elicitation describing the fields; a reply
 *   fills a form with exactly one string field, and is the next prompt for
 *   any other.
 * - `url`: an elicitation with the `auth` signal; the next reply accepts.
 * @param request - The request.
 * @param agentTitle - The agent's name, for an `auth` link.
 * @returns The question.
 */
export function elicitationQuestion(
  request: CreateElicitationRequest,
  agentTitle: string,
): Question<CreateElicitationResponse> {
  const message = truncate(
    request.message.trim() || "The agent has a question.",
    60_000,
  );
  const cancelled = (): CreateElicitationResponse => ({ action: "cancel" });
  const declined = (): CreateElicitationResponse => ({ action: "decline" });
  if (request.mode === "url") {
    const url = (request as { url: string }).url;
    let valid = true;
    try {
      new URL(url);
    } catch {
      valid = false;
    }
    return {
      event: valid
        ? {
            type: "elicitation",
            body: message,
            signal: "auth",
            signalMetadata: { url, providerName: truncate(agentTitle, 255) },
          }
        : { type: "elicitation", body: `${message}\n\n${url}` },
      interpret: () => ({ answer: { action: "accept" }, consumed: true }),
      cancelled,
      declined,
    };
  }
  const fields = request.mode === "form" ? formFields(request) : [];
  const only = fields.length === 1 ? fields[0] : undefined;
  if (only?.choices?.length) {
    const choices = only.choices.slice(0, 25);
    return {
      event: {
        type: "elicitation",
        body: message,
        signal: "select",
        signalMetadata: {
          options: choices.map((c) => ({
            label: truncate(c.label, 255),
            value: truncate(c.value, 1024),
          })),
        },
      },
      interpret(body) {
        const chosen = matchReply(body, choices);
        return chosen
          ? {
              answer: { action: "accept", content: { [only.name]: chosen } },
              consumed: true,
            }
          : { answer: declined(), consumed: false };
      },
      cancelled,
      declined,
    };
  }
  const described = fields.length
    ? `${message}\n\n${fields
        .map(
          (f) =>
            `- **${f.title}**${f.required ? "" : " (optional)"} — ${f.type}${f.choices ? `: one of ${f.choices.map((c) => `\`${c.value}\``).join(", ")}` : ""}${f.description ? `. ${f.description}` : ""}`,
        )
        .join("\n")}`
    : message;
  return {
    event: { type: "elicitation", body: truncate(described, 60_000) },
    interpret(body) {
      if (only && only.type === "string" && !only.choices) {
        return {
          answer: { action: "accept", content: { [only.name]: body.trim() } },
          consumed: true,
        };
      }
      return { answer: declined(), consumed: false };
    },
    cancelled,
    declined,
  };
}

/** A question in the queue, with how to settle it. */
interface Entry {
  question: Question<unknown>;
  resolve(answer: unknown): void;
  asked: boolean;
}

/** What the queue does when it asks or is answered. */
export interface QueueHooks {
  /** Post a question's elicitation. */
  post(event: EventInput): void;
  /** Called when the first question starts waiting and when the last is answered. */
  waiting(waiting: boolean): void;
}

/** The questions a turn has open, asked one at a time. */
export class QuestionQueue {
  private readonly entries: Entry[] = [];
  private closed = false;

  /**
   * @param hooks - Posting and the waiting flag.
   */
  constructor(private readonly hooks: QueueHooks) {}

  /** Whether a question is waiting on a person. */
  get waiting(): boolean {
    return this.entries.length > 0;
  }

  /**
   * Ask a question; resolves with the agent's answer.
   * @param question - The question.
   * @returns The answer.
   */
  ask<A>(question: Question<A>): Promise<A> {
    if (this.closed) return Promise.resolve(question.cancelled());
    return new Promise<A>((resolve) => {
      this.entries.push({
        question: question as Question<unknown>,
        resolve: resolve as (answer: unknown) => void,
        asked: false,
      });
      if (this.entries.length === 1) this.hooks.waiting(true);
      this.askHead();
    });
  }

  /**
   * Hand a person's reply to the question at the head.
   * @param reply - The reply.
   * @returns Whether it answered the question (false: it is the next prompt), or null with nothing waiting.
   */
  deliver(reply: Reply): boolean | null {
    const head = this.entries[0];
    if (!head) return null;
    const { answer, consumed } = head.question.interpret(reply.body);
    this.entries.shift();
    head.resolve(answer);
    if (!consumed) {
      // Free text: the person moved on. Every other open question is
      // declined with it, and the text becomes the next prompt.
      for (const entry of this.entries.splice(0))
        entry.resolve(entry.question.declined());
      this.hooks.waiting(false);
      return false;
    }
    if (this.entries.length === 0) this.hooks.waiting(false);
    else this.askHead();
    return true;
  }

  /** Answer every open question as cancelled, and refuse new ones. */
  cancelAll(): void {
    this.closed = true;
    this.settleAll();
  }

  /** Answer every open question with its cancel answer. */
  private settleAll(): void {
    const open = this.entries.splice(0);
    for (const entry of open) entry.resolve(entry.question.cancelled());
    if (open.length) this.hooks.waiting(false);
  }

  /** Post the head question if it has not been posted. */
  private askHead(): void {
    const head = this.entries[0];
    if (!head || head.asked) return;
    head.asked = true;
    this.hooks.post(head.question.event);
  }
}
