/**
 * Start the reserved local ngrok endpoints in {@link ../../ngrok.yml}.
 *
 * Merges the user's default ngrok config (where `ngrok config add-authtoken`
 * writes the token) in front of this repo's file, then `ngrok start --all`.
 * The token never lives in the repo.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** Public origin of the local API tunnel. */
export const LOCAL_BACKEND_TUNNEL_URL =
  "https://hypotenuse-local-backend.ngrok.app";

/** Public origin of the local Vite tunnel. */
export const LOCAL_FRONTEND_TUNNEL_URL =
  "https://hypotenuse-local-frontend.ngrok.app";

/** Where the backend tunnel dials. IPv6 loopback — see `ngrok.yml`. */
export const LOCAL_BACKEND_UPSTREAM_URL = "http://[::1]:8080";

/** Where the frontend tunnel dials. IPv6 loopback — see `ngrok.yml`. */
export const LOCAL_FRONTEND_UPSTREAM_URL = "http://[::1]:3000";

const REPO_ROOT = resolve(dirname(Bun.fileURLToPath(import.meta.url)), "../..");

/** Path to the committed endpoints file. */
export const REPO_NGROK_CONFIG = join(REPO_ROOT, "ngrok.yml");

/**
 * Candidate locations of the agent default config, in the order ngrok itself
 * checks on this machine.
 * @param home - The user's home directory.
 * @returns Absolute paths, first existing win is enough.
 */
export function defaultNgrokConfigCandidates(home: string): string[] {
  return [
    join(home, "Library/Application Support/ngrok/ngrok.yml"),
    join(home, ".config/ngrok/ngrok.yml"),
    join(home, ".ngrok2/ngrok.yml"),
  ];
}

/**
 * Config files to merge *before* the repo endpoints, so the authtoken comes
 * from the operator's machine rather than from git.
 * @param env - Process environment. `NGROK_CONFIG` wins when it names a file.
 * @param home - Home directory used to find the agent default.
 * @param exists - Injectable so the suite does not depend on this box.
 * @returns Existing config paths, in merge order.
 */
export function userNgrokConfigPaths(
  env: NodeJS.ProcessEnv = Bun.env,
  home: string = homedir(),
  exists: (path: string) => boolean = existsSync,
): string[] {
  const paths: string[] = [];
  const fromEnv = env.NGROK_CONFIG?.trim();
  if (fromEnv && exists(fromEnv)) paths.push(fromEnv);

  for (const candidate of defaultNgrokConfigCandidates(home)) {
    if (exists(candidate) && !paths.includes(candidate)) {
      paths.push(candidate);
      break;
    }
  }
  return paths;
}

/**
 * Build `ngrok start` argv: user configs first, repo endpoints last.
 * @param repoConfig - This checkout's `ngrok.yml`.
 * @param userConfigs - Authtoken-bearing files to merge in front.
 * @returns Arguments for `ngrok`, not including the binary name.
 */
export function buildNgrokStartArgs(
  repoConfig: string,
  userConfigs: readonly string[],
): string[] {
  const args = ["start", "--all"];
  for (const config of userConfigs) {
    args.push("--config", config);
  }
  args.push("--config", repoConfig);
  return args;
}

/**
 * Start both reserved tunnels and wait until the agent exits.
 * @returns The process exit code.
 */
async function main(): Promise<number> {
  const binary = Bun.which("ngrok");
  if (!binary) {
    console.error(
      "ngrok is not on PATH. Install it (`brew install ngrok`) and run `ngrok config add-authtoken <token>`.",
    );
    return 1;
  }
  if (!existsSync(REPO_NGROK_CONFIG)) {
    console.error(`missing ngrok config at ${REPO_NGROK_CONFIG}`);
    return 1;
  }

  const userConfigs = userNgrokConfigPaths();
  if (userConfigs.length === 0 && !Bun.env.NGROK_AUTHTOKEN?.trim()) {
    console.error(
      "No ngrok authtoken found. Run `ngrok config add-authtoken <token>` (or set NGROK_AUTHTOKEN).",
    );
    return 1;
  }

  const args = buildNgrokStartArgs(REPO_NGROK_CONFIG, userConfigs);
  console.log(`${LOCAL_BACKEND_TUNNEL_URL}  →  ${LOCAL_BACKEND_UPSTREAM_URL}`);
  console.log(
    `${LOCAL_FRONTEND_TUNNEL_URL}  →  ${LOCAL_FRONTEND_UPSTREAM_URL}`,
  );

  const proc = Bun.spawn([binary, ...args], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return (await proc.exited) ?? 1;
}

if (import.meta.main) {
  process.exit(await main());
}
