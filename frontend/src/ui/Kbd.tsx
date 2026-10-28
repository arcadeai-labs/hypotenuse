import type { HTMLAttributes } from "react";
import { keyLabel } from "../commands/keymap";
import { cx } from "./cx";

export { keyLabel };

/**
 * A key hint. `keys` is a chord or sequence written the way the keymap writes
 * it — `"mod+k"` is one chord, `"g s"` is two keys in a row — and each key gets
 * its own cap. Labels come from `keyLabel` in the keymap, the one place a key
 * name becomes a glyph.
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
