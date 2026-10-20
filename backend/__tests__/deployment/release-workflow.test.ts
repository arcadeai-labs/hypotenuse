import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The release workflow is not code, and its feedback loop is a broken release
// on `main` — a published tag nobody can re-run, or binaries nobody can upgrade
// to. These tests parse the real files and assert the order and shape the
// release depends on.

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

/**
 * Read a repo-root-relative file.
 * @param relativePath - Path from the repository root.
 * @returns Its text.
 */
function read(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), "utf8");
}

/** One step of a job. */
interface Step {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, string>;
  env?: Record<string, string>;
  "working-directory"?: string;
}

/** One job of a workflow. */
interface Job {
  needs?: string | string[];
  if?: string;
  permissions?: Record<string, string>;
  steps: Step[];
  strategy?: { matrix?: { include?: { target: string; asset: string }[] } };
}

const workflow = Bun.YAML.parse(read(".github/workflows/auto-release.yml")) as {
  on: Record<string, unknown>;
  permissions?: Record<string, string>;
  jobs: Record<string, Job>;
};
const ci = Bun.YAML.parse(read(".github/workflows/ci.yml")) as {
  jobs: Record<string, Job>;
};
const jobs = workflow.jobs;
const cliPkg = JSON.parse(read("cli/package.json")) as {
  name: string;
  bin: Record<string, string>;
  repository: { url: string };
};

/**
 * A job's `needs`, as an array.
 * @param name - The job.
 * @returns The jobs it waits for.
 */
function needsOf(name: string): string[] {
  const needs = jobs[name]?.needs;
  if (!needs) return [];
  return Array.isArray(needs) ? needs : [needs];
}

/**
 * Every job a job transitively waits for.
 * @param name - The job.
 * @returns Its ancestors.
 */
function ancestorsOf(name: string): Set<string> {
  const seen = new Set<string>();
  const stack = [...needsOf(name)];
  while (stack.length > 0) {
    const next = stack.pop() as string;
    if (seen.has(next)) continue;
    seen.add(next);
    stack.push(...needsOf(next));
  }
  return seen;
}

/**
 * Every `run:` script in a job, joined.
 * @param name - The job.
 * @returns The scripts.
 */
function scriptOf(name: string): string {
  return (jobs[name]?.steps ?? []).map((s) => s.run ?? "").join("\n");
}

/** The six release targets and the asset each produces. */
const TARGETS = [
  { target: "bun-darwin-arm64", asset: "hypotenuse-darwin-arm64" },
  { target: "bun-darwin-x64", asset: "hypotenuse-darwin-x64" },
  { target: "bun-linux-arm64", asset: "hypotenuse-linux-arm64" },
  { target: "bun-linux-x64", asset: "hypotenuse-linux-x64" },
  { target: "bun-windows-x64", asset: "hypotenuse-windows-x64.exe" },
  { target: "bun-windows-arm64", asset: "hypotenuse-windows-arm64.exe" },
];

