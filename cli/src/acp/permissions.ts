/**
 * How the daemon answers an agent's `session/request_permission`: by the
 * role's `permission_policy` — `allow`, `deny`, or `ask` the person in Linear
 * — optionally refined per ACP tool kind. `ask` posts a `select` elicitation
 * whose options are the agent's, and {@link matchReply} reads the person's
 * reply back into one of them.
 */
import type { POLICIES, TOOL_KINDS } from "../config/schema";
import type { EventInput } from "../daemon/event-sink";
import type { PermissionOption, RequestPermissionRequest } from "./connection";
import { compactParameter, type ToolCallState, truncate } from "./summarize";

/** A role's policy, as the config file gives it. */
export type PermissionPolicy =
  | (typeof POLICIES)[number]
  | Partial<
      Record<"default" | (typeof TOOL_KINDS)[number], (typeof POLICIES)[number]>
    >;

/** What to do with one request. */
export type PolicyDecision = (typeof POLICIES)[number];

/** Words that mean "allow it once". */
const YES = new Set([
  "y",
  "yes",
  "yep",
  "yeah",
  "allow",
  "allowed",
  "ok",
  "okay",
  "sure",
  "approve",
  "approved",
  "go",
  "go ahead",
  "do it",
  "proceed",
  "👍",
]);

/** Words that mean "reject it once". */
const NO = new Set([
  "n",
  "no",
  "nope",
  "deny",
  "denied",
  "reject",
  "don't",
  "dont",
  "do not",
  "stop",
  "cancel",
  "👎",
]);

/**
 * The decision for a request.
 * @param policy - The role's policy.
 * @param kind - The tool call's kind, if the agent said.
 * @returns allow, ask, or deny.
 */
export function decide(
  policy: PermissionPolicy,
  kind: string | null | undefined,
): PolicyDecision {
  if (typeof policy === "string") return policy;
  const byKind = kind
    ? (policy as Record<string, PolicyDecision>)[kind]
    : undefined;
  return byKind ?? policy.default ?? "allow";
}

/** The answer a read-only session's file writes get. */
export const READ_ONLY_MESSAGE = "this session is read-only";

/**
 * Whether a policy makes the session read-only: it refuses `edit` without
 * asking, so a file write through the daemon must be refused too.
 * @param policy - The role's policy.
 * @returns True when edits are denied.
 */
export function isReadOnly(policy: PermissionPolicy): boolean {
  return decide(policy, "edit") === "deny";
}

/**
 * The option a policy picks without asking.
 * @param options - The agent's options.
 * @param decision - allow or deny.
 * @returns The option id, or null when the agent offered none of that kind.
 */
export function automaticOption(
  options: readonly PermissionOption[],
  decision: "allow" | "deny",
): string | null {
  // Never allow_always when allow_once exists: a session-wide grant would
  // outlive the person's view of it.
  const order =
    decision === "allow"
      ? ["allow_once", "allow_always"]
      : ["reject_once", "reject_always"];
  for (const kind of order) {
    const found = options.find((o) => o.kind === kind);
    if (found) return found.optionId;
  }
  return null;
}

/**
 * The `reject_once` option (else `reject_always`), for a reply that chose
 * nothing.
 * @param options - The agent's options.
 * @returns The option id, or null.
 */
export function rejectOption(
  options: readonly PermissionOption[],
): string | null {
  return automaticOption(options, "deny");
}

/**
 * The `select` elicitation that asks a person.
 * @param request - The permission request.
 * @param where - The repository (or directory) for the sentence.
 * @param cwd - The worktree, for relative paths.
 * @returns The event.
 */
export function permissionElicitation(
  request: RequestPermissionRequest,
  where: string,
  cwd: string,
): EventInput {
  const call: ToolCallState = {
    toolCallId: request.toolCall.toolCallId,
    title: request.toolCall.title ?? "",
    kind: request.toolCall.kind ?? null,
    status: "pending",
    rawInput: request.toolCall.rawInput,
    rawOutput: undefined,
    content: request.toolCall.content ?? [],
    locations: request.toolCall.locations ?? [],
  };
  const what = describeCall(call, cwd);
  return {
    type: "elicitation",
    body: `The agent wants to ${what} in ${where}. Allow it?`,
    signal: "select",
    signalMetadata: {
      options: request.options.slice(0, 25).map((o) => ({
        label: truncate(o.name.trim() || o.optionId, 255),
        value: truncate(o.optionId, 1024),
      })),
    },
  };
}

/**
 * A tool call as the middle of a sentence: "run `rm -rf build/`".
 * @param call - The call.
 * @param cwd - The worktree.
 * @returns The phrase.
 */
function describeCall(call: ToolCallState, cwd: string): string {
  const parameter = compactParameter(call, cwd).replace(/`/g, "'");
  switch (call.kind) {
    case "execute":
      return `run \`${parameter}\``;
    case "edit":
      return `edit \`${parameter}\``;
    case "delete":
      return `delete \`${parameter}\``;
    case "move":
      return `move \`${parameter}\``;
    case "read":
      return `read \`${parameter}\``;
    case "fetch":
      return `fetch \`${parameter}\``;
    case "search":
      return `search for \`${parameter}\``;
    default:
      return `use ${call.title.trim() ? `\`${call.title.trim().replace(/`/g, "'")}\`` : "a tool"}`;
  }
}

/** One choice a person can make, as `matchReply` reads it. */
export interface Choice {
  /** What is answered when it is chosen. */
  value: string;
  /** What the person saw. */
  label: string;
  /** For a permission option: its kind, for yes/no words. */
  kind?: PermissionOption["kind"];
}

/**
 * Normalize a reply for comparison.
 * @param text - The reply.
 * @returns Lowercased, trimmed, outer punctuation and quotes removed.
 */
function normal(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/^[\s"'`*_.!?,]+|[\s"'`*_.!?,]+$/g, "")
    .replace(/\s+/g, " ");
}

/**
 * Read a person's reply as one of the choices: an exact value, then an exact
 * label (case-insensitive, trimmed), then a 1-based number, then yes/no words
 * (allow once / reject once). Anything else is free text.
 * @param reply - What the person wrote.
 * @param choices - The choices, in the order shown.
 * @returns The chosen value, or null for free text.
 */
export function matchReply(
  reply: string,
  choices: readonly Choice[],
): string | null {
  const trimmed = reply.trim();
  const exact = choices.find((c) => c.value === trimmed);
  if (exact) return exact.value;
  const said = normal(reply);
  if (!said) return null;
  const byLabel = choices.find((c) => normal(c.label) === said);
  if (byLabel) return byLabel.value;
  if (/^\d+$/.test(said)) {
    const index = Number(said) - 1;
    return choices[index]?.value ?? null;
  }
  const yes = YES.has(said);
  const no = NO.has(said);
  if (yes || no) {
    const kinds = yes
      ? ["allow_once", "allow_always"]
      : ["reject_once", "reject_always"];
    for (const kind of kinds) {
      const found = choices.find((c) => c.kind === kind);
      if (found) return found.value;
    }
  }
  return null;
}
