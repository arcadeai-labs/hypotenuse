/**
 * What a runner says about the machine it runs on: a stable machine id (one
 * live runner per machine is enforced by the server on it), the platform, and
 * the heartbeat a registration sends before the daemon has ever started.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import {
  type HeartbeatRequest,
  PROTOCOL_VERSION,
} from "../../../protocol/src/index";
import pkg from "../../package.json";

/** The longest runner name the server accepts. */
const MAX_NAME = 64;

/**
 * A runner name derived from a host name: the server's rule is letters,
 * digits, `.`, `_`, and `-`, starting with a letter or digit, at most 64.
 * @param host - The host name (defaults to this machine's).
 * @returns A valid name, or `runner` when nothing usable is left.
 */
export function defaultRunnerName(host: string = hostname()): string {
  const cleaned = host
    .trim()
    .replace(/\.local$/i, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "")
    .slice(0, MAX_NAME)
    .replace(/[^A-Za-z0-9]+$/, "");
  return cleaned || "runner";
}

/**
 * The OS's own machine identifier: `/etc/machine-id` on Linux, the
 * `IOPlatformUUID` on macOS, `MachineGuid` on Windows. Falls back to the host
 * name, which is stable enough to catch the common accident.
 * `HYPOTENUSE_MACHINE_ID` replaces it — for containers built from one image,
 * which share `/etc/machine-id`, and for tests that run several runners on one
 * machine.
 * @param env - Environment variables.
 * @returns The raw identifier.
 */
export function rawMachineId(
  env: Record<string, string | undefined> = process.env,
): string {
  if (env.HYPOTENUSE_MACHINE_ID?.trim())
    return env.HYPOTENUSE_MACHINE_ID.trim();
  try {
    if (process.platform === "linux") {
      for (const path of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
        if (existsSync(path)) {
          const id = readFileSync(path, "utf8").trim();
          if (id) return id;
        }
      }
    } else if (process.platform === "darwin") {
      const out = Bun.spawnSync([
        "ioreg",
        "-rd1",
        "-c",
        "IOPlatformExpertDevice",
      ]).stdout.toString();
      const match = /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(out);
      if (match?.[1]) return match[1];
    } else if (process.platform === "win32") {
      const out = Bun.spawnSync([
        "reg",
        "query",
        "HKLM\\SOFTWARE\\Microsoft\\Cryptography",
        "/v",
        "MachineGuid",
      ]).stdout.toString();
      const match = /MachineGuid\s+REG_SZ\s+(\S+)/.exec(out);
      if (match?.[1]) return match[1];
    }
  } catch {
    // Fall through to the host name.
  }
  return `host:${hostname()}`;
}

/**
 * This machine's id as the server sees it: `sha256:` and the hex digest of
 * the OS machine id, so the raw id never leaves the machine.
 * @param raw - The raw id (defaults to {@link rawMachineId}).
 * @returns `sha256:<64 hex>`.
 */
export function machineId(raw: string = rawMachineId()): string {
  return `sha256:${createHash("sha256").update(raw).digest("hex")}`;
}

/** This platform as a runner reports it, e.g. `darwin-arm64`. */
export function platform(): string {
  return `${process.platform}-${process.arch}`;
}

/**
 * The heartbeat `runner register` sends once, before the daemon (and its
 * config) exist: who this machine is, with no capabilities yet. The daemon's
 * own heartbeats replace them.
 * @returns A valid `HeartbeatRequest`.
 */
export function registrationHeartbeat(): HeartbeatRequest {
  return {
    protocolVersion: PROTOCOL_VERSION,
    daemonVersion: pkg.version,
    platform: platform(),
    hostname: hostname().trim().slice(0, 256) || "unknown",
    draining: false,
    machineId: machineId(),
    limits: { maxParallelJobs: 1 },
    active: [],
    capabilities: {
      roles: [],
      agents: [],
      repositories: [],
      subscriptions: { teams: [], projects: [], labels: [] },
    },
  };
}
