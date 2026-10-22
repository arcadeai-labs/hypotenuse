import { describe, expect, test } from "bun:test";
import { COMMANDS, type CommandContext } from "../commands/registry";
import {
  frameTouches,
  glyphStatus,
  parseSessionsFrame,
  sessionsChannel,
  waitingLabel,
} from "../utils/sessions";

describe("the sessions channel", () => {
  test("is the project's sessions channel", () => {
    expect(sessionsChannel(7)).toBe("project:7:sessions");
  });

  test("only the two content-free frames are read; presence frames are not", () => {
    expect(parseSessionsFrame({ event: "sessions" })).toEqual({
      event: "sessions",
    });
    expect(parseSessionsFrame({ event: "session", id: 4 })).toEqual({
      event: "session",
      id: 4,
    });
    expect(parseSessionsFrame({ event: "join", presenceKey: "x" })).toBeNull();
    expect(parseSessionsFrame({ event: "leave", presenceKey: "x" })).toBeNull();
    expect(parseSessionsFrame({ event: "session", id: "4" })).toBeNull();
    expect(parseSessionsFrame({ event: "runners" })).toBeNull();
    expect(parseSessionsFrame(null)).toBeNull();
  });

  test("a session page re-reads on its own id or the whole list", () => {
    expect(frameTouches({ event: "sessions" }, 3)).toBe(true);
    expect(frameTouches({ event: "session", id: 3 }, 3)).toBe(true);
    expect(frameTouches({ event: "session", id: 4 }, 3)).toBe(false);
  });
});

describe("session labels", () => {
  test("unknown statuses draw as pending", () => {
    expect(glyphStatus("awaitingInput")).toBe("awaitingInput");
    expect(glyphStatus("something-new")).toBe("pending");
  });

  test("waiting codes read as words; unknown ones as themselves", () => {
    expect(waitingLabel("offline")).toBe("Runner offline");
    expect(waitingLabel("brand_new")).toBe("brand_new");
    expect(waitingLabel(null)).toBeNull();
  });
});

describe("dashboard commands", () => {
  /**
   * A command context with every action allowed or none.
   * @param allow - Whether `may` allows.
   * @param pathname - The current path.
   * @returns The context and what it navigated to.
   */
  function ctx(allow: boolean, pathname = "/home") {
    const went: string[] = [];
    const c: CommandContext = {
      navigate: (to) => went.push(to),
      setTheme: () => {},
      toggleSidebar: () => {},
      showShortcuts: () => {},
      focusSearch: () => {},
      may: () => allow,
      pathname,
    };
    return { c, went };
  }
  const byId = (id: string) => {
    const command = COMMANDS.find((x) => x.id === id);
    if (!command) throw new Error(`no command ${id}`);
    return command;
  };

  test("each gated command hides without permission", () => {
    for (const id of [
      "go-session",
      "cancel-session",
      "register-runner",
      "revoke-runner",
      "edit-routing-rules",
    ]) {
      expect(byId(id).when?.(ctx(false, "/sessions/1").c)).toBe(false);
    }
  });

  test("Cancel session applies only on a session page", () => {
    expect(byId("cancel-session").when?.(ctx(true, "/sessions").c)).toBe(false);
    const { c, went } = ctx(true, "/sessions/12");
    expect(byId("cancel-session").when?.(c)).toBe(true);
    byId("cancel-session").run(c);
    expect(went).toEqual(["/sessions/12?cancel=1"]);
  });

  test("Register runner opens the register modal", () => {
    const { c, went } = ctx(true);
    byId("register-runner").run(c);
    expect(went).toEqual(["/runners?register=1"]);
  });
});
