import { Command as Cmdk } from "cmdk";
import type { Command } from "../commands/registry";
import { Kbd } from "./Kbd";

/** See {@link CommandPalette}. */
export interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The commands that apply now — already filtered by `when`. */
  commands: Command[];
  /** Run one; the palette closes first, so a command may open another overlay. */
  onRun: (command: Command) => void;
  /**
   * Why a command is refused, or `undefined` when it may run. A refused
   * command is listed disabled with its reason — never left out.
   */
  deniedReason?: (command: Command) => string | undefined;
}

/**
 * The ⌘K palette: commands from the registry, grouped, filtered as you type,
 * each with its shortcut. Built on `cmdk`'s dialog, which owns focus and Escape.
 * @param props - See {@link CommandPaletteProps}.
 * @returns The palette (nothing in the DOM while closed).
 */
export function CommandPalette({
  open,
  onOpenChange,
  commands,
  onRun,
  deniedReason,
}: CommandPaletteProps) {
  const groups = [...new Set(commands.map((c) => c.group))];
  return (
    <Cmdk.Dialog
      open={open}
      onOpenChange={onOpenChange}
      label="Command palette"
      className="ui-palette"
      overlayClassName="ui-palette-overlay"
      contentClassName="ui-palette-content"
      data-testid="command-palette"
    >
      <Cmdk.Input
        className="ui-palette-input"
        placeholder="Type a command…"
        data-testid="command-palette-input"
      />
      <Cmdk.List className="ui-palette-list">
        <Cmdk.Empty className="ui-palette-empty">
          No matching command.
        </Cmdk.Empty>
        {groups.map((group) => (
          <Cmdk.Group key={group} heading={group} className="ui-palette-group">
            {commands
              .filter((c) => c.group === group)
              .map((command) => {
                const denied = deniedReason?.(command);
                return (
                  <Cmdk.Item
                    key={command.id}
                    value={command.title}
                    keywords={command.keywords}
                    className="ui-palette-item"
                    disabled={denied !== undefined}
                    title={denied}
                    data-testid={`command-${command.id}`}
                    onSelect={() => {
                      onOpenChange(false);
                      onRun(command);
                    }}
                  >
                    <span className="ui-palette-title">{command.title}</span>
                    {denied && (
                      <span className="ui-palette-reason">{denied}</span>
                    )}
                    {command.shortcut && <Kbd keys={command.shortcut} />}
                  </Cmdk.Item>
                );
              })}
          </Cmdk.Group>
        ))}
      </Cmdk.List>
    </Cmdk.Dialog>
  );
}
