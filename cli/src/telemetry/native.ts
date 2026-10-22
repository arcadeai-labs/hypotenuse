/**
 * How each coding agent's own OpenTelemetry is turned on and pointed at the
 * turn's loopback receiver (`receiver.ts`). The daemon's ACP view covers what
 * an agent *reports*; an agent's native telemetry covers what it does not —
 * model requests, token counts, cost, its own tool decisions.
 *
 * Every launch gets the standard `OTEL_*` variables (OTLP/HTTP JSON at the
 * receiver's base URL) and `HYPOTENUSE_OTLP_ENDPOINT`, for people wrapping
 * their own agent; every inherited `OTEL_*` is dropped first, so the agent
 * does not double-export to wherever the daemon's environment pointed. A
 * preset adds what its agent needs on top. Prompts and tool detail are asked
 * for only at `full`.
 */
import type { ContentLevel } from "../../../protocol/src/index";

/** What a launch gains for native telemetry. */
export interface NativeTelemetryLaunch {
  env: Record<string, string>;
  /** Appended to the command line. */
  args: string[];
}

/** What the receiver and the turn decided. */
export interface NativeTelemetryTarget {
  /** `http://127.0.0.1:<port>/<nonce>`. */
  endpoint: string;
  level: ContentLevel;
}

/** Which presets emit their own telemetry, and how much of it we can ask for. */
export const NATIVE_TELEMETRY_PRESETS: Record<
  string,
  "native" | "standard-otel"
> = {
  claude: "native",
  codex: "native",
  gemini: "native",
  qwen: "native",
  goose: "standard-otel",
  opencode: "standard-otel",
};

/**
 * Whether a preset contributes native telemetry, for `doctor` and the docs.
 * @param preset - The preset, or null for a custom command.
 * @returns `native`, `standard-otel` (if it reads the standard variables), or `unknown`.
 */
export function nativeTelemetrySupport(
  preset: string | null,
): "native" | "standard-otel" | "unknown" {
  return (preset && NATIVE_TELEMETRY_PRESETS[preset]) || "unknown";
}

/**
 * Drop every inherited `OTEL_*` variable.
 * @param env - The agent's environment (changed in place).
 */
export function dropInheritedOtel(env: Record<string, string>): void {
  for (const key of Object.keys(env))
    if (key.startsWith("OTEL_")) delete env[key];
}

/**
 * The environment and arguments that turn a preset's native telemetry on.
 * @param preset - The preset, or null for a custom command.
 * @param target - The receiver and the turn's level.
 * @returns What to add to the launch.
 */
export function nativeTelemetryLaunch(
  preset: string | null,
  target: NativeTelemetryTarget,
): NativeTelemetryLaunch {
  const full = target.level === "full";
  const env: Record<string, string> = {
    HYPOTENUSE_OTLP_ENDPOINT: target.endpoint,
    OTEL_EXPORTER_OTLP_ENDPOINT: target.endpoint,
    OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
    OTEL_TRACES_EXPORTER: "otlp",
    OTEL_METRICS_EXPORTER: "otlp",
    OTEL_LOGS_EXPORTER: "otlp",
    // Short intervals, so what an agent exports lands before the turn ends
    // and the receiver drains.
    OTEL_METRIC_EXPORT_INTERVAL: "5000",
    OTEL_LOGS_EXPORT_INTERVAL: "2000",
    OTEL_BSP_SCHEDULE_DELAY: "1000",
  };
  const args: string[] = [];
  switch (preset) {
    case "claude":
      env.CLAUDE_CODE_ENABLE_TELEMETRY = "1";
      // Traces are a beta behind this flag at the time of writing; harmless
      // once they are not.
      env.CLAUDE_CODE_ENHANCED_TELEMETRY_BETA = "1";
      if (full) {
        env.OTEL_LOG_USER_PROMPTS = "1";
        env.OTEL_LOG_TOOL_DETAILS = "1";
      }
      break;
    case "gemini":
    case "qwen": {
      // Gemini CLI (and Qwen Code, its fork) log prompts by default once
      // telemetry is on: off below `full`.
      const prefix = preset === "gemini" ? "GEMINI" : "QWEN";
      env[`${prefix}_TELEMETRY_ENABLED`] = "true";
      env[`${prefix}_TELEMETRY_TARGET`] = "local";
      env[`${prefix}_TELEMETRY_OTLP_ENDPOINT`] = target.endpoint;
      env[`${prefix}_TELEMETRY_OTLP_PROTOCOL`] = "http";
      env[`${prefix}_TELEMETRY_LOG_PROMPTS`] = full ? "true" : "false";
      break;
    }
    case "codex":
      args.push(
        "-c",
        `otel.exporter={otlp-http={endpoint="${target.endpoint}",protocol="json"}}`,
        "-c",
        `otel.log_user_prompt=${full ? "true" : "false"}`,
      );
      break;
  }
  return { env, args };
}