describe("auto-release.yml", () => {
  test("runs on pushes to main (and by hand), never on pull requests", () => {
    expect(Object.keys(workflow.on).sort()).toEqual(
      ["push", "workflow_dispatch"].sort(),
    );
    expect(workflow.on.push).toEqual({ branches: ["main"] });
  });

  test("the version is read from cli/package.json", () => {
    expect(scriptOf("check-version")).toContain(
      "jq -r .version cli/package.json",
    );
  });

  test("only a published release stops a run; a draft is resumed", () => {
    const script = scriptOf("check-version");
    expect(script).toContain("isDraft");
    expect(script).toContain('"$IS_DRAFT" = "false"');
    for (const name of Object.keys(jobs)) {
      if (name === "check-version") continue;
      expect(jobs[name]?.if, name).toBe(
        "needs.check-version.outputs.should_release == 'true'",
      );
    }
  });

  test("ci runs before the release is created, and runs the upgrade path", () => {
    expect(ancestorsOf("create-release").has("ci")).toBe(true);
    const script = scriptOf("ci");
    expect(script).toContain("bun install --frozen-lockfile");
    expect(script).toContain("bun run lint");
    expect(script).toContain("bun run --cwd cli test");
    expect(script).toContain("bash cli/test/e2e/test-upgrade.sh");
  });

  test("the release is created as a draft, and reused when it already exists", () => {
    const script = scriptOf("create-release");
    expect(script).toMatch(/gh release create "\$TAG" --draft/);
    expect(script).toContain('gh release view "$TAG"');
  });

  test("both publish jobs run against the draft, after it exists", () => {
    for (const name of ["publish-npm", "build-binaries"]) {
      expect(ancestorsOf(name).has("create-release"), name).toBe(true);
      expect(ancestorsOf(name).has("ci"), name).toBe(true);
    }
  });

  test("only a job that needs both publish jobs un-drafts the release", () => {
    const undrafting = Object.keys(jobs).filter((name) =>
      scriptOf(name).includes("--draft=false"),
    );
    expect(undrafting).toEqual(["finalize"]);
    expect(needsOf("finalize")).toContain("publish-npm");
    expect(needsOf("finalize")).toContain("build-binaries");
  });

  test("npm is published by trusted publishing, with provenance and no token", () => {
    const publish = jobs["publish-npm"] as Job;
    expect(publish.permissions?.["id-token"]).toBe("write");
    expect(read(".github/workflows/auto-release.yml")).not.toMatch(
      /secrets\.NPM_TOKEN|NODE_AUTH_TOKEN/,
    );
    const script = scriptOf("publish-npm");
    expect(script).toContain("npm publish --provenance --access public");
    // Trusted publishing needs npm 11.5.1 or later.
    expect(script).toMatch(/npm install -g npm@\^11\.5\.1/);
    const step = publish.steps.find((s) =>
      s.run?.includes("npm publish"),
    ) as Step;
    expect(step["working-directory"]).toBe("cli");
    // A resumed run finds its version already published and moves on.
    expect(script).toContain('npm view "@arcadeai/hypotenuse@$VERSION"');
  });

  test("the matrix is exactly the six targets and their asset names", () => {
    const include = jobs["build-binaries"]?.strategy?.matrix?.include ?? [];
    expect(include).toEqual(TARGETS);
    const script = scriptOf("build-binaries");
    expect(script).toContain("--target=${{ matrix.target }}");
    expect(script).toContain("./cli/src/cli.ts");
    expect(script).toContain('gh release upload "$TAG"');
  });

  test("asset names are what upgradr downloads: <first bin key>-<os>-<arch>[.exe]", () => {
    const bin = Object.keys(cliPkg.bin)[0];
    for (const { target, asset } of TARGETS) {
      const [, os, arch] = target.split("-");
      expect(asset).toBe(
        `${bin}-${os}-${arch}${os === "windows" ? ".exe" : ""}`,
      );
    }
    expect(cliPkg.repository.url).toBe(
      "https://github.com/arcadeai-labs/hypotenuse.git",
    );
  });

  test("is outside ci.yml's gate", () => {
    // A publish is not a check: nothing here is a required status, and nothing
    // in the gate waits on a publish.
    expect(Object.keys(jobs)).not.toContain("complete");
    const ciNeeds = ci.jobs.complete?.needs as string[];
    for (const name of Object.keys(jobs)) {
      if (name === "ci") continue;
      expect(ciNeeds, name).not.toContain(name);
    }
    expect(read(".github/workflows/ci.yml")).not.toContain("auto-release");
  });
});

describe("ci.yml", () => {
  test("the CLI Upgrade job runs test-upgrade.sh inside the gate", () => {
    const job = ci.jobs["cli-upgrade"] as Job & { name?: string };
    expect(job.name).toBe("CLI Upgrade");
    expect(job.steps.map((s) => s.run ?? "").join("\n")).toContain(
      "bash cli/test/e2e/test-upgrade.sh",
    );
    expect(ci.jobs.complete?.needs).toContain("cli-upgrade");
  });
});

describe("install scripts", () => {
  const sh = read("install.sh");
  const ps1 = read("install.ps1");
  const repo = cliPkg.repository.url
    .replace("https://github.com/", "")
    .replace(/\.git$/, "");

  test("download from this repository's releases", () => {
    expect(sh).toContain(`REPO="${repo}"`);
    expect(ps1).toContain(`$Repo = "${repo}"`);
  });

  test("ask for asset names the release publishes", () => {
    expect(sh).toContain('ASSET="hypotenuse-${os}-${arch}"');
    expect(ps1).toContain('$Asset = "hypotenuse-windows-$Arch.exe"');
    const published = new Set(TARGETS.map((t) => t.asset));
    for (const os of ["darwin", "linux"]) {
      for (const arch of ["arm64", "x64"]) {
        expect(published.has(`hypotenuse-${os}-${arch}`)).toBe(true);
      }
    }
  });

  test("honor a pinned version and an install directory", () => {
    expect(sh).toContain("HYPOTENUSE_VERSION");
    expect(sh).toContain("HYPOTENUSE_INSTALL_DIR");
    expect(ps1).toContain("HYPOTENUSE_VERSION");
    expect(ps1).toContain("HYPOTENUSE_INSTALL_DIR");
  });

  test("install.sh clears macOS quarantine and fails fast", () => {
    expect(sh).toContain("set -euo pipefail");
    expect(sh).toContain("xattr -d com.apple.quarantine");
  });

  test("the Windows reinstall line the CLI prints is this script", () => {
    const upgrade = read("cli/src/commands/upgrade.ts");
    expect(upgrade).toContain(
      `irm https://raw.githubusercontent.com/${repo}/main/install.ps1 | iex`,
    );
  });
});
