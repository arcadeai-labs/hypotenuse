import type {
  ConversationStatus,
  Platform,
  SandboxJobState,
} from "../../../../design/states";

/**
 * The shapes the signature surfaces draw. They are the surfaces' own props,
 * not the server's rows: when conversations, bots, and memory exist, a page
 * maps what the server answers onto these, and the components do not change.
 */

/** One row of a conversation list. */
export interface ConversationSummary {
  id: number;
  platform: Platform;
  /** The channel as the platform names it: `#billing`, `ENG`, `Globex`. */
  channel: string;
  /** The thread's own name: the first message, the issue title. */
  title: string;
  /** The platform's short id, when it has one (`ENG-142`). */
  identifier?: string;
  status: ConversationStatus;
  bot: string;
}

/** One host call a `run_code` program made. */
export interface CodeCall {
  call: string;
  duration: string;
}

/** One line of a conversation transcript, in the order it was written. */
export type TranscriptEntry =
  | { kind: "message"; author: string; platform: Platform; body: string }
  | { kind: "bot"; bot: string; body: string }
  | { kind: "thinking"; body: string }
  | {
      kind: "tool";
      verb: string;
      parameter: string;
      duration?: string;
      /** A call whose intent is written and whose result is not, yet. */
      running?: boolean;
    }
  | {
      kind: "code";
      program: string;
      calls: CodeCall[];
      duration: string;
    }
  | {
      kind: "sandbox";
      state: SandboxJobState;
      repository: string;
      branch: string;
      steps: Array<{ verb: string; parameter: string; duration?: string }>;
      pullRequest?: { title: string; href: string };
    }
  | {
      kind: "question";
      body: string;
      options: string[];
      platform: Platform;
      /** The thread, session, or issue the question was asked in. */
      href: string;
    }
  | {
      kind: "approval";
      tool: string;
      parameter: string;
      platform: Platform;
      href: string;
    }
  | { kind: "error"; body: string };

/** What a bot page shows. */
export interface BotProfile {
  name: string;
  avatar?: string;
  persona: string;
  /** Where it listens, by platform. */
  bindings: Array<{ platform: Platform; channel: string }>;
  tools: {
    memory: boolean;
    mcpServers: string[];
    skills: string[];
    codeMode: boolean;
    sandboxes: boolean;
  };
  /** The registry name the bot runs on, and the connection behind it. */
  model: { name: string; connection: string };
  accessRead: string[];
  accessWrite: string[];
}

/** One version of a memory document. */
export interface MemoryVersion {
  version: number;
  written: string;
  /** Who wrote it, and the conversation entry it came from. */
  bot: string;
  provenance: { label: string; href: string };
  /** Promoted from a channel to the project, and from which. */
  promotedFrom?: string;
}

/** One memory document in a scope. */
export interface MemoryDocument {
  id: number;
  title: string;
  /** How much of its weight it still carries, 0–1; disuse lowers it. */
  freshness: number;
  versions: MemoryVersion[];
}

/** A memory scope: the project, or one channel. */
export interface MemoryScope {
  id: string;
  label: string;
  platform?: Platform;
  documents: MemoryDocument[];
}
