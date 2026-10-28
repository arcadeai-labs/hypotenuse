import { describe, expect, test } from "bun:test";
import {
  createSequenceMatcher,
  displayKeys,
  keyName,
  SEQUENCE_TIMEOUT_MS,
} from "../commands/keymap";
import { COMMANDS } from "../commands/registry";

const key = (
  k: string,
  mods: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean }> = {},
) =>
  keyName({ key: k, metaKey: false, ctrlKey: false, altKey: false, ...mods });

describe("keymap", () => {
  test("names keys the way shortcut strings spell them", () => {
    expect(key("G")).toBe("g");
    expect(key("?")).toBe("?");
    expect(key("Escape")).toBe("esc");
    expect(key("k", { metaKey: true })).toBe("mod+k");
    expect(key("k", { ctrlKey: true })).toBe("mod+k");
    expect(key("Shift")).toBeNull();
  });

  test("matches a two-key sequence and a single key", () => {
    let t = 0;
    const m = createSequenceMatcher(COMMANDS, () => t);
    expect(m.press("g")).toBeNull();
    expect(m.press("c")?.id).toBe("go-conversations");
    expect(m.press("?")?.id).toBe("shortcuts");
    expect(m.press("[")?.id).toBe("toggle-sidebar");
  });

  test("a sequence expires, and a stray key does not swallow the next sequence", () => {
    let t = 0;
    const m = createSequenceMatcher(COMMANDS, () => t);
    m.press("g");
    t += SEQUENCE_TIMEOUT_MS + 1;
    expect(m.press("c")).toBeNull();
    m.press("x");
    m.press("g");
    expect(m.press("b")?.id).toBe("go-bots");
    m.press("g");
    expect(m.press("g")).toBeNull();
    expect(m.press("h")?.id).toBe("go-home");
  });

  test("every shortcut in the registry is unique", () => {
    const shortcuts = COMMANDS.flatMap((c) => (c.shortcut ? [c.shortcut] : []));
    expect(new Set(shortcuts).size).toBe(shortcuts.length);
  });

  test("renders mod per platform", () => {
    expect(displayKeys("mod+k", true)).toEqual(["⌘", "K"]);
    expect(displayKeys("mod+k", false)).toEqual(["Ctrl", "K"]);
    expect(displayKeys("g s", true)).toEqual(["G", "S"]);
  });
});
