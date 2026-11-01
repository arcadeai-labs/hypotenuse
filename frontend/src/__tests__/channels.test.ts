import { describe, expect, test } from "bun:test";
import { chatCommands, commandDeniedReason } from "../commands/registry";
import {
  helpStatusLabel,
  listQuery,
  urgencyLabel,
} from "../components/help/model";
import { DESTINATIONS } from "../components/shell/destinations";
import { platformOf } from "../components/transcript/model";
import {
  bindConfirmation,
  INSTALLABLE_PLATFORMS,
  installationStatusLabel,
  PRIVATE_AUDIENCE_SENTENCE,
  parseExternalIds,
  splitChannels,
} from "../utils/channels";

describe("a bot's channels", () => {
  test("split into bound and heard-from, in the server's order", () => {
    const rows = [
      { id: 3, isPrivate: false, isShared: false, binding: { id: 1 } },
      { id: 2, isPrivate: true, isShared: false, binding: null },
      { id: 1, isPrivate: false, isShared: false, binding: { id: 2 } },
    ];
    const { bound, unbound } = splitChannels(rows);
    expect(bound.map((c) => c.id)).toEqual([3, 1]);
    expect(unbound.map((c) => c.id)).toEqual([2]);
  });

  test("binding a private channel names its audience in so many words and confirms it", () => {
    expect(PRIVATE_AUDIENCE_SENTENCE).toBe(
      "Everyone who can read this bot in Hypotenuse will be able to read this channel's conversations and memory.",
    );
    expect(bindConfirmation({ isPrivate: true, isShared: false })).toEqual({
      sentences: [PRIVATE_AUDIENCE_SENTENCE],
      flags: { confirmAudience: true },
    });
  });

  test("a shared channel is allowed explicitly; a public one needs nothing", () => {
    expect(
      bindConfirmation({ isPrivate: false, isShared: true }).flags,
    ).toEqual({ allowShared: true });
    expect(bindConfirmation({ isPrivate: true, isShared: true }).flags).toEqual(
      {
        confirmAudience: true,
        allowShared: true,
      },
    );
    expect(bindConfirmation({ isPrivate: false, isShared: false })).toEqual({
      sentences: [],
      flags: {},
    });
  });

  test("listed approvers are read one per line or comma-separated, without blanks or repeats", () => {
    expect(parseExternalIds("U1\n U2 ,U1,,\n")).toEqual(["U1", "U2"]);
    expect(parseExternalIds("")).toEqual([]);
  });

  test("Slack, Linear, and the webhook platform are installable, and every status has words", () => {
    expect(INSTALLABLE_PLATFORMS.map((p) => p.type)).toEqual([
      "slack",
      "linear",
      "webhook",
    ]);
    expect(
      ["active", "pending", "error", "uninstalled"].map(
        installationStatusLabel,
      ),
    ).toEqual([
      "Connected",
      "Waiting to be connected",
      "Not delivering",
      "Uninstalled",
    ]);
  });

  test("the dashboard and the webhook platform have chips of their own", () => {
    expect(platformOf("web")).toBe("web");
    expect(platformOf("webhook")).toBe("webhook");
    expect(platformOf("carrier-pigeon")).toBe("api");
  });
});

describe("the help inbox and the events log", () => {
  test("statuses and urgencies read as words", () => {
    expect(helpStatusLabel("pending")).toBe("Waiting for an answer");
    expect(helpStatusLabel("answered")).toBe("Answered");
    expect(urgencyLabel("high")).toBe("Urgent");
    expect(urgencyLabel("normal")).toBe("Normal");
  });

  test("a list's query carries its page and only the filters that are set", () => {
    expect(listQuery({ status: "pending", outcome: "" }, 2)).toBe(
      "?page=2&limit=25&status=pending",
    );
  });

  test("Chat and the help inbox are live destinations with shortcuts of their own", () => {
    expect(DESTINATIONS.find((d) => d.id === "chat")).toMatchObject({
      to: "/chat",
      shortcut: "g t",
      available: true,
    });
    expect(DESTINATIONS.find((d) => d.id === "help")).toMatchObject({
      to: "/help",
      shortcut: "g i",
      available: true,
    });
  });
});

describe("the palette's chat commands", () => {
  test("one per bot, opening its chat, refused with conversation:create's reason", () => {
    const commands = chatCommands([
      { id: 4, name: "Ada", slug: "ada" },
      { id: 9, name: "Kit", slug: "kit" },
    ]);
    expect(commands.map((c) => [c.id, c.title])).toEqual([
      ["chat-with-ada", "Chat with Ada"],
      ["chat-with-kit", "Chat with Kit"],
    ]);
    const went: string[] = [];
    const ctx = {
      navigate: (to: string) => went.push(to),
      setTheme: () => {},
      toggleSidebar: () => {},
      showShortcuts: () => {},
      focusSearch: () => {},
      may: () => true,
      reason: (action: string) =>
        action === "conversation:create" ? "Members only." : undefined,
    };
    commands[0]?.run(ctx);
    expect(went).toEqual(["/bots/4/chat"]);
    expect(commandDeniedReason(commands[1] as never, ctx)).toBe(
      "Members only.",
    );
  });
});
