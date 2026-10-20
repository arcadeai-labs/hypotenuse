import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/** `frontend/src`. */
export const SRC = join(import.meta.dir, "..");

/**
 * Every file under `frontend/src` with one of the given extensions, except the
 * tests themselves and generated files.
 * @param extensions - e.g. `[".scss", ".tsx"]`.
 * @returns `{ path, body }` with `path` relative to `src/`.
 */
export function sourceFiles(extensions: string[]): Array<{ path: string; body: string }> {
  const out: Array<{ path: string; body: string }> = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        if (name !== "__tests__") walk(full);
      } else if (extensions.some((ext) => name.endsWith(ext)) && !name.includes(".generated.")) {
        out.push({ path: relative(SRC, full), body: readFileSync(full, "utf8") });
      }
    }
  };
  walk(SRC);
  return out;
}

/**
 * Remove comments so a scan judges rules, not prose about them.
 * @param body - CSS, SCSS, or TSX source.
 * @returns The source with block and line comments blanked.
 */
export function stripComments(body: string): string {
  return body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'])\/\/.*$/gm, "$1");
}
