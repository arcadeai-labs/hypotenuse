import type { HTMLAttributes } from "react";
import { cx } from "./cx";

/** How each key name is drawn. Anything not listed is drawn as typed. */
const KEY_GLYPHS: Record<string, string> = {
  mod: "⌘",
  meta: "⌘",
  cmd: "⌘",
  ctrl: "Ctrl",
  shift: "⇧",
  alt: "⌥",
  enter: "↵",
  esc: "Esc",
  escape: "Esc",
  up: "↑",
  down: "↓",
  left: "←",
  right: "→",
};

/**
 * How one key reads as a hint.
 * @param key - A key name from a keymap (`mod`, `enter`, `g`, `?`).
 * @returns The glyph or text to show.
 */
export function keyLabel(key: string): string {
  return KEY_GLYPHS[key.toLowerCase()] ?? key.toUpperCase();
}

/**
 * A key hint. `keys` is a chord or sequence written the way the keymap writes
 * it — `"mod+k"` is one chord, `"g s"` is two keys in a row — and each key gets
 * its own cap.
 * @param props - `keys` and native element props.
 * @returns The key caps.
 */
export function Kbd({
  keys,
  className,
  ...props
}: HTMLAttributes<HTMLElement> & { keys: string }) {
  const steps = keys.trim().split(/\s+/);
  return (
    <span {...props} className={cx("ui-kbd-group", className)}>
      {steps.map((step, i) => (
        <span key={`${i}-${step}`} className="ui-kbd-step">
          {step
            .split("+")
            .filter(Boolean)
            .map((key) => (
              <kbd key={key} className="ui-kbd">
                {keyLabel(key)}
              </kbd>
            ))}
        </span>
      ))}
    </span>
  );
}
