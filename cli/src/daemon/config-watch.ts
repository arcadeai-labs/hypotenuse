/**
 * Watching the daemon's config file, so an edit applies without
 * `hypotenuse daemon reload`.
 *
 * The directory is watched, not the file: editors save by writing a new file
 * and renaming it over the old one, which a watch on the file itself stops
 * seeing after the first save. Events are debounced (one save is several
 * events), and a change is reported only when the file's bytes differ from the
 * last ones seen — a save with no edit, or a touch, is not a change.
 */
import { createHash } from "node:crypto";
import { existsSync, type FSWatcher, readFileSync, watch } from "node:fs";
import { basename, dirname } from "node:path";

/** How long a burst of events must go quiet before the file is read. */
export const CONFIG_WATCH_DEBOUNCE_MS = 300;

/** A running watch. */
export interface ConfigWatcher {
  /** Stop watching. */
  close(): void;
}

/**
 * The file's content hash, or null while it is missing (mid-rename).
 * @param path - The file.
 * @returns A hex digest, or null.
 */
function digest(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return null;
  }
}

/**
 * Call `onChange` whenever the file's content changes.
 * @param path - The config file.
 * @param onChange - Called once per settled change.
 * @param options - The debounce, and where a watch failure is reported.
 * @returns The watch, or null when the directory cannot be watched.
 */
export function watchConfigFile(
  path: string,
  onChange: () => void,
  options: { debounceMs?: number; onError?: (error: unknown) => void } = {},
): ConfigWatcher | null {
  const name = basename(path);
  let last = digest(path);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let watcher: FSWatcher;

  const settle = () => {
    timer = null;
    const now = digest(path);
    // Missing: the editor is between unlink and rename; its next event
    // brings the new file.
    if (now === null || now === last) return;
    last = now;
    onChange();
  };

  try {
    watcher = watch(dirname(path), (_event, file) => {
      if (file !== null && file !== name) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(
        settle,
        options.debounceMs ?? CONFIG_WATCH_DEBOUNCE_MS,
      );
    });
  } catch (error) {
    options.onError?.(error);
    return null;
  }
  watcher.on("error", (error) => options.onError?.(error));

  return {
    close() {
      if (timer) clearTimeout(timer);
      watcher.close();
    },
  };
}
