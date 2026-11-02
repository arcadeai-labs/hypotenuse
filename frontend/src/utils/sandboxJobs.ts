import type { ProjectSettingsView } from "@backend/actions/project/project-settings-view";
import type { SandboxJobEvents } from "@backend/actions/sandbox-job/sandbox-job-events";
import type { SandboxJobList } from "@backend/actions/sandbox-job/sandbox-job-list";
import type { SandboxJobView } from "@backend/actions/sandbox-job/sandbox-job-view";
import type { ActionResponse } from "keryx";
import type { GlyphKind } from "../../../design/states";

/** One row of `sandbox-job:list`: the job and its bot. */
export type SandboxJobRow =
  ActionResponse<SandboxJobList>["sandboxJobs"][number];

/** `sandbox-job:view`'s answer. */
export type SandboxJobDetail = ActionResponse<SandboxJobView>;

/** One question a job's coding agent asked. */
export type SandboxJobQuestion = SandboxJobDetail["questions"][number];

/** One event of a job's transcript. */
export type SandboxJobEvent =
  ActionResponse<SandboxJobEvents>["events"][number];

/** A project's settings, as `project:settings-view` answers them. */
export type ProjectSettings = ActionResponse<ProjectSettingsView>["settings"];

/** Every status a job can be in, as the server names them. */
export type SandboxJobStatus = SandboxJobRow["status"];

/** The statuses a job is still alive in: it can be cancelled. */
const LIVE_STATUSES: readonly string[] = [
  "pending",
  "provisioning",
  "running",
  "awaiting_input",
];

/**
 * Whether a job is still alive: not yet started, starting, working, or
 * between an interactive job's turns.
 * @param status - The job's status.
 * @returns `true` until the job has ended.
 */
export function isLiveJob(status: string): boolean {
  return LIVE_STATUSES.includes(status);
}

/**
 * A job's status, as a person reads it.
 * @param status - The server's status.
 * @returns The words.
 */
export function jobStatusLabel(status: string): string {
  switch (status) {
    case "pending":
      return "Queued";
    case "provisioning":
      return "Starting";
    case "running":
      return "Running";
    case "awaiting_input":
      return "Waiting for a follow-up";
    case "succeeded":
      return "Succeeded";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    case "timed_out":
      return "Timed out";
    case "expired":
      return "Expired";
    default:
      return status;
  }
}

/**
 * The glyph a job's status is drawn with. Rings are in progress, discs are
 * finished; a job a person stopped, or one that sat idle until it expired,
 * is over but not an error, so it reads faded rather than red.
 * @param status - The server's status.
 * @returns The glyph kind.
 */
export function jobGlyphKind(status: string): GlyphKind {
  switch (status) {
    case "pending":
    case "provisioning":
      return "provisioning";
    case "running":
      return "working";
    case "awaiting_input":
      return "hibernating";
    case "succeeded":
      return "complete";
    case "failed":
    case "timed_out":
      return "failed";
    default:
      return "stale";
  }
}

/** The jobs list's status filters, in the order the chips are drawn. */
export const SANDBOX_JOB_FILTERS = [
  { value: "", label: "All" },
  { value: "running", label: "Running" },
  { value: "awaiting_input", label: "Waiting for a follow-up" },
  { value: "pending", label: "Queued" },
  { value: "succeeded", label: "Succeeded" },
  { value: "failed", label: "Failed" },
  { value: "cancelled", label: "Cancelled" },
  { value: "timed_out", label: "Timed out" },
  { value: "expired", label: "Expired" },
] as const;

/**
 * A token count, short: `950`, `12.3k`, `1.2M`.
 * @param n - Tokens.
 * @returns The words.
 */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) {
    const k = n / 1000;
    return `${k < 10 ? k.toFixed(1) : Math.round(k)}k`;
  }
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/**
 * The model tokens a job has used (input plus output, as the proxy
 * measured them), and against what budget.
 * @param usage - `{ inputTokens, outputTokens, requests }`.
 * @param budget - The job's token budget, or `null` for none.
 * @returns E.g. `12.3k tokens` or `12.3k of 50k tokens`.
 */
export function usageWords(
  usage: { inputTokens: number; outputTokens: number },
  budget: number | null,
): string {
  const used = formatTokens(usage.inputTokens + usage.outputTokens);
  return budget === null
    ? `${used} tokens`
    : `${used} of ${formatTokens(budget)} tokens`;
}

