/**
 * ACP `fs/read_text_file` and `fs/write_text_file`, confined to the session's
 * worktree and the role's `additional_directories`. A path is resolved with
 * `realpath` (for a write, its nearest existing ancestor's), so neither `../`
 * nor a symlink leads out. These handlers are the only file access the
 * daemon performs for an agent; an agent writing files itself is confined by
 * its own sandbox, not by these.
 */
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

/** Why a path was refused. */
export class OutsideWorktree extends Error {
  /**
   * @param path - The path asked for.
   */
  constructor(readonly path: string) {
    super("outside the session worktree");
  }
}

/** Reads and writes inside a set of roots. */
export class ConfinedFs {
  private readonly roots: string[];

  /**
   * @param roots - The worktree first, then any additional directories.
   */
  constructor(roots: readonly string[]) {
    this.roots = roots.flatMap((root) => {
      try {
        return [realpathSync(root)];
      } catch {
        return [];
      }
    });
  }

  /**
   * Whether a real path is inside a root.
   * @param real - A resolved path.
   * @returns True inside (or equal to) a root.
   */
  private inside(real: string): boolean {
    return this.roots.some(
      (root) =>
        real === root ||
        real.startsWith(root.endsWith(sep) ? root : root + sep),
    );
  }

  /**
   * The real path of an existing file, or a refusal.
   * @param path - The agent's path (absolute, or relative to the worktree).
   * @returns The real path.
   */
  private resolveExisting(path: string): string {
    const absolute = this.absolute(path);
    let real: string;
    try {
      real = realpathSync(absolute);
    } catch {
      // A file that does not exist is checked by its parent.
      real = join(this.resolveParent(absolute), basename(absolute));
      return real;
    }
    if (!this.inside(real)) throw new OutsideWorktree(path);
    return real;
  }

  /**
   * The real path of a path's nearest existing ancestor, checked.
   * @param absolute - An absolute path.
   * @returns The real parent directory joined with the missing segments.
   */
  private resolveParent(absolute: string): string {
    let dir = dirname(absolute);
    const missing: string[] = [];
    while (!existsSync(dir) && dirname(dir) !== dir) {
      missing.unshift(basename(dir));
      dir = dirname(dir);
    }
    let real: string;
    try {
      real = realpathSync(dir);
    } catch {
      throw new OutsideWorktree(absolute);
    }
    const full = join(real, ...missing);
    if (!this.inside(full)) throw new OutsideWorktree(absolute);
    return full;
  }

  /**
   * An agent's path made absolute against the worktree.
   * @param path - The path.
   * @returns An absolute, normalized path.
   */
  private absolute(path: string): string {
    const root = this.roots[0];
    if (!root) throw new OutsideWorktree(path);
    return isAbsolute(path) ? resolve(path) : resolve(root, path);
  }

  /**
   * `fs/read_text_file`.
   * @param path - The file.
   * @param line - The first line to return, 1-based.
   * @param limit - How many lines.
   * @returns The content.
   */
  read(path: string, line?: number | null, limit?: number | null): string {
    const real = this.resolveExisting(path);
    const text = readFileSync(real, "utf8");
    if (!line && !limit) return text;
    const lines = text.split("\n");
    const start = Math.max(0, (line ?? 1) - 1);
    const end = limit ? start + limit : lines.length;
    return lines.slice(start, end).join("\n");
  }

  /**
   * `fs/write_text_file`: create parent directories, write atomically.
   * @param path - The file.
   * @param content - Its new content.
   */
  write(path: string, content: string): void {
    const absolute = this.absolute(path);
    let target: string;
    if (existsSync(absolute)) {
      target = realpathSync(absolute);
      if (!this.inside(target)) throw new OutsideWorktree(path);
    } else {
      target = join(this.resolveParent(absolute), basename(absolute));
    }
    mkdirSync(dirname(target), { recursive: true });
    const temp = join(
      dirname(target),
      `.${basename(target)}.${randomUUID()}.tmp`,
    );
    try {
      writeFileSync(temp, content);
      renameSync(temp, target);
    } catch (error) {
      rmSync(temp, { force: true });
      throw error;
    }
  }
}
