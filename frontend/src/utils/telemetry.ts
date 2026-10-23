import type { TelemetryExporterList } from "@backend/actions/telemetry/telemetry-exporter-list";
import type { ActionResponse } from "keryx";

/** An exporter as `telemetry-exporter:list` serializes it. */
export type TelemetryExporter =
  ActionResponse<TelemetryExporterList>["telemetryExporters"][number];

/** The content levels, least to most. */
export const CONTENT_LEVELS = ["metadata", "content", "full"] as const;

/** One of {@link CONTENT_LEVELS}. */
export type ContentLevel = (typeof CONTENT_LEVELS)[number];

/** What each content level sends, in one sentence. */
export const CONTENT_LEVEL_LABELS: Record<ContentLevel, string> = {
  metadata: "Names, ids, timings, sizes, and statuses.",
  content:
    "Adds prompts, thoughts, tool inputs and outputs, and command output.",
  full: "Adds every ACP frame and asks agents to log prompts natively. Sends source code and prompts to a third party.",
};

/** The signals an exporter can send. */
export const SIGNALS = ["traces", "metrics", "logs"] as const;

/** One of {@link SIGNALS}. */
export type Signal = (typeof SIGNALS)[number];

/** The OTLP/HTTP encodings. */
export const PROTOCOLS = ["http/protobuf", "http/json"] as const;

/** One of {@link PROTOCOLS}. */
export type Protocol = (typeof PROTOCOLS)[number];

/** Whether an agent preset contributes its own telemetry. */
export type NativeSupport = "native" | "otel-env" | "none";

/** Presets that emit OpenTelemetry themselves when the daemon asks. */
const NATIVE_PRESETS = new Set(["claude", "codex", "gemini", "qwen"]);

/** Presets that emit it only if they honour the standard `OTEL_*` variables. */
const OTEL_ENV_PRESETS = new Set(["goose", "opencode"]);

/**
 * Whether a coding agent built on a preset contributes native telemetry.
 * @param preset - The preset the agent is built on, e.g. `claude`.
 * @returns `native`, `otel-env` (only if it reads `OTEL_*`), or `none`.
 */
export function nativeSupport(preset: string): NativeSupport {
  const key = preset.trim().toLowerCase();
  if (NATIVE_PRESETS.has(key)) return "native";
  if (OTEL_ENV_PRESETS.has(key)) return "otel-env";
  return "none";
}

/** What the runners table says for each {@link NativeSupport}. */
export const NATIVE_SUPPORT_LABELS: Record<NativeSupport, string> = {
  native: "native",
  "otel-env": "if it reads OTEL_*",
  none: "no",
};

/**
 * Whether an exporter's last error is still its news: shown only when it
 * happened after the last export that succeeded, so one that recovered does
 * not keep reporting a failure it is past.
 * @param exporter - The exporter's `lastExportAt` and `lastErrorAt`.
 * @returns Whether to show `lastError`.
 */
export function showLastError(
  exporter: Pick<
    TelemetryExporter,
    "lastExportAt" | "lastErrorAt" | "lastError"
  >,
): boolean {
  if (exporter.lastErrorAt === null || !exporter.lastError) return false;
  return (
    exporter.lastExportAt === null ||
    exporter.lastErrorAt > exporter.lastExportAt
  );
}

/** A transcript note, split into plain text and backticked code. */
export type NotePart = { code: boolean; text: string };

/**
 * Split a server-written note on backticks, so `runner \`laptop\`` renders
 * the name as code. An unpaired backtick is kept as text.
 * @param note - The note.
 * @returns The parts, in order, empty ones dropped.
 */
export function noteParts(note: string): NotePart[] {
  const pieces = note.split("`");
  if (pieces.length % 2 === 0) return [{ code: false, text: note }];
  return pieces
    .map((text, i) => ({ code: i % 2 === 1, text }))
    .filter((p) => p.text.length > 0);
}

/** One header row in the form: a name and a value that is never pre-filled. */
export interface HeaderRow {
  name: string;
  value: string;
}

/**
 * What an edit does to an exporter's headers: `keep` sends nothing (the
 * server keeps them), `clear` sends `{}`, `replace` sends the rows whole.
 */
export type HeaderMode = "keep" | "clear" | "replace";

