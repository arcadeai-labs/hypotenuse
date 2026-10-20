import type { AgentRole, AgentSessionStatus, CapacitySegment, RunnerPresence } from "../ui";

/** A session row as the session list renders it. */
export interface FixtureSession {
  identifier: string;
  title: string;
  status: AgentSessionStatus;
  role: AgentRole;
  agent: string;
  runner: string;
}

/** The session list, grouped the way the list view groups it: waiting first. */
export const FIXTURE_SESSION_GROUPS: Array<{ title: string; sessions: FixtureSession[] }> = [
  {
    title: "Waiting for you",
    sessions: [
      {
        identifier: "ENG-139",
        title: "PRD: Billing v2",
        status: "awaitingInput",
        role: "manager",
        agent: "claude",
        runner: "evan-mbp",
      },
    ],
  },
  {
    title: "Running",
    sessions: [
      {
        identifier: "ENG-142",
        title: "Add retry to webhook ingress",
        status: "active",
        role: "worker",
        agent: "codex",
        runner: "ci-box-2",
      },
      {
        identifier: "ENG-151",
        title: "Fix flaky invite test",
        status: "active",
        role: "worker",
        agent: "claude",
        runner: "evan-mbp",
      },
      {
        identifier: "ENG-155",
        title: "Rename the routing table",
        status: "stopping",
        role: "worker",
        agent: "codex",
        runner: "mia-desk",
      },
    ],
  },
  {
    title: "Done today",
    sessions: [
      {
        identifier: "ENG-120",
        title: "Paginate audit list",
        status: "complete",
        role: "worker",
        agent: "codex",
        runner: "mia-desk",
      },
      {
        identifier: "ENG-118",
        title: "Upgrade the ACP client",
        status: "error",
        role: "worker",
        agent: "gemini",
        runner: "ci-box-2",
      },
    ],
  },
];

/** One transcript entry, in the order the log renders them. */
export type FixtureTranscriptEntry =
  | { kind: "turn"; turn: number; runner: string; agent: string; role: AgentRole; duration: string; outcome: string }
  | { kind: "prompt"; author: string; body: string }
  | { kind: "thought"; body: string }
  | { kind: "action"; verb: string; parameter: string; duration?: string; added?: number; removed?: number; ephemeral?: boolean }
  | { kind: "plan"; steps: Array<{ title: string; status: AgentSessionStatus }> }
  | { kind: "elicitation"; body: string; options: string[] }
  | { kind: "response"; body: string }
  | { kind: "error"; body: string };

/** A transcript with one of every entry kind. */
export const FIXTURE_TRANSCRIPT: FixtureTranscriptEntry[] = [
  { kind: "turn", turn: 1, runner: "evan-mbp", agent: "codex", role: "worker", duration: "6m 12s", outcome: "Active" },
  { kind: "prompt", author: "Evan Tahler", body: "@hypotenuse please take this" },
  { kind: "response", body: "Picked up on evan-mbp. Working in `hypotenuse/eng-142-add-retry`." },
  {
    kind: "plan",
    steps: [
      { title: "Read the ingress handler", status: "complete" },
      { title: "Add exponential backoff", status: "active" },
      { title: "Write tests", status: "pending" },
    ],
  },
  { kind: "action", verb: "Searched", parameter: "backend/actions/webhooks/**", duration: "0.4s" },
  { kind: "action", verb: "Edited", parameter: "backend/ops/LinearWebhookOps.ts", added: 12, removed: 3 },
  { kind: "thought", body: "The retry should key on the Linear-Delivery header so a redelivery is not processed twice." },
  { kind: "elicitation", body: "Allow `bun test` to run?", options: ["Allow once", "Deny"] },
  {
    kind: "error",
    body: "The test run timed out after 10 minutes. Raise `timeouts.turn` in the runner config, or split the suite.",
  },
  { kind: "turn", turn: 2, runner: "evan-mbp", agent: "codex", role: "worker", duration: "1m 04s", outcome: "Complete" },
  {
    kind: "response",
    body: "Opened **PR #418**: retries webhook ingress with exponential backoff.\n\n- 3 attempts, capped at 30s\n- keyed on `Linear-Delivery`",
  },
  { kind: "action", verb: "Running", parameter: "bun test", ephemeral: true },
];

/** A runner as the fleet view renders it. */
export interface FixtureRunner {
  name: string;
  owner: string;
  presence: RunnerPresence;
  version: string;
  updateAvailable: boolean;
  slots: CapacitySegment[];
  agents: string[];
  roles: AgentRole[];
  repositories: string[];
  heartbeat: string;
}

/** A small fleet: busy, draining, and offline. */
export const FIXTURE_RUNNERS: FixtureRunner[] = [
  {
    name: "evan-mbp",
    owner: "Evan Tahler",
    presence: "online",
    version: "1.4.0",
    updateAvailable: false,
    slots: [
      { state: "busy", label: "ENG-142", href: "#ENG-142" },
      { state: "busy", label: "ENG-139", href: "#ENG-139" },
      { state: "free" },
    ],
    agents: ["claude", "codex"],
    roles: ["manager", "worker"],
    repositories: ["acme/web", "acme/api"],
    heartbeat: "4s ago",
  },
  {
    name: "ci-box-2",
    owner: "Mia Chen",
    presence: "draining",
    version: "1.3.2",
    updateAvailable: true,
    slots: [{ state: "busy", label: "ENG-151", href: "#ENG-151" }, { state: "free" }],
    agents: ["codex", "gemini"],
    roles: ["worker"],
    repositories: ["acme/web"],
    heartbeat: "2s ago",
  },
  {
    name: "mia-desk",
    owner: "Mia Chen",
    presence: "offline",
    version: "1.4.0",
    updateAvailable: false,
    slots: [{ state: "stale", label: "ENG-155", href: "#ENG-155" }, { state: "free" }],
    agents: ["claude"],
    roles: ["worker"],
    repositories: ["acme/api"],
    heartbeat: "12m ago",
  },
];