/**
 * A duration in words: `45 s`, `30 min`, `1 h 30 min`.
 * @param ms - Milliseconds.
 * @returns The words.
 */
export function durationWords(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

/** The project's sandbox fields, as text. Blank means the deployment's. */
export interface SandboxSettingsDraft {
  provider: string;
  image: string;
  /** The stock runtime, for a provider that boots runtimes. */
  runtime: string;
  /** vCPUs per sandbox, for a provider that sizes them. */
  vcpus: string;
  /** `open-world` or `allowlist`; blank is the default, open-world. */
  egressMode: string;
  concurrency: string;
  maxMinutes: string;
}

/** What `project:settings-edit` takes for a project's sandboxes. */
export interface SandboxSettingsFields {
  sandboxProvider: string | null;
  sandboxImage: string | null;
  sandboxRuntime: string | null;
  sandboxVcpus: number | null;
  sandboxEgressMode: "open-world" | "allowlist" | null;
  sandboxConcurrency: number | null;
  sandboxMaxDurationMs: number | null;
}

/**
 * What the form needs to know of the provider it is describing: which
 * options it takes and whether it can hold an egress allowlist. `null` when
 * the provider is not known here (the deployment's default, after the project
 * chose its own); then the fields are sent as they are.
 */
export interface SandboxProviderShape {
  capabilities: { domainEgressAllowlist: boolean };
  options: {
    image: boolean;
    runtimes: { values: string[]; default: string } | null;
    vcpus: { min: number; max: number } | null;
  };
}

/**
 * The fields' text for a project's saved settings.
 * @param settings - The project's settings.
 * @returns The draft.
 */
export function sandboxDraftOf(settings: {
  sandboxProvider: string | null;
  sandboxConfig: {
    image?: string;
    runtime?: string;
    vcpus?: number;
    egressMode?: string;
  } | null;
  sandboxConcurrency: number | null;
  sandboxMaxDurationMs: number | null;
}): SandboxSettingsDraft {
  const config = settings.sandboxConfig ?? {};
  return {
    provider: settings.sandboxProvider ?? "",
    image: config.image ?? "",
    runtime: config.runtime ?? "",
    vcpus: config.vcpus === undefined ? "" : String(config.vcpus),
    egressMode: config.egressMode ?? "",
    concurrency:
      settings.sandboxConcurrency === null
        ? ""
        : String(settings.sandboxConcurrency),
    maxMinutes:
      settings.sandboxMaxDurationMs === null
        ? ""
        : String(Math.round(settings.sandboxMaxDurationMs / 60_000)),
  };
}

/**
 * Parse the project's sandbox fields. A blank field returns it to the
 * deployment's default. An option the chosen provider does not take is sent
 * as `null`, clearing what an earlier provider left behind, and an egress
 * allowlist on a provider that cannot hold one returns to open-world. Whether
 * a provider may run here, and whether a duration is under the deployment's
 * ceiling, is the server's to say.
 * @param draft - The fields.
 * @param provider - The provider the fields describe, or `null` when not known.
 * @returns The settings, or a sentence saying what is wrong.
 */
export function parseSandboxSettings(
  draft: SandboxSettingsDraft,
  provider: SandboxProviderShape | null = null,
): SandboxSettingsFields | string {
  const whole = (text: string) =>
    /^\d+$/.test(text.trim()) ? Number(text.trim()) : null;
  const takes = (option: "image" | "runtimes" | "vcpus") =>
    provider === null || Boolean(provider.options[option]);
  const image = takes("image") ? draft.image.trim() : "";
  if (image && !/^[\w./:@-]+$/.test(image)) {
    return "An image is a reference like ghcr.io/acme/agent:1.2, with no spaces.";
  }
  const runtime = takes("runtimes") ? draft.runtime.trim() : "";
  const runtimes = provider?.options.runtimes;
  if (runtime && runtimes && !runtimes.values.includes(runtime)) {
    return `The runtime is one of ${runtimes.values.join(", ")}.`;
  }
  let vcpus: number | null = null;
  if (takes("vcpus") && draft.vcpus.trim()) {
    vcpus = whole(draft.vcpus);
    const range = provider?.options.vcpus ?? { min: 1, max: 64 };
    if (vcpus === null || vcpus < range.min || vcpus > range.max) {
      return `vCPUs is a whole number from ${range.min} to ${range.max}.`;
    }
  }
  const mode = draft.egressMode.trim();
  if (mode && mode !== "open-world" && mode !== "allowlist") {
    return "Egress is open-world or allowlist.";
  }
  const egressMode =
    mode === "allowlist" &&
    provider !== null &&
    !provider.capabilities.domainEgressAllowlist
      ? null
      : (mode as "open-world" | "allowlist") || null;
  let concurrency: number | null = null;
  if (draft.concurrency.trim()) {
    concurrency = whole(draft.concurrency);
    if (concurrency === null || concurrency < 1 || concurrency > 50) {
      return "Jobs at once is a whole number from 1 to 50.";
    }
  }
  let maxMs: number | null = null;
  if (draft.maxMinutes.trim()) {
    const minutes = whole(draft.maxMinutes);
    if (minutes === null || minutes < 1) {
      return "The longest a job may run is a whole number of minutes, 1 or more.";
    }
    maxMs = minutes * 60_000;
  }
  return {
    sandboxProvider: draft.provider.trim() || null,
    sandboxImage: image || null,
    sandboxRuntime: runtime || null,
    sandboxVcpus: vcpus,
    sandboxEgressMode: egressMode,
    sandboxConcurrency: concurrency,
    sandboxMaxDurationMs: maxMs,
  };
}

/** The fewest tokens a per-job budget may be. */
export const MIN_JOB_TOKEN_BUDGET = 1000;

/**
 * Parse a bot's per-job token budget field.
 * @param text - The field's text; blank means no cap.
 * @returns The budget, `null` for none, or `undefined` when it is not a whole number of at least {@link MIN_JOB_TOKEN_BUDGET}.
 */
export function parseJobTokenBudget(text: string): number | null | undefined {
  const trimmed = text.trim().replaceAll(",", "").replaceAll("_", "");
  if (trimmed === "") return null;
  if (!/^\d+$/.test(trimmed)) return undefined;
  const n = Number(trimmed);
  return n >= MIN_JOB_TOKEN_BUDGET ? n : undefined;
}

/**
 * The job a `sandbox_start` call started, or a `sandbox_wait` call waits on,
 * from its result.
 * @param output - The call's result, as the transcript holds it.
 * @returns The job's id, or `null` when the call has no job (yet).
 */
export function sandboxStartJobId(output: unknown): number | null {
  if (!output || typeof output !== "object") return null;
  const id = (output as { jobId?: unknown }).jobId;
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0
    ? id
    : null;
}

/**
 * One line of a job's transcript, for a reader: what the agent said, which
 * tool it ran, or what a tool returned. The payload stays behind a fold.
 * @param event - The event.
 * @returns A label and the text to show.
 */
export function eventLine(event: {
  kind: string;
  toolName: string | null;
  text: string | null;
}): { label: string; text: string } {
  const text = event.text ?? "";
  switch (event.kind) {
    case "assistant":
      return { label: "Agent", text };
    case "user":
      return { label: "Prompt", text };
    case "reasoning":
      return { label: "Thinking", text };
    case "tool_use":
      return { label: event.toolName ?? "Tool", text };
    case "tool_result":
      return {
        label: event.toolName ? `${event.toolName} result` : "Result",
        text,
      };
    case "result":
      return { label: "Done", text };
    case "error":
      return { label: "Error", text };
    case "init":
      return { label: "Started", text };
    case "daemon":
      return { label: "Supervisor", text };
    default:
      return { label: event.kind, text };
  }
}

/**
 * Who answered a coding agent's question, in words.
 * @param answeredBy - The question's `answeredBy`.
 * @returns E.g. `the bot`, `Ada`, or `someone`.
 */
export function answeredByWords(answeredBy: unknown): string {
  if (!answeredBy || typeof answeredBy !== "object") return "someone";
  const by = answeredBy as { kind?: unknown; name?: unknown };
  if (by.kind === "bot") return "the bot";
  if (typeof by.name === "string" && by.name) return by.name;
  return "someone";
}

/**
 * The query string for one page of a job's transcript.
 * @param afterSeq - The last sequence number already read, or `null` for the start.
 * @param limit - How many to read.
 * @returns `?limit=…`, with `afterSeq` when set.
 */
export function eventsQuery(afterSeq: number | null, limit = 100): string {
  const params = new URLSearchParams({ limit: String(limit) });
  if (afterSeq !== null) params.set("afterSeq", String(afterSeq));
  return `?${params}`;
}
