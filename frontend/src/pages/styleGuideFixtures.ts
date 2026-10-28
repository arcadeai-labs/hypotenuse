import type {
  BotProfile,
  ConversationSummary,
  MemoryScope,
  TranscriptEntry,
} from "../components/surfaces/types";

/**
 * Fixture data for `/style-guide`: one of every surface a project shows, so
 * each component is seen in both themes before any page reads real rows.
 */

/** A conversation list with every state in it. */
export const FIXTURE_CONVERSATIONS: ConversationSummary[] = [
  {
    id: 1,
    platform: "slack",
    channel: "#billing",
    title: "Refund for Globex?",
    status: { state: "waiting", waitingOn: "approval" },
    bot: "Ada",
  },
  {
    id: 2,
    platform: "pylon",
    channel: "Initech",
    title: "Which plan includes SSO?",
    status: { state: "waiting", waitingOn: "answer" },
    bot: "Ada",
  },
  {
    id: 3,
    platform: "linear",
    channel: "ENG",
    identifier: "ENG-142",
    title: "Add retry to webhook ingress",
    status: { state: "working" },
    bot: "Kit",
  },
  {
    id: 4,
    platform: "pylon",
    channel: "Globex",
    title: "Export fails on CSV",
    status: { state: "waiting", waitingOn: "sandbox" },
    bot: "Ada",
  },
  {
    id: 5,
    platform: "slack",
    channel: "#standup",
    title: "Post the weekly digest",
    status: { state: "waiting", waitingOn: "timer" },
    bot: "Kit",
  },
  {
    id: 6,
    platform: "slack",
    channel: "#eng-help",
    title: "How do I run e2e?",
    status: { state: "hibernating" },
    bot: "Kit",
  },
  {
    id: 7,
    platform: "api",
    channel: "api",
    title: "Summarize last week's incidents",
    status: { state: "ended", outcome: "complete" },
    bot: "Kit",
  },
  {
    id: 8,
    platform: "linear",
    channel: "ENG",
    identifier: "ENG-139",
    title: "Upgrade the queue client",
    status: { state: "ended", outcome: "failed" },
    bot: "Kit",
  },
];

/** A transcript with one of every entry kind. */
export const FIXTURE_TRANSCRIPT: TranscriptEntry[] = [
  {
    kind: "message",
    author: "Grace Hopper",
    platform: "linear",
    body: "Webhook ingress drops deliveries when Redis blips. Can you add a retry?",
  },
  {
    kind: "thinking",
    body: "the enqueue after the trigger_events insert is the only call that can fail on a Redis blip",
  },
  {
    kind: "tool",
    verb: "memory_search",
    parameter: "webhook retry",
    duration: "0.2s",
  },
  {
    kind: "code",
    program:
      'const runs = await mcp.call("github", "list_runs", { branch: "main" });\nreturn runs.filter((r) => r.status === "failure").length;',
    calls: [{ call: 'mcp.call("github", "list_runs")', duration: "0.8s" }],
    duration: "1.1s",
  },
  {
    kind: "approval",
    tool: "mcp_exec",
    parameter: 'github.create_branch { name: "kit/eng-142-retry" }',
    platform: "linear",
    href: "#linear-session",
  },
  {
    kind: "sandbox",
    state: "running",
    repository: "acme/api",
    branch: "kit/eng-142-retry",
    steps: [
      {
        verb: "Read",
        parameter: "backend/actions/webhooks.ts",
        duration: "0.1s",
      },
      {
        verb: "Edit",
        parameter: "backend/ops/IngressOps.ts",
        duration: "0.4s",
      },
      { verb: "Run", parameter: "bun run test", duration: "41s" },
    ],
  },
  {
    kind: "tool",
    verb: "sandbox_status",
    parameter: "job 31",
    running: true,
  },
  {
    kind: "question",
    body: "Should a delivery that fails three times **page** someone, or only land in the failed queue?",
    options: ["Page on-call", "Failed queue only"],
    platform: "linear",
    href: "#linear-session",
  },
  {
    kind: "message",
    author: "Grace Hopper",
    platform: "linear",
    body: "Failed queue only.",
  },
  {
    kind: "sandbox",
    state: "complete",
    repository: "acme/api",
    branch: "kit/eng-142-retry",
    steps: [{ verb: "Push", parameter: "kit/eng-142-retry", duration: "2s" }],
    pullRequest: {
      title: "Retry the enqueue after a webhook is recorded",
      href: "#pull-request",
    },
  },
  {
    kind: "bot",
    bot: "Kit",
    body: "Opened **Retry the enqueue after a webhook is recorded**. A delivery that fails three times lands in the failed queue; nothing pages.",
  },
  {
    kind: "error",
    body: "The model connection answered 429 twice; the turn failed. Ask again to retry.",
  },
];

/** A bot with a binding on every platform but one. */
export const FIXTURE_BOT: BotProfile = {
  name: "Ada",
  persona:
    "Answers billing and account questions for the support team, and files what she cannot answer.",
  bindings: [
    { platform: "slack", channel: "#billing" },
    { platform: "slack", channel: "#support" },
    { platform: "pylon", channel: "All accounts" },
    { platform: "api", channel: "HTTP API" },
  ],
  tools: {
    memory: true,
    mcpServers: ["stripe", "github"],
    skills: ["refund-policy", "escalate"],
    codeMode: true,
    sandboxes: false,
  },
  model: { name: "support-default", connection: "Anthropic" },
  accessRead: ["support", "admin"],
  accessWrite: ["admin"],
};

/** The project's memory and two channels'. */
export const FIXTURE_MEMORY: MemoryScope[] = [
  {
    id: "project",
    label: "Project",
    documents: [
      {
        id: 1,
        title: "Refunds over $500 need a manager",
        freshness: 0.92,
        versions: [
          {
            version: 2,
            written: "Oct 21",
            bot: "Ada",
            provenance: { label: "#billing · entry 412", href: "#entry-412" },
            promotedFrom: "#billing",
          },
          {
            version: 1,
            written: "Sep 30",
            bot: "Ada",
            provenance: { label: "#billing · entry 88", href: "#entry-88" },
          },
        ],
      },
      {
        id: 2,
        title: "Staging lives at api.hypotenuse.cloud",
        freshness: 0.55,
        versions: [
          {
            version: 1,
            written: "Oct 2",
            bot: "Kit",
            provenance: { label: "ENG-120 · entry 19", href: "#entry-19" },
          },
        ],
      },
    ],
  },
  {
    id: "slack-billing",
    label: "#billing",
    platform: "slack",
    documents: [
      {
        id: 3,
        title: "Globex is on the annual plan",
        freshness: 0.21,
        versions: [
          {
            version: 1,
            written: "Aug 14",
            bot: "Ada",
            provenance: { label: "#billing · entry 7", href: "#entry-7" },
          },
        ],
      },
    ],
  },
  {
    id: "linear-eng",
    label: "ENG",
    platform: "linear",
    documents: [],
  },
];
