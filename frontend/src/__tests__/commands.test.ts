import { describe, expect, test } from "bun:test";
import {
  availableCommands,
  COMMANDS,
  type CommandContext,
  commandDeniedReason,
} from "../commands/registry";

/**
 * A command context whose `reason` refuses the named actions.
 * @param refused - Action name → why it is refused.
 * @returns The context.
 */
function contextRefusing(refused: Record<string, string>): CommandContext {
  return {
    navigate: () => {},
    setTheme: () => {},
    toggleSidebar: () => {},
    showShortcuts: () => {},
    focusSearch: () => {},
    may: (action) => !(action in refused),
    reason: (action) => refused[action],
  };
}

/**
 * The command with an id.
 * @param id - Its id.
 * @returns The command.
 */
const command = (id: string) => {
  const found = COMMANDS.find((c) => c.id === id);
  if (!found) throw new Error(`no command ${id}`);
  return found;
};

describe("gated palette commands", () => {
  test("Invite member and New project are listed even when refused", () => {
    const ctx = contextRefusing({
      "invite:list": "Only project admins can do this.",
      "project:create": "Only organization owners can do this.",
    });
    const ids = availableCommands(COMMANDS, ctx).map((c) => c.id);
    expect(ids).toContain("invite-member");
    expect(ids).toContain("new-project");
  });

  test("a refusal carries the reason of the first action it needs", () => {
    const ctx = contextRefusing({
      "invite:list": "Only project admins can do this.",
      "project:create": "Only organization owners can do this.",
    });
    expect(commandDeniedReason(command("invite-member"), ctx)).toBe(
      "Only project admins can do this.",
    );
    expect(commandDeniedReason(command("new-project"), ctx)).toBe(
      "Only organization owners can do this.",
    );
  });

  test("allowed, they carry no reason and go where they say", () => {
    const visited: string[] = [];
    const ctx = {
      ...contextRefusing({}),
      navigate: (to: string) => visited.push(to),
    };
    expect(commandDeniedReason(command("invite-member"), ctx)).toBeUndefined();
    expect(commandDeniedReason(command("new-project"), ctx)).toBeUndefined();
    command("invite-member").run(ctx);
    command("new-project").run(ctx);
    expect(visited).toEqual(["/settings/members#invite", "/projects/new"]);
  });

  test("an ungated command is never refused", () => {
    const ctx = contextRefusing({ "project:create": "no" });
    expect(commandDeniedReason(command("go-docs"), ctx)).toBeUndefined();
  });
});

describe("bot and model commands", () => {
  test("New bot is listed when refused, with the reason, and opens the create page", () => {
    const refused = contextRefusing({
      "bot:create": "Only members of this project can do this.",
    });
    expect(availableCommands(COMMANDS, refused).map((c) => c.id)).toContain(
      "new-bot",
    );
    expect(commandDeniedReason(command("new-bot"), refused)).toBe(
      "Only members of this project can do this.",
    );
    const visited: string[] = [];
    const ctx = {
      ...contextRefusing({}),
      navigate: (to: string) => visited.push(to),
    };
    command("new-bot").run(ctx);
    command("open-model-settings").run(ctx);
    command("go-bots").run(ctx);
    expect(visited).toEqual(["/bots/new", "/settings/models", "/bots"]);
  });

  test("Go to Bots, Conversations, and Memory are offered now that their pages exist", () => {
    const ids = availableCommands(COMMANDS, contextRefusing({})).map(
      (c) => c.id,
    );
    expect(ids).toContain("go-bots");
    expect(ids).toContain("go-conversations");
    expect(ids).toContain("go-memory");
    expect(ids).not.toContain("go-sandboxes");
  });
});
