/**
 * The daemon config file's schema — the source of truth for every key, its
 * type, its default, and its description. `docs/CONFIG.md` tabulates the same
 * keys, and `__tests__/config/docs-parity.test.ts` asserts the two are equal.
 *
 * Every object is strict: a misspelt key is an error, never silently ignored.
 * Durations and sizes are strings parsed to milliseconds and bytes; paths are
 * expanded and made absolute against the config file's directory. Both happen
 * in transforms, so the schema is built per file by {@link buildConfigSchema}.
 * {@link ConfigSchema} is the same schema for a file in the current directory,
 * which is all the JSON Schema needs.
 */
import { cpus, hostname } from "node:os";
import { z } from "zod";
import { RUNNER_ROLES } from "../../../protocol/src/index";
import {
  DURATION_PATTERN,
  parseDuration,
  parseSize,
  SIZE_PATTERN,
} from "./durations";
import { type Env, expandPath } from "./paths";
import { PRESET_NAMES } from "./presets";

/** The config format this build reads. */
export const CONFIG_VERSION = 1;

/** Where `config schema` says its JSON Schema lives. */
export const CONFIG_SCHEMA_ID =
  "https://www.hypotenuse.cloud/schemas/config-v1.json";

/** The ACP tool kinds a table-form `permission_policy` may name. */
export const TOOL_KINDS = [
  "read",
  "edit",
  "delete",
  "move",
  "search",
  "execute",
  "think",
  "fetch",
  "other",
] as const;

/** What a permission request can be answered with. */
export const POLICIES = ["allow", "ask", "deny"] as const;

/** A `permission_policy`: one answer for every request, or one per ACP tool kind. */
export type PermissionPolicyConfig =
  | (typeof POLICIES)[number]
  | Partial<
      Record<"default" | (typeof TOOL_KINDS)[number], (typeof POLICIES)[number]>
    >;

/**
 * The manager's default: read-only. Writes, deletes, moves, and commands are
 * refused without asking anyone; everything else is allowed. Not the bare
 * string `deny`: ACP agents ask permission for MCP tool calls too (kind
 * `other` or `fetch`), and a blanket deny would refuse the manager its own
 * Hypotenuse tools — the only way it does its job.
 */
export const MANAGER_DEFAULT_POLICY = {
  default: "allow",
  edit: "deny",
  delete: "deny",
  move: "deny",
  execute: "deny",
} as const satisfies PermissionPolicyConfig;

/** Linear's stale window: an agent session silent this long looks stuck. */
export const LINEAR_STALE_MS = 30 * 60_000;

/** What the schema needs to know about the file and the machine. */
export interface SchemaContext {
  /** The config file's directory: what relative paths resolve against. */
  baseDir: string;
  /** Environment variables, for `~` and `$VAR` in paths. */
  env: Env;
  /** CPU cores, for the default `max_parallel_jobs`. */
  cpuCount: number;
  /** The host name, for the default runner name. */
  hostname: string;
}

/**
 * The default number of jobs at once: a quarter of the cores, 1–8.
 * @param cpuCount - CPU cores.
 * @returns The default.
 */
export function defaultMaxParallelJobs(cpuCount: number): number {
  return Math.max(1, Math.min(8, Math.floor(cpuCount / 4)));
}

/**
 * The schema context for a config file on this machine.
 * @param baseDir - The config file's directory.
 * @param env - Environment variables.
 * @returns The context.
 */
export function machineContext(
  baseDir: string,
  env: Env = process.env,
): SchemaContext {
  return { baseDir, env, cpuCount: cpus().length || 1, hostname: hostname() };
}

/**
 * Build the schema for one config file.
 * @param ctx - The file's directory and the machine.
 * @returns The zod schema; its output is a {@link Config}.
 */
