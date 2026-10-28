import { describe, expect, test } from "bun:test";
import { BUILTIN_SHORTCUTS, displayKeys, keyLabel } from "../commands/keymap";
import { COMMANDS } from "../commands/registry";

// Key caps, the palette, and the shortcut sheet all read key names through
// `keyLabel`, so there is one place a name becomes a glyph.

describe("key labels", () => {
  test("mod follows the platform; named keys get glyphs; letters uppercase", () => {
    expect(keyLabel("mod", true)).toBe("⌘");
    expect(keyLabel("mod", false)).toBe("Ctrl");
    expect(keyLabel("enter", true)).toBe("↵");
    expect(keyLabel("esc", false)).toBe("Esc");
    expect(keyLabel("g", true)).toBe("G");
    expect(keyLabel("?", true)).toBe("?");
  });

  test("displayKeys is keyLabel over every key of a shortcut", () => {
    expect(displayKeys("mod+k", false)).toEqual(["Ctrl", "K"]);
    expect(displayKeys("g  s", true)).toEqual(["G", "S"]);
  });

  test("no command reuses a key the shell handles itself", () => {
    const builtin = new Set(BUILTIN_SHORTCUTS.map((s) => s.keys));
    expect(
      COMMANDS.filter((c) => c.shortcut && builtin.has(c.shortcut)).map(
        (c) => c.id,
      ),
    ).toEqual([]);
  });
});
