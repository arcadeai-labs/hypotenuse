import { chmodSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { api, config } from "keryx";
import {
  gitCredentialHelperScript,
  gitCredentialUrl,
  gitSandboxConfigCommands,
} from "../../ops/GitAccessOps";
import { JOB_TOKEN_ENV } from "../../ops/SandboxProvisionOps";
import { bots } from "../../schema/bots";
import { githubInstallations } from "../../schema/github_installations";
import { repositoryGrants } from "../../schema/repository_grants";
import type { AgentStage } from "../agent/harness";
import { FakeGitHub, tryGit } from "../fakes/github/server";

/**
 * The git suites' fixtures: the GitHub fake started and configured as this
 * deployment's GitHub, an installation on `acme` holding four repositories,
 * and the project's grants, written as rows (the grant actions have their own
 * suite). Every suite restores `config.github` when it is done.
 *
 * | Repository | Grant |
 * |---|---|
 * | `acme/api` | push, every bot |
 * | `acme/other` | push, every bot |
 * | `acme/lib` | read, every bot |
 * | `acme/secret` | push, another bot only |
 */
export interface GitStage {
  github: FakeGitHub;
  /** The bot's slug, for its branch prefix. */
  botSlug: string;
  /** Put `config.github` back and stop the fake. */
  restore: () => Promise<void>;
}

/**
 * Start the fake and write the project's installation and grants.
 * @param stage - The sandbox stage.
 * @returns The fake and a restore.
 */
export async function buildGitStage(stage: AgentStage): Promise<GitStage> {
  const saved = { ...config.github };
  const github = await new FakeGitHub().start();
  github.configure(config.github as unknown as Record<string, unknown>);
  github.install({
    id: "7001",
    login: "acme",
    repositories: ["api", "other", "lib", "secret"],
  });
  for (const name of ["api", "other", "lib", "secret"]) {
    await github.createRepository("acme", name);
  }
  const [installation] = await api.db.db
    .insert(githubInstallations)
    .values({
      projectId: stage.u.projectId,
      installationId: "7001",
      accountLogin: "acme",
      accountType: "Organization",
    })
    .returning();
  const grant = (name: string, push: boolean, botIds: number[] | null) => ({
    projectId: stage.u.projectId,
    githubInstallationId: installation.id,
    owner: "acme",
    name,
    push,
    botIds,
  });
  await api.db.db
    .insert(repositoryGrants)
    .values([
      grant("api", true, null),
      grant("other", true, null),
      grant("lib", false, null),
      grant("secret", true, [stage.botId + 100_000]),
    ]);
  const [bot] = await api.db.db
    .select({ slug: bots.slug })
    .from(bots)
    .where(eq(bots.id, stage.botId));
  return {
    github,
    botSlug: bot.slug,
    restore: async () => {
      Object.assign(config.github, saved);
      await github.stop();
    },
  };
}

/**
 * A job's repository column, as `sandbox_start` writes it.
 * @param name - The repository on `acme`.
 * @param mode - What the job was started to do.
 * @returns The column's value.
 */
export function repositoryColumn(
  name: string,
  mode: "read" | "write" = "write",
): Record<string, unknown> {
  return { host: "github.com", owner: "acme", name, ref: null, mode };
}

/**
 * A temp HOME with the credential helper written (executable) and git
 * configured exactly as provisioning configures a sandbox, against the live
 * endpoint and the fake's origin.
 * @param serverUrl - Our server.
 * @param origin - The fake's origin.
 * @returns The HOME and the helper's path.
 */
export async function stageGitHome(
  serverUrl: string,
  origin: string,
): Promise<{ home: string; helperPath: string }> {
  const home = mkdtempSync(join(tmpdir(), "hypotenuse-git-home-"));
  const helperPath = join(home, "git-credential-hypotenuse");
  await Bun.write(
    helperPath,
    gitCredentialHelperScript(gitCredentialUrl(serverUrl), JOB_TOKEN_ENV),
  );
  chmodSync(helperPath, 0o755);
  for (const argv of gitSandboxConfigCommands(helperPath, origin)) {
    const out = await tryGit(argv.slice(1), home, { HOME: home });
    if (out.code !== 0) throw new Error(out.stderr);
  }
  for (const [k, v] of [
    ["user.name", "Toadsworth (Hypotenuse)"],
    ["user.email", "toadsworth@users.noreply.hypotenuse"],
  ]) {
    await tryGit(["config", "--global", k, v], home, { HOME: home });
  }
  return { home, helperPath };
}