export function buildConfigSchema(ctx: SchemaContext) {
  const path = () =>
    z
      .string()
      .trim()
      .min(1)
      .transform((value) => expandPath(value, ctx.baseDir, ctx.env));
  const duration = () =>
    z
      .string()
      .regex(
        DURATION_PATTERN,
        "expected a duration such as 45s, 10m, 2h, or 7d",
      )
      .transform(parseDuration);
  const size = () =>
    z
      .string()
      .regex(SIZE_PATTERN, "expected a size such as 500MB or 2GB")
      .transform(parseSize);
  const parallel = () => z.number().int().min(1).max(32);
  const strings = () => z.array(z.string().trim().min(1));
  const stringTable = () => z.record(z.string(), z.string());

  const permissionPolicy = (fallback: PermissionPolicyConfig) =>
    z
      .union([
        z.enum(POLICIES),
        z.strictObject({
          default: z.enum(POLICIES).optional(),
          ...Object.fromEntries(
            TOOL_KINDS.map((kind) => [kind, z.enum(POLICIES).optional()]),
          ),
        }) as z.ZodType<
          Partial<
            Record<
              "default" | (typeof TOOL_KINDS)[number],
              (typeof POLICIES)[number]
            >
          >
        >,
      ])
      .default(typeof fallback === "string" ? fallback : { ...fallback })
      .describe(
        'allow, ask, or deny every permission request — or a table by ACP tool kind, e.g. { default = "allow", execute = "ask" }. Defaults: worker "allow"; manager read-only, { default = "allow", edit = "deny", delete = "deny", move = "deny", execute = "deny" }',
      );

  const mcpServer = z.strictObject({
    name: z
      .string()
      .trim()
      .min(1)
      .describe("Unique within the role; `hypotenuse` is reserved"),
    command: strings()
      .min(1)
      .optional()
      .describe("A stdio MCP server's command"),
    env: stringTable()
      .optional()
      .describe("Added to the server's environment; $VAR allowed"),
    url: z.url().optional().describe("An HTTP MCP server's URL"),
    headers: stringTable().optional().describe("HTTP headers; $VAR allowed"),
  });

  const role = (fallbackPolicy: PermissionPolicyConfig) =>
    z.strictObject({
      agent: z
        .string()
        .trim()
        .min(1)
        .describe("An [agents.<id>] id or a preset name"),
      prompt: z
        .string()
        .min(1)
        .optional()
        .describe("The role's entry prompt template, inline"),
      prompt_file: path()
        .optional()
        .describe("A Markdown prompt template file"),
      permission_policy: permissionPolicy(fallbackPolicy),
      max_parallel: parallel().optional().describe("Jobs of this role at once"),
      mode: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe("The ACP session mode to select"),
      turn_timeout: duration()
        .optional()
        .describe("Overrides [sessions] turn_timeout"),
      additional_directories: z
        .array(path())
        .default([])
        .describe("Extra directories the agent may read and write"),
      extra_mcp_servers: z
        .array(mcpServer)
        .default([])
        .describe("More MCP servers for the agent"),
    });

  const agent = z.strictObject({
    preset: z
      .enum(PRESET_NAMES)
      .optional()
      .describe("A built-in agent launch command"),
    command: strings()
      .min(1)
      .optional()
      .describe("The full launch command of an ACP agent on stdio"),
    args: strings()
      .default([])
      .describe("Appended to the preset's or command's arguments"),
    env: stringTable()
      .default({})
      .describe("Added to the agent's environment; $VAR allowed"),
    auth_method: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("Which advertised ACP authMethod to use"),
    startup_timeout: duration()
      .prefault("60s")
      .describe("Time allowed to answer initialize"),
    max_parallel: parallel()
      .optional()
      .describe("Jobs using this agent at once"),
  });

  const cleanup = z.enum(["on-complete", "on-merge", "ttl", "never"]);
  const worktrees = z.enum(["always", "never"]);

  const repository = z.strictObject({
    name: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "letters, digits, `.`, `_`, `-`")
      .max(64)
      .optional()
      .describe("Unique; used in worktree paths"),
    path: path().describe("An existing git clone"),
    remote: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("The repository's remote; must match origin"),
    base_branch: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("The branch worktrees start from"),
    setup: strings()
      .default([])
      .describe("Shell commands run in each new worktree"),
    setup_timeout: duration().prefault("10m").describe("Per setup command"),
    branch_prefix: z
      .string()
      .trim()
      .min(1)
      .default("hypotenuse")
      .describe("Branch name prefix"),
    worktrees: worktrees.optional().describe("Overrides [sessions] worktrees"),
    cleanup: cleanup.optional().describe("Overrides [sessions] cleanup"),
    pr_url_patterns: strings()
      .default([])
      .describe("Extra PR URL regexes for self-hosted forges"),
  });

  return z.strictObject({
    config_version: z
      .number()
      .int()
      .describe(`The config format; must be ${CONFIG_VERSION}`),
    server: z
      .strictObject({
        url: z.url().optional().describe("The Hypotenuse server"),
        project: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("The runner's project, by slug or id"),
      })
      .prefault({}),
    runner: z
      .strictObject({
        name: z
          .string()
          .trim()
          .min(1)
          .max(64)
          .default(
            ctx.hostname.replace(/\.local$/i, "").slice(0, 64) || "runner",
          )
          .describe("Display name"),
        max_parallel_jobs: z
          .number()
          .int()
          .min(1)
          .max(32)
          .default(defaultMaxParallelJobs(ctx.cpuCount))
          .describe("Jobs running at once on this machine"),
        roles: z
          .array(z.enum(RUNNER_ROLES))
          .min(1)
          .default(["worker"])
          .describe("The roles this runner plays"),
      })
      .prefault({}),
    subscriptions: z
      .strictObject({
        teams: strings().default([]).describe("Linear team keys"),
        projects: strings().default([]).describe("Linear project ids or names"),
        labels: strings()
          .default([])
          .describe("Label names; an issue needs one"),
      })
      .prefault({}),
    agents: z
      .record(
        z
          .string()
          .regex(/^[a-z0-9][a-z0-9-]*$/, "lowercase letters, digits, and `-`"),
        agent,
      )
      .default({}),
    roles: z
      .strictObject({
        manager: role(MANAGER_DEFAULT_POLICY).optional(),
        worker: role("allow").optional(),
      })
      .prefault({}),
    repositories: z.array(repository).default([]),
    sessions: z
      .strictObject({
        worktrees: worktrees
          .default("always")
          .describe("Whether sessions get a worktree"),
        worktree_root: path()
          .prefault("~/.hypotenuse/worktrees")
          .describe("Where worktrees live"),
        cleanup: cleanup
          .default("on-complete")
          .describe("When a worktree may be removed"),
        cleanup_ttl: duration()
          .optional()
          .describe("Required for cleanup = ttl"),
        cleanup_grace: duration()
          .prefault("1h")
          .describe("Wait after completion before cleanup"),
        turn_timeout: duration().prefault("60m").describe("Longest turn"),
        idle_timeout: duration().prefault("15m").describe("Longest silence"),
        keepalive_interval: duration()
          .prefault("10m")
          .describe("Silence before a keepalive thought"),
        stop_grace: duration()
          .prefault("10s")
          .describe("Wind-down time after a stop"),
        min_free_disk: size()
          .prefault("2GB")
          .describe("Free space needed for a new worktree"),
        co_author: z
          .string()
          .default("Hypotenuse <noreply@hypotenuse.cloud>")
          .describe(
            "Co-Authored-By trailer on the agent's commits; empty for none",
          ),
      })
      .prefault({}),
    log: z
      .strictObject({
        level: z
          .enum(["error", "warn", "info", "debug", "trace"])
          .default("info")
          .describe("Log level"),
        file: path().optional().describe("The daemon log file"),
      })
      .prefault({}),
  });
}

/** The schema for a file in the current directory (what the JSON Schema shows). */
export const ConfigSchema = buildConfigSchema({
  baseDir: process.cwd(),
  env: {},
  cpuCount: 4,
  hostname: "runner",
});

/** A parsed, defaulted config. */
export type Config = z.output<typeof ConfigSchema>;

/** One `[agents.<id>]` table, parsed. */
export type AgentConfig = Config["agents"][string];

/** One `[roles.*]` table, parsed. */
export type RoleConfig = NonNullable<Config["roles"]["worker"]>;

/** One `[[repositories]]` entry, parsed. */
export type RepositoryConfig = Config["repositories"][number];

/** A log level. */
export type LogLevel = Config["log"]["level"];

/**
 * The JSON Schema `config schema` prints and editors complete with.
 * @returns The schema object, with its `$id`.
 */
export function configJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(ConfigSchema, {
    io: "input",
    unrepresentable: "any",
  }) as Record<string, unknown>;
  return { $id: CONFIG_SCHEMA_ID, ...schema };
}
