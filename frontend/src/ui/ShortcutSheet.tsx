import { BUILTIN_SHORTCUTS } from "../commands/keymap";
import type { Command } from "../commands/registry";
import { Kbd } from "./Kbd";
import { Sheet } from "./Sheet";

/**
 * The `?` sheet: every key the shell answers, from the same registry the
 * palette and keymap read, so it cannot list a shortcut that does nothing.
 * @param props - `open`, `onClose`, and the commands that apply now.
 * @returns The sheet.
 */
export function ShortcutSheet({
  open,
  onClose,
  commands,
}: {
  open: boolean;
  onClose: () => void;
  commands: Command[];
}) {
  const rows = [
    ...BUILTIN_SHORTCUTS,
    ...commands.flatMap((c) =>
      c.shortcut ? [{ keys: c.shortcut, title: c.title }] : [],
    ),
  ];
  return (
    <Sheet
      open={open}
      onClose={onClose}
      side="right"
      title="Keyboard shortcuts"
      data-testid="shortcut-sheet"
    >
      <dl className="ui-shortcuts">
        {rows.map((row) => (
          <div key={row.keys} className="ui-shortcut">
            <dt>{row.title}</dt>
            <dd>
              <Kbd keys={row.keys} />
            </dd>
          </div>
        ))}
      </dl>
    </Sheet>
  );
}
