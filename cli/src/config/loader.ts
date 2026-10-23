/**
 * Reading a config file: TOML text → a plain object → the schema → a typed
 * {@link Config}, or a list of issues each naming a TOML-style path
 * (`repositories[1].base_branch`, `agents.codex.command`).
 *
 * TOML is parsed with smol-toml rather than `Bun.TOML`, because a syntax error
 * should say where it is and Bun's parse error does not carry a usable line
 * and column.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { parse, TomlError } from "smol-toml";
import type { z } from "zod";
import { objectKeys, schemaAt } from "./introspect";
import type { Env } from "./paths";
import {
  buildConfigSchema,
  CONFIG_VERSION,
  type Config,
  type LogLevel,
  machineContext,
  type SchemaContext,
} from "./schema";
import { didYouMean } from "./suggest";

/** One problem with a config file. */
export interface ConfigIssue {
  /** The TOML-style path of the key, or `""` for the whole file. */
  path: string;
  /** What is wrong. */
  message: string;
  /** How to fix it, when there is something to say. */
  hint?: string;
  /** For a syntax error: where, 1-based. */
  line?: number;
  /** For a syntax error: where, 1-based. */
  column?: number;
}

/** What reading a config file produced. */
export interface LoadResult {
  /** The file read. */
  path: string;
  /** The parsed config, when the file is readable and passes the schema. */
  config: Config | null;
  /** Shape errors (pass 1), or the one read/syntax error. */
  issues: ConfigIssue[];
  /** True when the file could not be read or parsed at all (exit code 2). */
  unreadable: boolean;
}

/**
 * Render an issue path the TOML way: `repositories[1].base_branch`.
 * @param path - Keys and indices.
 * @returns The dotted path.
 */
export function renderIssuePath(path: readonly PropertyKey[]): string {
  let out = "";
  for (const segment of path) {
    if (typeof segment === "number") out += `[${segment}]`;
    else {
      const key = String(segment);
      const bare = /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key);
      out += out ? `.${bare}` : bare;
    }
  }
  return out;
}

/**
 * Turn zod issues into config issues: unknown keys one per key with a
 * suggestion, everything else at its path.
 * @param schema - The schema that refused the file (for allowed keys).
 * @param issues - Zod's issues.
 * @param raw - The parsed TOML, for the value an enum refused.
 * @returns Config issues, sorted by path.
 */
function shapeIssues(
  schema: z.ZodType,
  issues: readonly z.core.$ZodIssue[],
  raw: unknown,
): ConfigIssue[] {
  const out: ConfigIssue[] = [];
  for (const issue of issues) {
    if (issue.code === "unrecognized_keys") {
      const allowed = objectKeys(schemaAt(schema, issue.path));
      for (const key of issue.keys) {
        out.push({
          path: renderIssuePath([...issue.path, key]),
          message: `unknown key${didYouMean(key, allowed)}`,
        });
      }
      continue;
    }
    if (issue.path.length === 1 && issue.path[0] === "config_version") {
      out.push({
        path: "config_version",
        message: `required: this build reads config_version = ${CONFIG_VERSION}`,
      });
      continue;
    }
    if (issue.code === "invalid_value" && "values" in issue) {
      const got = issue.path.reduce<unknown>(
        (value, key) =>
          value && typeof value === "object"
            ? (value as Record<PropertyKey, unknown>)[key]
            : undefined,
        raw,
      );
      out.push({
        path: renderIssuePath(issue.path),
        message: `expected one of ${issue.values.map((v) => JSON.stringify(v)).join(", ")}${typeof got === "string" ? didYouMean(got, issue.values.map(String)) : ""}`,
      });
      continue;
    }
    out.push({ path: renderIssuePath(issue.path), message: issue.message });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Parse config text.
 * @param text - The file's contents.
 * @param path - The file's path (for relative paths and messages).
 * @param ctx - The schema context; defaults to this machine.
 * @returns The result.
 */
export function parseConfigText(
  text: string,
  path: string,
  ctx: SchemaContext = machineContext(dirname(path)),
): LoadResult {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (error) {
    if (error instanceof TomlError) {
      const first =
        error.message.split("\n")[0]?.replace(/^Invalid TOML document: /, "") ??
        "";
      return {
        path,
        config: null,
        unreadable: true,
        issues: [
          { path: "", message: first, line: error.line, column: error.column },
        ],
      };
    }
    throw error;
  }
  const version = (raw as { config_version?: unknown }).config_version;
  if (typeof version === "number" && version !== CONFIG_VERSION) {
    return {
      path,
      config: null,
      unreadable: false,
      issues: [
        {
          path: "config_version",
          message: `${version} is not a config version this build reads (it reads ${CONFIG_VERSION})`,
          hint:
            version > CONFIG_VERSION ? "run `hypotenuse upgrade`" : undefined,
        },
      ],
    };
  }
  const schema = buildConfigSchema(ctx);
  const result = schema.safeParse(raw);
  if (!result.success) {
    return {
      path,
      config: null,
      unreadable: false,
      issues: shapeIssues(schema, result.error.issues, raw),
    };
  }
  return { path, config: result.data, unreadable: false, issues: [] };
}

/**
 * Read and parse a config file.
 * @param path - The file.
 * @param env - Environment variables, for path expansion.
 * @returns The result; a missing file is `unreadable` with a hint.
 */
export function loadConfig(path: string, env: Env = process.env): LoadResult {
  if (!existsSync(path)) {
    return {
      path,
      config: null,
      unreadable: true,
      issues: [
        {
          path: "",
          message: `${path} does not exist`,
          hint: "run `hypotenuse config init`",
        },
      ],
    };
  }
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    return {
      path,
      config: null,
      unreadable: true,
      issues: [
        {
          path: "",
          message: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }
  return parseConfigText(text, path, machineContext(dirname(path), env));
}

/** The values a flag or environment variable can override. */
export interface ConfigOverrides {
  /** `--url`. */
  url?: string;
  /** `--project`. */
  project?: string;
  /** `-v`: debug logging. */
  verbose?: boolean;
  /** `--log-level`: beats `-v`. */
  logLevel?: LogLevel;
}

/** The log levels, quietest first. */
export const LOG_LEVELS: readonly LogLevel[] = [
  "error",
  "warn",
  "info",
  "debug",
  "trace",
];

/**
 * Apply the few overrides a flag or the environment may make: flag, then
 * environment, then the file. Nothing else has an override.
 * @param config - The parsed config (not modified).
 * @param overrides - The flags.
 * @param env - Environment variables.
 * @returns A config with the overrides applied.
 */
export function applyOverrides(
  config: Config,
  overrides: ConfigOverrides,
  env: Env = process.env,
): Config {
  const envLevel = env.HYPOTENUSE_LOG_LEVEL as LogLevel | undefined;
  return {
    ...config,
    server: {
      ...config.server,
      url: overrides.url ?? env.HYPOTENUSE_URL ?? config.server.url,
      project: overrides.project ?? config.server.project,
    },
    log: {
      ...config.log,
      level:
        overrides.logLevel ??
        (overrides.verbose
          ? "debug"
          : envLevel && LOG_LEVELS.includes(envLevel)
            ? envLevel
            : config.log.level),
    },
  };
}
