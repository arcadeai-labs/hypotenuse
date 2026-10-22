/**
 * `hypotenuse telemetry exporter` — the selected project's OpenTelemetry
 * exporters (`telemetry-exporter:*`): where its work is exported, at what
 * content level, and how the last export went. Header values are write-only:
 * `--header KEY=VALUE` sends them, and nothing ever prints them back.
 */
import type { Command } from "commander";
import {
  emit,
  pageFooter,
  pageQuery,
  runCommand,
  when,
  withPaging,
} from "../context";
import { glyph, table } from "../output/theme";

/** An exporter as the actions answer it. */
export interface TelemetryExporter {
  id: number;
  name: string;
  enabled: boolean;
  endpoint: string;
  protocol: string;
  headerNames: string[];
  signals: string[];
  content: string;
  agentNative: boolean;
  traceSampleRatio: number;
  resourceAttributes: Record<string, string>;
  lastExportAt: number | null;
  lastError: string | null;
  lastErrorAt: number | null;
}

/**
 * Collect a repeatable `KEY=VALUE` option.
 * @param value - One occurrence.
 * @param previous - The ones before.
 * @returns All of them.
 */
function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

/**
 * Parse `KEY=VALUE` pairs.
 * @param pairs - The occurrences.
 * @param what - What they are, for the error.
 * @returns Key to value.
 * @throws {Error} For a pair without `=`.
 */
export function parsePairs(
  pairs: string[],
  what: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of pairs) {
    const at = pair.indexOf("=");
    if (at <= 0) throw new Error(`${what} must be KEY=VALUE, got "${pair}"`);
    out[pair.slice(0, at).trim()] = pair.slice(at + 1);
  }
  return out;
}

/**
 * The health column: the last error when it is newer than the last export.
 * @param e - The exporter.
 * @returns A short phrase.
 */
export function exporterHealth(e: TelemetryExporter): string {
  if (!e.enabled) return "paused";
  if (e.lastErrorAt && (!e.lastExportAt || e.lastErrorAt > e.lastExportAt))
    return `error ${when(e.lastErrorAt)}: ${e.lastError ?? ""}`;
  return e.lastExportAt ? `ok ${when(e.lastExportAt)}` : "nothing yet";
}

/**
 * One exporter, as `view` prints it.
 * @param e - The exporter.
 * @returns The lines.
 */
export function describeExporter(e: TelemetryExporter): string {
  const attrs = Object.entries(e.resourceAttributes)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
  return [
    `${e.name} (id ${e.id})${e.enabled ? "" : "  paused"}`,
    `endpoint     ${e.endpoint}`,
    `protocol     ${e.protocol}`,
    `content      ${e.content}`,
    `signals      ${e.signals.join(", ")}`,
    `sampled      ${Math.round(e.traceSampleRatio * 100)}% of turns`,
    `agent's own  ${e.agentNative ? "captured" : "not captured"}`,
    `headers      ${e.headerNames.length ? e.headerNames.join(", ") : "none"} (values are never shown)`,
    `attributes   ${attrs || "none"}`,
    `last export  ${when(e.lastExportAt)}`,
    `last error   ${e.lastError ? `${when(e.lastErrorAt)}: ${e.lastError}` : "-"}`,
  ].join("\n");
}

/** The options `add` and `edit` share. */
interface ExporterOptions {
  name?: string;
  endpoint?: string;
  protocol?: string;
  header?: string[];
  clearHeaders?: boolean;
  signals?: string;
  content?: string;
  agentNative?: boolean;
  sample?: string;
  attribute?: string[];
  enabled?: boolean;
}

/**
 * The request body from the options: only what was given.
 * @param opts - The parsed options.
 * @returns The body's fields.
 */
export function exporterBody(opts: ExporterOptions): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (opts.name !== undefined) body.name = opts.name;
  if (opts.endpoint !== undefined) body.endpoint = opts.endpoint;
  if (opts.protocol !== undefined) body.protocol = opts.protocol;
  if (opts.clearHeaders) body.headers = {};
  else if (opts.header?.length)
    body.headers = parsePairs(opts.header, "--header");
  if (opts.signals !== undefined)
    body.signals = opts.signals
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  if (opts.content !== undefined) body.content = opts.content;
  if (opts.agentNative !== undefined) body.agentNative = opts.agentNative;
  if (opts.sample !== undefined) body.traceSampleRatio = Number(opts.sample);
  if (opts.attribute?.length)
    body.resourceAttributes = parsePairs(opts.attribute, "--attribute");
  if (opts.enabled !== undefined) body.enabled = opts.enabled;
  return body;
}

/**
 * The options `add` and `edit` take.
 * @param command - The command.
 * @param adding - Whether it is `add` (name and endpoint required).
 * @returns The command.
 */
function exporterOptions(command: Command, adding: boolean): Command {
  if (adding)
    command
      .requiredOption(
        "--name <name>",
        "what it is called, unique in the project",
      )
      .requiredOption(
        "--endpoint <url>",
        "the collector's OTLP/HTTP base URL (https; /v1/<signal> is appended)",
      );
  else
    command
      .option("--name <name>", "a new name")
      .option("--endpoint <url>", "a new endpoint");
  return command
    .option("--protocol <protocol>", "http/protobuf (default) or http/json")
    .option(
      "--header <KEY=VALUE>",
      "a header sent with every export, e.g. an API key; repeat for more (replaces all; never printed)",
      collect,
    )
    .option(
      "--content <level>",
      "metadata (default), content, or full — full sends prompts and source code",
    )
    .option("--signals <list>", "comma-separated: traces,metrics,logs")
    .option("--sample <ratio>", "0–1: the share of turns whose traces are kept")
    .option(
      "--attribute <KEY=VALUE>",
      "an extra resource attribute; repeat for more (replaces all)",
      collect,
    )
    .option("--agent-native", "capture the coding agent's own telemetry")
    .option("--no-agent-native", "do not capture the agent's own telemetry");
}

