import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

/**
 * Dependencies between the three workspaces run one way only.
 *
 * | Workspace   | Must never import                                              |
 * |-------------|----------------------------------------------------------------|
 * | `backend/`  | `cli/`, `frontend/`                                            |
 * | `cli/`      | `keryx`, `drizzle-orm`, `pg`, `ioredis`, a value from `@backend/*` |
 * | `frontend/` | `cli/`, a value from `@backend/*`                              |
 *
 * The CLI ships as a compiled binary on people's laptops. One that carried
 * Keryx, Drizzle, Postgres, and Redis clients would be large, and the first
 * server-only import deep in a module would break `bun build --compile` for
 * one platform only. The frontend reads backend *types* through `@backend/*`
 * and nothing else, so no server code reaches a browser bundle.
 */

const REPO_ROOT = join(import.meta.dir, "..", "..");

/** The workspace directories, by name. */
const WORKSPACES = ["backend", "frontend", "cli"] as const;
type Workspace = (typeof WORKSPACES)[number];

/** Each workspace's published package name, for bare-specifier imports. */
const PACKAGE_NAMES: Record<Workspace, string> = {
  backend: "hypotenuse-backend",
  frontend: "hypotenuse-frontend",
  cli: "@arcadeai/hypotenuse",
};

/** Server framework and drivers the CLI must never load. */
const SERVER_ONLY = [/^keryx(\/|$)/, /^drizzle-orm(\/|$)/, /^pg$/, /^ioredis$/];

/** Where each workspace's scanned source lives, and what is not ours. */
const SCANNED: Record<Workspace, { dir: string; glob: string }> = {
  backend: { dir: "backend", glob: "**/*.{ts,tsx}" },
  frontend: { dir: "frontend", glob: "**/*.{ts,tsx}" },
  // Only what is compiled into the binary; tests run under `bun test`.
  cli: { dir: "cli/src", glob: "**/*.{ts,tsx}" },
};
const IGNORED = /(^|\/)(node_modules|dist|\.cache|drizzle)(\/|$)/;

/** One import found in a source file. */
interface Import {
  spec: string;
  typeOnly: boolean;
}

/**
 * Every module specifier a source file loads, with whether it is erased at
 * compile time. `import { type X }` is not type-only: under
 * `verbatimModuleSyntax` it survives as a side-effect import.
 * @param source - File contents.
 * @returns The imports, static, side-effect, re-export, and dynamic.
 */
