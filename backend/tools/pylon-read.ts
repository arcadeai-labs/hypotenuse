import { z } from "zod";
import { pylonHtmlToText } from "../ops/PylonMarkdownOps";
import {
  type PylonAccount,
  type PylonIssue,
  pylonMessages,
  pylonRequest,
} from "../ops/PylonOps";
import {
  isPylonConversation,
  pylonScope,
  pylonToolError,
} from "./pylon-shared";
import { type ToolDefinition, ToolError } from "./types";

/**
 * The read-only Pylon tools — the issue being worked, its customer, the
 * customer's other issues, and a contact of the customer. Each is scoped by
 * the conversation (`pylon-shared.ts`): the issue and the account come from
 * the conversation's row, so a bot working customer A's issue cannot read
 * customer B's records. Replay-safe, offered only in a Pylon conversation.
 */

/** The longest text of one message or body shown. */
const TEXT_MAX = 6_000;

/**
 * Cut text to {@link TEXT_MAX}.
 * @param s - The text.
 * @returns It, cut.
 */
function cut(s: string): string {
  return s.length > TEXT_MAX ? `${s.slice(0, TEXT_MAX)}…` : s;
}

const issueViewOutput = z.object({
  id: z.string(),
  number: z.number().nullable(),
  title: z.string(),
  state: z.string().nullable(),
  link: z.string().nullable(),
  tags: z.array(z.string()),
  requesterEmail: z.string().nullable(),
  body: z.string(),
  messages: z.array(
    z.object({
      id: z.string(),
      internal: z.boolean(),
      author: z.string(),
      from: z.enum(["customer", "team"]),
      at: z.string().nullable(),
      text: z.string(),
    }),
  ),
});

/**
 * `pylon_issue_view` — the issue this conversation is about: its title,
 * state, tags, requester, body, and every message and internal note, oldest
 * first.
 */
export const pylonIssueView: ToolDefinition<
  Record<string, never>,
  z.infer<typeof issueViewOutput>
> = {
  name: "pylon_issue_view",
  description:
    "Read the Pylon issue you are working: its title, state, tags, requester, body, and every customer message and internal note, oldest first. `internal: true` marks a note only the support team sees.",
  inputSchema: z.object({}) as unknown as z.ZodType<Record<string, never>>,
  outputSchema: issueViewOutput,
  replay: "safe",
  parallelSafe: true,
  available: (ctx) => isPylonConversation(ctx),
  run: async (_args, ctx) => {
    const scope = await pylonScope(ctx);
    try {
      const issue = await pylonRequest<PylonIssue>(
        scope.inst,
        "GET",
        `/issues/${encodeURIComponent(scope.issueId)}`,
      );
      const messages = await pylonMessages(scope.inst, scope.issueId);
      return {
        id: issue.id,
        number: issue.number ?? null,
        title: issue.title ?? "",
        state: issue.state ?? null,
        link: issue.link ?? null,
        tags: issue.tags ?? [],
        requesterEmail: issue.requester?.email ?? null,
        body: cut(pylonHtmlToText(issue.body_html)),
        messages: messages.map((m) => ({
          id: m.id,
          internal: m.is_private,
          author: m.author?.name ?? "unknown",
          from: m.author?.contact ? ("customer" as const) : ("team" as const),
          at: m.timestamp ?? null,
          text: cut(pylonHtmlToText(m.message_html)),
        })),
      };
    } catch (e) {
      throw pylonToolError(e, "show the issue");
    }
  },
};

const accountOutput = z.object({
  id: z.string(),
  name: z.string(),
  domains: z.array(z.string()),
  tags: z.array(z.string()),
});

/**
 * The account a scope may read, or a refusal.
 * @param accountId - The scope's account.
 * @returns It.
 * @throws {ToolError} When the issue has no account.
 */
function requireAccount(accountId: string | null): string {
  if (!accountId) {
    throw new ToolError(
      "no_account",
      "This issue belongs to no customer account in Pylon.",
      "Work from the issue itself.",
    );
  }
  return accountId;
}

/**
 * `pylon_account_view` — the customer company this issue belongs to.
 */
export const pylonAccountView: ToolDefinition<
  Record<string, never>,
  z.infer<typeof accountOutput>
