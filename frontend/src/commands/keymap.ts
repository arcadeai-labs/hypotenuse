import type { Command } from "./registry";

/**
 * Keys the shell handles itself rather than through a command: the palette
 * opener, and the list keys a focused list owns. Listed so the shortcut sheet
 * shows them from the same place.
 */
export const BUILTIN_SHORTCUTS: Array<{ keys: string; title: string }> = [
  { keys: "mod+k", title: "Open command palette" },
  { keys: "j", title: "Next row" },
  { keys: "k", title: "Previous row" },
  { keys: "enter", title: "Open row" },
  { keys: "esc", title: "Close or go back" },
];

/** How long the second key of a `g s` sequence may wait for the first. */
export const SEQUENCE_TIMEOUT_MS = 1000;

/**
 * The key name a shortcut string uses for an event, or null for a key that is
 * never part of a shortcut (modifiers held alone, IME composition).
 * @param event - The keyboard event (only `key` and the modifier flags are read).
 * @returns e.g. `"g"`, `"?"`, `"mod+k"`.
 */
export function keyName(
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey">,
): string | null {
  if (
    ["Shift", "Meta", "Control", "Alt", "Dead", "Process"].includes(event.key)
  )
    return null;
  const key = event.key.toLowerCase();
  if (event.metaKey || event.ctrlKey) return `mod+${key}`;
  if (event.altKey) return null;
  return key === "escape" ? "esc" : key;
}

/**
 * Whether a keystroke should be left to the element that has focus: anything
 * typed into a field, and anything inside an open dialog that owns its keys.
 * @param target - The event target.
 * @returns True if the keymap must ignore the event.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

/**
 * A matcher for multi-key sequences over a command list. Feed it key names; it
 * answers the command whose whole shortcut was just typed, or null.
 * @param commands - Commands with shortcuts.
 * @param now - Clock, injectable for tests.
 * @returns `press(key)`.
 */
export function createSequenceMatcher(
  commands: Command[],
  now: () => number = Date.now,
) {
  const bound = commands.filter((c) => c.shortcut);
  let buffer: string[] = [];
  let last = 0;
  return {
    /**
     * Record one key.
     * @param key - From `keyName`.
     * @returns The command completed by this key, if any.
     */
    press(key: string): Command | null {
      const t = now();
      if (t - last > SEQUENCE_TIMEOUT_MS) buffer = [];
      last = t;
      buffer.push(key);
      const typed = buffer.join(" ");
      const exact = bound.find((c) => c.shortcut === typed);
      if (exact) {
        buffer = [];
        return exact;
      }
      // Keep the buffer only while it is still a prefix of something.
      if (!bound.some((c) => c.shortcut?.startsWith(`${typed} `))) {
        buffer = [];
        // A key that broke a sequence may start a new one on its own.
        const single = bound.find((c) => c.shortcut === key);
        if (single) return single;
        if (bound.some((c) => c.shortcut?.startsWith(`${key} `)))
          buffer = [key];
      }
      return null;
    },
  };
}

/**
 * Render a shortcut string for display, using ⌘ on Apple platforms and Ctrl elsewhere.
 * @param shortcut - e.g. `"mod+k"` or `"g s"`.
 * @param apple - Whether to render `mod` as ⌘.
 * @returns One string per key, for `Kbd` to wrap.
 */
export function displayKeys(shortcut: string, apple: boolean): string[] {
  return shortcut.split(" ").flatMap((chord) =>
    chord.split("+").map((part) => {
      if (part === "mod") return apple ? "⌘" : "Ctrl";
      if (part === "esc") return "Esc";
      if (part === "enter") return "↵";
      return part.length === 1 ? part.toUpperCase() : part;
    }),
  );
}