/**
 * Register `telemetry exporter list|view|add|edit|remove|test`.
 * @param program - The root program.
 */
export function registerTelemetryCommands(program: Command): void {
  const telemetry = program
    .command("telemetry")
    .description("Where the selected project's OpenTelemetry goes");
  const exporter = telemetry
    .command("exporter")
    .description("The project's OpenTelemetry collectors");

  withPaging(exporter.command("list").description("List exporters")).action(
    async function (this: Command) {
      await runCommand(this, async (ctx) => {
        const projectId = await ctx.projectId();
        const result = await ctx.signedInClient().request<{
          telemetryExporters: TelemetryExporter[];
          pagination: { page: number; pages: number; total: number };
        }>("GET", "/telemetry-exporters", {
          query: { projectId, ...pageQuery(this) },
        });
        emit(
          ctx,
          result,
          () =>
            table(
              result.telemetryExporters.map((e) => ({
                id: e.id,
                name: e.name,
                endpoint: e.endpoint,
                content: e.content,
                signals: e.signals.join(","),
                sampled: `${Math.round(e.traceSampleRatio * 100)}%`,
                headers: e.headerNames.join(",") || "-",
                health: exporterHealth(e),
              })),
              [
                { key: "id" },
                { key: "name", maxWidth: 30 },
                { key: "endpoint", maxWidth: 50 },
                { key: "content" },
                { key: "signals" },
                { key: "sampled" },
                { key: "headers", maxWidth: 30 },
                { key: "health", maxWidth: 60 },
              ],
            ) + pageFooter(result.pagination),
        );
      });
    },
  );

  exporter
    .command("view <id>")
    .description("Show one exporter (header names only)")
    .action(async function (this: Command, id: string) {
      await runCommand(this, async (ctx) => {
        const projectId = await ctx.projectId();
        const result = await ctx
          .signedInClient()
          .request<{ telemetryExporter: TelemetryExporter }>(
            "GET",
            `/telemetry-exporter/${id}`,
            { query: { projectId } },
          );
        emit(ctx, result, () => describeExporter(result.telemetryExporter));
      });
    });

  exporterOptions(
    exporter
      .command("add")
      .description("Export the project's telemetry to a collector (admin)"),
    true,
  )
    .option("--disabled", "create it paused")
    .action(async function (this: Command) {
      await runCommand(this, async (ctx) => {
        const opts = this.opts() as ExporterOptions & { disabled?: boolean };
        const projectId = await ctx.projectId();
        const result = await ctx
          .signedInClient()
          .request<{ telemetryExporter: TelemetryExporter }>(
            "PUT",
            "/telemetry-exporter",
            {
              body: {
                projectId,
                ...exporterBody(opts),
                ...(opts.disabled ? { enabled: false } : {}),
              },
            },
          );
        emit(
          ctx,
          result,
          () =>
            `Added exporter ${result.telemetryExporter.name} (id ${result.telemetryExporter.id}) at ${result.telemetryExporter.content}; \`hypotenuse telemetry exporter test ${result.telemetryExporter.id}\` sends a probe`,
        );
      });
    });

  exporterOptions(
    exporter
      .command("edit <id>")
      .description("Change an exporter; headers are kept unless given (admin)"),
    false,
  )
    .option("--clear-headers", "send no headers from now on")
    .option("--enable", "resume exporting")
    .option("--disable", "pause exporting")
    .action(async function (this: Command, id: string) {
      await runCommand(this, async (ctx) => {
        const opts = this.opts() as ExporterOptions & {
          enable?: boolean;
          disable?: boolean;
        };
        const projectId = await ctx.projectId();
        const body = exporterBody({
          ...opts,
          enabled: opts.enable ? true : opts.disable ? false : undefined,
        });
        const result = await ctx
          .signedInClient()
          .request<{ telemetryExporter: TelemetryExporter }>(
            "POST",
            `/telemetry-exporter/${id}`,
            { body: { projectId, ...body } },
          );
        emit(ctx, result, () => describeExporter(result.telemetryExporter));
      });
    });

  exporter
    .command("remove <id>")
    .description("Stop exporting to a collector and forget its headers (admin)")
    .action(async function (this: Command, id: string) {
      await runCommand(this, async (ctx) => {
        const projectId = await ctx.projectId();
        const result = await ctx
          .signedInClient()
          .request("DELETE", `/telemetry-exporter/${id}`, {
            body: { projectId },
          });
        emit(ctx, result, () => `Removed exporter ${id}`);
      });
    });

  exporter
    .command("test <id>")
    .description(
      "Send the collector a probe span, log, and metric, and show its answers (admin)",
    )
    .action(async function (this: Command, id: string) {
      await runCommand(this, async (ctx) => {
        const projectId = await ctx.projectId();
        const result = await ctx.signedInClient().request<{
          ok: boolean;
          results: {
            signal: string;
            ok: boolean;
            status: number;
            error: string | null;
          }[];
        }>("POST", `/telemetry-exporter/${id}/test`, { body: { projectId } });
        emit(ctx, result, () =>
          result.results
            .map(
              (r) =>
                `${glyph(r.ok ? "complete" : "error")} ${r.signal.padEnd(8)} ${r.status || "-"}${r.error ? `  ${r.error}` : ""}`,
            )
            .join("\n"),
        );
        if (!result.ok) process.exitCode = 1;
      });
    });
}
