import { describe, expect, test } from "bun:test";
import { TurnMapper } from "../../src/acp/mapping";
import { PrDetector } from "../../src/acp/pr-detect";

describe("PrDetector", () => {
  test.each([
    ["git@github.com:acme/web.git", "https://github.com/acme/web/pull/12"],
    [
      "https://gitlab.example.com/platform/web.git",
      "https://gitlab.example.com/platform/web/-/merge_requests/7",
    ],
    [
      "git@gitlab.com:group/sub/web.git",
      "https://gitlab.com/group/sub/web/-/merge_requests/3",
    ],
    [
      "git@bitbucket.org:acme/web.git",
      "https://bitbucket.org/acme/web/pull-requests/4",
    ],
  ])("%s links %s", (remote, url) => {
    expect(new PrDetector(remote).scan(`Opened ${url}.`)).toEqual([
      { label: "Pull Request", url },
    ]);
  });

  test("another repository's pull request is not linked", () => {
    const d = new PrDetector("github.com/acme/web");
    expect(
      d.scan(
        "See https://github.com/other/web/pull/1 and https://github.com/acme/web-old/pull/2 and https://github.com/acme/web/issues/3",
      ),
    ).toEqual([]);
  });

  test("each URL once; the second is Pull Request (2); known ones are skipped", () => {
    const d = new PrDetector(
      "github.com/acme/web",
      [],
      ["https://github.com/acme/web/pull/1"],
    );
    expect(
      d.scan(
        "https://github.com/acme/web/pull/1 https://github.com/acme/web/pull/2, again https://github.com/acme/web/pull/2",
      ),
    ).toEqual([
      { label: "Pull Request (2)", url: "https://github.com/acme/web/pull/2" },
    ]);
    expect(d.scan("https://github.com/acme/web/pull/2")).toEqual([]);
  });

  test("pr_url_patterns match a self-hosted forge for this repository only", () => {
    const d = new PrDetector("git.acme.dev/acme/web", [
      "^https://review\\.acme\\.dev/(?<repo>[^/]+/[^/]+)/changes/\\d+$",
    ]);
    expect(d.scan("https://review.acme.dev/acme/web/changes/9")).toEqual([
      {
        label: "Pull Request",
        url: "https://review.acme.dev/acme/web/changes/9",
      },
    ]);
    expect(d.scan("https://review.acme.dev/acme/api/changes/9")).toEqual([]);
  });

  test("no repository, nothing to link", () => {
    expect(
      new PrDetector(null).scan("https://github.com/acme/web/pull/1"),
    ).toEqual([]);
  });
});

describe("the mapper's pull request links", () => {
  /**
   * A mapper with detection on.
   * @param found - Where reported URLs go.
   * @returns The mapper.
   */
  function mapper(found: string[]) {
    return new TurnMapper({
      cwd: "/w",
      now: () => 0,
      pullRequests: new PrDetector("github.com/acme/web"),
      onPullRequest: (url) => found.push(url),
    });
  }

  test("a completed execute result emits external_url before its action", () => {
    const found: string[] = [];
    const m = mapper(found);
    m.update({
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      title: "gh pr create",
      kind: "execute",
      status: "in_progress",
      rawInput: { command: "gh pr create --fill" },
    } as never);
    const events = m.update({
      sessionUpdate: "tool_call_update",
      toolCallId: "t1",
      status: "completed",
      rawOutput: { output: "https://github.com/acme/web/pull/42\n" },
    } as never);
    expect(events[0]).toEqual({
      type: "external_url",
      label: "Pull Request",
      url: "https://github.com/acme/web/pull/42",
    });
    expect(events[1]?.type).toBe("action");
    expect(found).toEqual(["https://github.com/acme/web/pull/42"]);
  });

  test("a read tool's output is not scanned; the agent's message is", () => {
    const found: string[] = [];
    const m = mapper(found);
    m.update({
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      title: "Read notes",
      kind: "read",
      status: "completed",
      rawOutput: "https://github.com/acme/web/pull/1",
    } as never);
    expect(found).toEqual([]);
    m.update({
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "text",
        text: "Opened https://github.com/acme/web/pull/5.",
      },
    } as never);
    const end = m.finish("end_turn", { branch: null });
    expect(end.map((e) => e.type)).toEqual(["external_url", "response"]);
    expect(found).toEqual(["https://github.com/acme/web/pull/5"]);
  });
});
