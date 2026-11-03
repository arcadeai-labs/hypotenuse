import { describe, expect, test } from "bun:test";
import { jumpCommands } from "../commands/registry";
import {
  ago,
  botDashboardChannel,
  type DashboardConversation,
  inboxHref,
  inboxQuery,
  spendLabel,
  staleOf,
  stateDetail,
  waitingGlyph,
} from "../components/dashboard/model";
import { outboxStatusLabel } from "../components/dashboard/OutboxPanel";
import { DESTINATIONS } from "../components/shell/destinations";
import { conversationsQuery } from "../components/transcript/model";

/**
 * The dashboard's pure rules: which frames count, the detail line under a
 * state, where an inbox item is answered, and the queries the lists send.
 */
const NOW = Date.UTC(2026, 10, 3, 12, 0, 0);

/**
 * A conversation for the detail line.
 * @param over - Fields to set.
 * @returns The conversation.
 */
function conv(over: Partial<DashboardConversation>): DashboardConversation {
  return {
    id: 1,
    state: "hibernating",
    waitingOn: null,
    outcome: null,
    epoch: 3,
    lastActivityAt: NOW - 2 * 3_600_000,
    ...over,
  };
}

describe("frames", () => {
  test("a bot's channel is named for its project and bot", () => {
    expect(botDashboardChannel(4, 9)).toBe("project:4:bot:9:dashboard");
  });

  test("only a dashboard frame with a known stale kind counts", () => {
    expect(staleOf({ event: "dashboard", stale: "inbox" })).toBe("inbox");
    expect(staleOf({ event: "dashboard", stale: "sandboxes" })).toBe(
      "sandboxes",
    );
    expect(staleOf({ event: "dashboard", stale: "secrets" })).toBeNull();
    expect(staleOf({ event: "conversation" })).toBeNull();
    expect(staleOf(null)).toBeNull();
    expect(staleOf("dashboard")).toBeNull();
  });
});

describe("the state's detail line", () => {
  test("one line per state, naming what a wait is on", () => {
    expect(stateDetail(conv({ state: "working" }), NOW)).toBe(
      "turn 3 · working",
    );
    expect(stateDetail(conv({}), NOW)).toBe("last message 2h ago");
    expect(
      stateDetail(
        conv({
          state: "waiting",
          waitingOn: { kind: "approval", approvalIds: [1, 2] },
        }),
        NOW,
      ),
    ).toBe("needs 2 approvals");
    expect(
      stateDetail(
        conv({
          state: "waiting",
          waitingOn: { kind: "sandbox", sandboxJobId: 7 },
        }),
        NOW,
      ),
    ).toBe("sandbox job #7");
    expect(
      stateDetail(conv({ state: "waiting", waitingOn: { kind: "help" } }), NOW),
    ).toBe("asked the team 2h ago");
    expect(
      stateDetail(
        conv({ state: "waiting", waitingOn: { kind: "answer" } }),
        NOW,
      ),
    ).toBe("asked 2h ago");
    expect(
      stateDetail(conv({ state: "ended", outcome: "failed" }), NOW),
    ).toContain("retry");
  });

  test("ago reads in the fewest words", () => {
    expect(ago(NOW - 10_000, NOW)).toBe("just now");
    expect(ago(NOW - 4 * 60_000, NOW)).toBe("4m ago");
    expect(ago(NOW - 3 * 86_400_000, NOW)).toBe("3d ago");
  });

  test("help and sandbox questions are drawn with the glyphs that exist", () => {
    expect(waitingGlyph("help")).toBe("answer");
    expect(waitingGlyph("sandbox-question")).toBe("sandbox");
    expect(waitingGlyph("approval")).toBe("approval");
  });
});

describe("the inbox", () => {
  test("each item opens the page its own action lives on", () => {
    expect(inboxHref({ kind: "approval", id: 3, jobId: null })).toBe(
      "/approvals/3",
    );
    expect(inboxHref({ kind: "help", id: 4, jobId: null })).toBe("/help/4");
    expect(inboxHref({ kind: "sandbox-question", id: 5, jobId: 9 })).toBe(
      "/sandboxes/9",
    );
  });

  test("the query names the kind only when one is chosen", () => {
    expect(inboxQuery("", 2)).toBe("?page=2&limit=25");
    expect(inboxQuery("help", 1)).toBe("?page=1&limit=25&kind=help");
  });

  test("spend shows a plus when some of it had no price", () => {
    expect(spendLabel(1.234, 0)).toBe("$1.23");
    expect(spendLabel(0, 2)).toBe("$0.00+");
  });

  test("an outbox row that did not arrive is drawn as a problem", () => {
    expect(outboxStatusLabel("sent").problem).toBe(false);
    expect(outboxStatusLabel("undeliverable").problem).toBe(true);
    expect(outboxStatusLabel("failed")).toEqual({
      label: "Retrying",
      problem: true,
    });
  });
});

describe("the conversations list's query", () => {
  test("a waiting kind replaces the state, and platform and channel ride along", () => {
    expect(
      conversationsQuery(
        {
          state: "waiting",
          waitingKind: "approval",
          channelType: "slack",
          channelId: 4,
        },
        1,
      ),
    ).toBe(
      "?page=1&limit=25&waitingKind=approval&channelType=slack&channelId=4",
    );
    expect(conversationsQuery({ state: "working" }, 1)).toBe(
      "?page=1&limit=25&state=working",
    );
  });
});

describe("the shell", () => {
  test("Home and Inbox are live destinations with their own keys", () => {
    const home = DESTINATIONS.find((d) => d.id === "home");
    const inbox = DESTINATIONS.find((d) => d.id === "inbox");
    expect(home).toMatchObject({
      to: "/home",
      available: true,
      shortcut: "g h",
    });
    expect(inbox).toMatchObject({
      to: "/inbox",
      available: true,
      shortcut: "g n",
    });
    const keys = DESTINATIONS.flatMap((d) => (d.shortcut ? [d.shortcut] : []));
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("the palette jumps to any bot, conversation, or channel", () => {
    const visited: string[] = [];
    const commands = jumpCommands({
      bots: [{ id: 1, name: "Toadsworth", slug: "toadsworth" }],
      conversations: [
        {
          id: 8,
          title: null,
          bot: { name: "Toadsworth" },
          channel: { name: "api" },
        },
      ],
      channels: [{ id: 3, name: "#support", type: "slack" }],
    });
    expect(commands.map((c) => c.title)).toEqual([
      "Bot: Toadsworth",
      "Conversation: #8",
      "Channel: #support",
    ]);
    const ctx = { navigate: (to: string) => visited.push(to) } as never;
    for (const c of commands) c.run(ctx);
    expect(visited).toEqual([
      "/bots/1",
      "/conversations/8",
      "/conversations?channelId=3",
    ]);
  });
});