/** The exporter form, as strings where a person types. */
export interface ExporterDraft {
  name: string;
  endpoint: string;
  protocol: Protocol;
  content: ContentLevel;
  signals: Signal[];
  traceSampleRatio: string;
  agentNative: boolean;
  enabled: boolean;
  /** One `key=value` per line. */
  resourceAttributes: string;
  headerMode: HeaderMode;
  headers: HeaderRow[];
}

/**
 * A blank draft for a new exporter, with the server's defaults.
 * @returns The draft.
 */
export function emptyDraft(): ExporterDraft {
  return {
    name: "",
    endpoint: "",
    protocol: "http/protobuf",
    content: "metadata",
    signals: [...SIGNALS],
    traceSampleRatio: "1",
    agentNative: true,
    enabled: true,
    resourceAttributes: "",
    headerMode: "replace",
    headers: [],
  };
}

/**
 * A draft seeded from an exporter for editing. Header values are never
 * known here, so the draft keeps them until the person chooses otherwise.
 * @param exporter - The exporter.
 * @returns The draft.
 */
export function draftFromExporter(exporter: TelemetryExporter): ExporterDraft {
  return {
    name: exporter.name,
    endpoint: exporter.endpoint,
    protocol: exporter.protocol as Protocol,
    content: exporter.content as ContentLevel,
    signals: SIGNALS.filter((s) => exporter.signals.includes(s)),
    traceSampleRatio: String(exporter.traceSampleRatio),
    agentNative: exporter.agentNative,
    enabled: exporter.enabled,
    resourceAttributes: Object.entries(exporter.resourceAttributes)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n"),
    headerMode: "keep",
    headers: [],
  };
}

/**
 * Parse `key=value` lines. Blank lines are skipped; the first `=` splits.
 * @param text - The lines.
 * @returns The record, or the sentence naming the first bad line.
 */
export function parseKeyValueLines(
  text: string,
): { record: Record<string, string> } | { error: string } {
  const record: Record<string, string> = {};
  for (const [i, raw] of text.split("\n").entries()) {
    const line = raw.trim();
    if (!line) continue;
    const at = line.indexOf("=");
    if (at <= 0)
      return {
        error: `Line ${i + 1} of the resource attributes is not key=value.`,
      };
    record[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return { record };
}

/**
 * The body a draft submits, or the sentence saying why it cannot be sent.
 * A create sends its header rows when there are any; an edit sends headers
 * only when the person chose to clear or replace them.
 * @param draft - The form.
 * @param editing - Whether this edits an existing exporter.
 * @returns The request fields (no `projectId` or `id`), or an error.
 */
export function payloadFromDraft(
  draft: ExporterDraft,
  editing: boolean,
): { body: Record<string, unknown> } | { error: string } {
  if (!draft.name.trim()) return { error: "An exporter needs a name." };
  if (!draft.endpoint.trim())
    return { error: "An exporter needs an endpoint." };
  if (draft.signals.length === 0)
    return { error: "Choose at least one signal to send." };
  const ratio = Number(draft.traceSampleRatio);
  if (draft.traceSampleRatio.trim() === "" || !(ratio >= 0 && ratio <= 1))
    return { error: "The sample ratio is a number from 0 to 1." };
  const attributes = parseKeyValueLines(draft.resourceAttributes);
  if ("error" in attributes) return attributes;

  const body: Record<string, unknown> = {
    name: draft.name.trim(),
    endpoint: draft.endpoint.trim(),
    protocol: draft.protocol,
    content: draft.content,
    signals: draft.signals,
    traceSampleRatio: ratio,
    agentNative: draft.agentNative,
    enabled: draft.enabled,
    resourceAttributes: attributes.record,
  };

  const mode: HeaderMode = editing ? draft.headerMode : "replace";
  if (mode === "clear") body.headers = {};
  if (mode === "replace") {
    const headers: Record<string, string> = {};
    for (const row of draft.headers) {
      const name = row.name.trim();
      if (!name && !row.value) continue;
      if (!name) return { error: "Every header needs a name." };
      headers[name] = row.value;
    }
    const named = Object.keys(headers).length > 0;
    // Replacing with nothing would clear them; make that the explicit choice.
    if (editing && !named)
      return { error: "Add the new headers, or choose to clear them." };
    if (named) body.headers = headers;
  }
  return { body };
}
