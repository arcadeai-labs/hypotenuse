/**
 * All three validation passes over one file, as `config validate`, `daemon
 * start`, `daemon reload`, and `doctor` run them. Passes 2 and 3 run only
 * once pass 1 passes: a reference check over a shape that is wrong would
 * report the same mistake twice.
 */
import { type ConfigIssue, type LoadResult, loadConfig } from "./loader";
import { type MachineEnv, realMachine } from "./machine";
import type { Env } from "./paths";
import type { Config } from "./schema";
import {
  type Findings,
  mergeFindings,
  validateMachine,
  validateReferences,
} from "./validate";

/** A checked config file. */
export interface CheckedConfig {
  /** What reading it produced. */
  load: LoadResult;
  /** Every error and warning, pass 1 included. */
  findings: Findings;
  /** The config, when there are no errors. */
  config: Config | null;
}

/**
 * Read and check a config file.
 * @param path - The file.
 * @param options - The environment, the machine, and whether to stay offline.
 * @returns The result.
 */
export function checkConfig(
  path: string,
  options: { env?: Env; machine?: MachineEnv; offline?: boolean } = {},
): CheckedConfig {
  const env = options.env ?? process.env;
  const load = loadConfig(path, env);
  if (!load.config) {
    return {
      load,
      findings: { errors: load.issues, warnings: [] },
      config: null,
    };
  }
  const machine = options.machine ?? realMachine(env);
  const findings = mergeFindings(
    validateReferences(load.config),
    validateMachine(load.config, machine, { offline: options.offline }),
  );
  return {
    load,
    findings,
    config: findings.errors.length === 0 ? load.config : null,
  };
}

/**
 * One issue as a line: `path: message`, or `file:line:column: message` for a
 * syntax error.
 * @param issue - The issue.
 * @param file - The file, for syntax errors.
 * @returns The line.
 */
export function formatIssue(issue: ConfigIssue, file?: string): string {
  const where =
    issue.line !== undefined
      ? `${file ?? "config.toml"}:${issue.line}:${issue.column ?? 1}: `
      : issue.path
        ? `${issue.path}: `
        : "";
  return `${where}${issue.message}${issue.hint ? ` (${issue.hint})` : ""}`;
}

/**
 * A summary line: `2 errors, 1 warning`.
 * @param findings - The findings.
 * @returns The line.
 */
export function summarize(findings: Findings): string {
  const plural = (n: number, word: string) =>
    `${n} ${word}${n === 1 ? "" : "s"}`;
  return `${plural(findings.errors.length, "error")}, ${plural(findings.warnings.length, "warning")}`;
}
