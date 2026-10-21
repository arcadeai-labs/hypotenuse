import { describe, expect, test } from "bun:test";
import type { PermissionOption } from "../../src/acp/connection";
import {
  elicitationQuestion,
  permissionQuestion,
  QuestionQueue,
} from "../../src/acp/elicitation";
import { automaticOption, decide, matchReply } from "../../src/acp/permissions";
import type { EventInput } from "../../src/daemon/event-sink";

/** Policies, the select round trip, `matchReply`, and the question queue. */

const all: PermissionOption[] = [
  { optionId: "a1", name: "Allow once", kind: "allow_once" },
  { optionId: "a2", name: "Always", kind: "allow_always" },
  { optionId: "r1", name: "Reject", kind: "reject_once" },
  { optionId: "r2", name: "Never", kind: "reject_always" },
];

const request = {
  sessionId: "s",
  toolCall: {
    toolCallId: "t",
    title: "rm",
    kind: "execute" as const,
    rawInput: { command: "rm -rf build/" },
  },
  options: all,
};

describe("permissions", () => {
  test("policies, with per-kind overrides and a default", () => {
    expect(decide("ask", "execute")).toBe("ask");
    const table = { default: "allow", execute: "ask", fetch: "deny" } as const;
    expect(decide(table, "execute")).toBe("ask");
    expect(decide(table, "fetch")).toBe("deny");
    expect(decide(table, "read")).toBe("allow");
    expect(decide({ execute: "deny" }, "edit")).toBe("allow");
  });

  test("allow takes allow_once, never allow_always when allow_once exists", () => {
    expect(automaticOption(all, "allow")).toBe("a1");
    expect(automaticOption(all.slice(1), "allow")).toBe("a2");
    expect(automaticOption(all, "deny")).toBe("r1");
    expect(automaticOption([all[3]!], "deny")).toBe("r2");
    expect(automaticOption([all[2]!], "allow")).toBeNull();
  });

  test("matchReply: value, label, number, then yes/no words; else free text", () => {
    const choices = all.map((o) => ({
      value: o.optionId,
      label: o.name,
      kind: o.kind,
    }));
    expect(matchReply("r2", choices)).toBe("r2");
    expect(matchReply("  ALWAYS ", choices)).toBe("a2");
    expect(matchReply("3", choices)).toBe("r1");
    expect(matchReply("9", choices)).toBeNull();
    for (const yes of ["yes", "Allow", "ok", "go ahead", "Yes!"])
      expect(matchReply(yes, choices)).toBe("a1");
    for (const no of ["no", "deny", "don't"])
      expect(matchReply(no, choices)).toBe("r1");
    expect(
      matchReply("Don't delete build, run the tests first", choices),
    ).toBeNull();
  });

  test("a permission question: a select, the chosen option, and free text rejected and unconsumed", () => {
    const q = permissionQuestion(request, "`github.com/acme/web`", "/w");
    expect(q.event).toEqual({
      type: "elicitation",
      body: "The agent wants to run `rm -rf build/` in `github.com/acme/web`. Allow it?",
      signal: "select",
      signalMetadata: {
        options: [
          { label: "Allow once", value: "a1" },
          { label: "Always", value: "a2" },
          { label: "Reject", value: "r1" },
          { label: "Never", value: "r2" },
        ],
      },
    });
    expect(q.interpret("2")).toEqual({
      answer: { outcome: { outcome: "selected", optionId: "a2" } },
      consumed: true,
    });
    expect(q.interpret("run the tests instead")).toEqual({
      answer: { outcome: { outcome: "selected", optionId: "r1" } },
      consumed: false,
    });
    expect(q.cancelled()).toEqual({ outcome: { outcome: "cancelled" } });
  });

  test("agent elicitations: a free-form single string is filled; anything else declines on free text", () => {
    const one = elicitationQuestion(
      {
        sessionId: "s",
        mode: "form",
        message: "Name?",
        requestedSchema: {
          type: "object",
          properties: { name: { type: "string", title: "Name" } },
        },
      },
      "Agent",
    );
    expect(one.event).toEqual({
      type: "elicitation",
      body: "Name?\n\n- **Name** (optional) — string",
    });
    expect(one.interpret(" Mario ")).toEqual({
      answer: { action: "accept", content: { name: "Mario" } },
      consumed: true,
    });
    const two = elicitationQuestion(
      {
        sessionId: "s",
        mode: "form",
        message: "Details?",
        requestedSchema: {
          type: "object",
          properties: { a: { type: "string" }, b: { type: "number" } },
          required: ["a"],
        },
      },
      "Agent",
    );
    expect(two.interpret("whatever")).toEqual({
      answer: { action: "decline" },
      consumed: false,
    });
  });

  test("the queue asks one question at a time and cancels them all", async () => {
    const posted: EventInput[] = [];
    const waiting: boolean[] = [];
    const queue = new QuestionQueue({
      post: (e) => posted.push(e),
      waiting: (w) => waiting.push(w),
    });
    const first = queue.ask(permissionQuestion(request, "here", "/w"));
    const second = queue.ask(permissionQuestion(request, "there", "/w"));
    expect(posted).toHaveLength(1);
    expect(queue.deliver({ activityId: 1, body: "yes" })).toBe(true);
    expect(await first).toEqual({
      outcome: { outcome: "selected", optionId: "a1" },
    });
    expect(posted).toHaveLength(2);
    queue.cancelAll();
    expect(await second).toEqual({ outcome: { outcome: "cancelled" } });
    expect(waiting).toEqual([true, false]);
    expect(queue.deliver({ activityId: 2, body: "yes" })).toBeNull();
    // A closed queue answers new questions at once.
    expect(await queue.ask(permissionQuestion(request, "x", "/w"))).toEqual({
      outcome: { outcome: "cancelled" },
    });
  });

  test("free text to the head declines every waiting question", async () => {
    const queue = new QuestionQueue({ post: () => {}, waiting: () => {} });
    const first = queue.ask(permissionQuestion(request, "a", "/w"));
    const second = queue.ask(permissionQuestion(request, "b", "/w"));
    expect(queue.deliver({ activityId: 1, body: "do something else" })).toBe(
      false,
    );
    expect(await first).toEqual({
      outcome: { outcome: "selected", optionId: "r1" },
    });
    expect(await second).toEqual({
      outcome: { outcome: "selected", optionId: "r1" },
    });
  });
});