function importsOf(source: string): Import[] {
  const found: Import[] = [];
  const fromClause =
    /(?:^|\n)\s*(import|export)\s+(type\s+)?[^'"]*?from\s+["']([^"']+)["']/g;
  for (const m of source.matchAll(fromClause)) {
    found.push({ spec: m[3]!, typeOnly: Boolean(m[2]) });
  }
  const bare = /(?:^|\n)\s*import\s+["']([^"']+)["']/g;
  for (const m of source.matchAll(bare)) {
    found.push({ spec: m[1]!, typeOnly: false });
  }
  const dynamic = /(?:import|require)\(\s*["']([^"']+)["']\s*\)/g;
  for (const m of source.matchAll(dynamic)) {
    found.push({ spec: m[1]!, typeOnly: false });
  }
  return found;
}

/**
 * Which workspace a specifier lands in, if it names one.
 * @param file - The importing file, repo-relative.
 * @param spec - The import specifier.
 * @returns The target workspace, or `null` for a package or a path outside all three.
 */
function targetWorkspace(file: string, spec: string): Workspace | null {
  if (spec.startsWith("@backend/")) return "backend";
  for (const workspace of WORKSPACES) {
    const name = PACKAGE_NAMES[workspace];
    if (spec === name || spec.startsWith(`${name}/`)) return workspace;
  }
  if (!spec.startsWith(".")) return null;
  const target = relative(REPO_ROOT, resolve(REPO_ROOT, dirname(file), spec));
  const top = target.split(sep)[0];
  return WORKSPACES.find((w) => w === top) ?? null;
}

/**
 * Every source file of a workspace with the imports it makes.
 * @param workspace - The workspace to scan.
 * @returns Repo-relative paths and their imports.
 */
function sources(workspace: Workspace): { file: string; imports: Import[] }[] {
  const { dir, glob } = SCANNED[workspace];
  const cwd = join(REPO_ROOT, dir);
  const out: { file: string; imports: Import[] }[] = [];
  for (const file of new Bun.Glob(glob).scanSync({ cwd })) {
    if (IGNORED.test(file)) continue;
    out.push({
      file: join(dir, file),
      imports: importsOf(readFileSync(join(cwd, file), "utf8")),
    });
  }
  return out;
}

/**
 * Whether one import breaks the dependency table.
 * @param from - The importing workspace.
 * @param file - The importing file, repo-relative.
 * @param imp - The import.
 * @returns Why it is forbidden, or `null` when it is allowed.
 */
function violation(from: Workspace, file: string, imp: Import): string | null {
  if (from === "cli" && SERVER_ONLY.some((re) => re.test(imp.spec))) {
    return "a server framework or driver";
  }
  const to = targetWorkspace(file, imp.spec);
  if (to === null || to === from) return null;
  if (to === "backend" && from !== "backend") {
    return imp.typeOnly ? null : "a value from the backend";
  }
  return `the ${to} workspace`;
}

describe("workspace import boundaries", () => {
  for (const workspace of WORKSPACES) {
    test(`${workspace} imports only what the dependency table allows`, () => {
      const files = sources(workspace);
      expect(files.length).toBeGreaterThan(0);
      const offenders: string[] = [];
      for (const { file, imports } of files) {
        for (const imp of imports) {
          const why = violation(workspace, file, imp);
          if (why) offenders.push(`${file}: ${imp.spec} (${why})`);
        }
      }
      expect(offenders).toEqual([]);
    });
  }
});

describe("the boundary check itself", () => {
  test("type-only imports are erased; inline type imports are not", () => {
    expect(
      importsOf(
        [
          `import type { Status } from "@backend/actions/status";`,
          `import { type Status } from "@backend/actions/status";`,
          `import "../backend/index";`,
          `await import("keryx");`,
        ].join("\n"),
      ),
    ).toEqual([
      { spec: "@backend/actions/status", typeOnly: true },
      { spec: "@backend/actions/status", typeOnly: false },
      { spec: "../backend/index", typeOnly: false },
      { spec: "keryx", typeOnly: false },
    ]);
  });

  test("each forbidden edge is caught", () => {
    const cases: [Workspace, string, Import][] = [
      ["cli", "cli/src/a.ts", { spec: "keryx", typeOnly: false }],
      ["cli", "cli/src/a.ts", { spec: "@backend/x", typeOnly: false }],
      ["cli", "cli/src/a.ts", { spec: "../../frontend/x", typeOnly: true }],
      [
        "frontend",
        "frontend/src/a.ts",
        { spec: "@backend/x", typeOnly: false },
      ],
      [
        "frontend",
        "frontend/src/a.ts",
        { spec: "../../cli/x", typeOnly: true },
      ],
      ["backend", "backend/a.ts", { spec: "../cli/src/x", typeOnly: true }],
      [
        "backend",
        "backend/a.ts",
        { spec: "hypotenuse-frontend", typeOnly: true },
      ],
    ];
    for (const [from, file, imp] of cases) {
      expect(violation(from, file, imp), imp.spec).not.toBeNull();
    }
  });

  test("the allowed edges pass", () => {
    expect(
      violation("frontend", "frontend/src/a.ts", {
        spec: "@backend/actions/status",
        typeOnly: true,
      }),
    ).toBeNull();
    expect(
      violation("backend", "backend/actions/a.ts", {
        spec: "../package.json",
        typeOnly: false,
      }),
    ).toBeNull();
  });
});