> = {
  name: "pylon_account_view",
  description:
    "Read the customer account (the company) this Pylon issue belongs to: its name, domains, and tags.",
  inputSchema: z.object({}) as unknown as z.ZodType<Record<string, never>>,
  outputSchema: accountOutput,
  replay: "safe",
  parallelSafe: true,
  available: (ctx) => isPylonConversation(ctx),
  run: async (_args, ctx) => {
    const scope = await pylonScope(ctx);
    const accountId = requireAccount(scope.accountId);
    try {
      const a = await pylonRequest<PylonAccount>(
        scope.inst,
        "GET",
        `/accounts/${encodeURIComponent(accountId)}`,
      );
      return {
        id: a.id,
        name: a.name ?? "",
        domains: a.domains ?? (a.domain ? [a.domain] : []),
        tags: a.tags ?? [],
      };
    } catch (e) {
      throw pylonToolError(e, "show the account");
    }
  },
};

const accountIssuesInput = z.object({
  state: z
    .string()
    .max(100)
    .optional()
    .describe("Only issues in this state, e.g. closed or waiting_on_you"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(20)
    .describe("How many, newest first"),
});

const accountIssuesOutput = z.object({
  issues: z.array(
    z.object({
      id: z.string(),
      number: z.number().nullable(),
      title: z.string(),
      state: z.string().nullable(),
      link: z.string().nullable(),
    }),
  ),
});

/**
 * `pylon_account_issues` — the customer's other issues.
 */
export const pylonAccountIssues: ToolDefinition<
  z.infer<typeof accountIssuesInput>,
  z.infer<typeof accountIssuesOutput>
> = {
  name: "pylon_account_issues",
  description:
    "List this customer's Pylon issues (titles, states, links), to see what they asked before. Read one with its link only through the team; you can read in full only the issue you are working.",
  inputSchema: accountIssuesInput,
  outputSchema: accountIssuesOutput,
  replay: "safe",
  parallelSafe: true,
  available: (ctx) => isPylonConversation(ctx),
  run: async (args, ctx) => {
    const scope = await pylonScope(ctx);
    const accountId = requireAccount(scope.accountId);
    const subfilters: Record<string, unknown>[] = [
      { field: "account_id", operator: "equals", value: accountId },
    ];
    if (args.state) {
      subfilters.push({
        field: "state",
        operator: "equals",
        value: args.state,
      });
    }
    try {
      const found = await pylonRequest<PylonIssue[]>(
        scope.inst,
        "POST",
        "/issues/search",
        {
          filter: { operator: "and", subfilters },
          limit: args.limit ?? 20,
        },
      );
      return {
        issues: found.map((i) => ({
          id: i.id,
          number: i.number ?? null,
          title: i.title ?? "",
          state: i.state ?? null,
          link: i.link ?? null,
        })),
      };
    } catch (e) {
      throw pylonToolError(e, "list the customer's issues");
    }
  },
};

const contactInput = z.object({
  contactId: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe("The contact's Pylon id, e.g. the requester's"),
});

const contactOutput = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().nullable(),
});

/**
 * `pylon_contact_view` — a person at this customer. A contact of another
 * account is refused.
 */
export const pylonContactView: ToolDefinition<
  z.infer<typeof contactInput>,
  z.infer<typeof contactOutput>
> = {
  name: "pylon_contact_view",
  description:
    "Read a contact (a person at this issue's customer) by id: their name and email. Only contacts of this issue's account.",
  inputSchema: contactInput,
  outputSchema: contactOutput,
  replay: "safe",
  parallelSafe: true,
  available: (ctx) => isPylonConversation(ctx),
  run: async (args, ctx) => {
    const scope = await pylonScope(ctx);
    let contact: {
      id: string;
      name?: string;
      email?: string;
      account?: { id: string } | null;
    };
    try {
      contact = await pylonRequest(
        scope.inst,
        "GET",
        `/contacts/${encodeURIComponent(args.contactId)}`,
      );
    } catch (e) {
      throw pylonToolError(e, "show the contact");
    }
    if (!scope.accountId || contact.account?.id !== scope.accountId) {
      throw new ToolError(
        "other_account",
        "That contact does not belong to this issue's customer.",
        "Read only contacts of the customer whose issue you are working.",
      );
    }
    return {
      id: contact.id,
      name: contact.name ?? "",
      email: contact.email ?? null,
    };
  },
};
