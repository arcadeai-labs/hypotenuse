import { describe, expect, test } from "bun:test";
import {
  MAX_HALF_LIFE_DAYS,
  parseHalfLife,
} from "../components/bots/MemorySection";
import {
  decayTitle,
  diffStats,
  documentHref,
  explorerHref,
  halfLifeOf,
  lineDiff,
  memoryDocumentPath,
  memoryListPath,
  memorySearchPath,
  parseSeqs,
  pathProblem,
  STALE_BASE,
  sourceLabel,
  transcriptHref,
  whereBody,
} from "../components/memory/model";
import {
  aliasKindFor,
  EMBEDDING_ALIAS,
} from "../components/models/AliasesCard";
import {
  botsSentence,
  channelWriteDenied,
} from "../pages/memory/MemoryExplorerPage";

const channel = { scope: "channel", channelId: 9 } as const;
const project = { scope: "project" } as const;

describe("the line diff", () => {
  test("identical texts are all kept", () => {
    expect(lineDiff("a\nb", "a\nb")).toEqual([
      { kind: "same", text: "a" },
      { kind: "same", text: "b" },
    ]);
  });

  test("a changed line is removed then added, between kept lines", () => {
    const diff = lineDiff(
      "# Deploys\nOn Tuesdays.\nAsk Kim.",
      "# Deploys\nOn Thursdays.\nAsk Kim.",
    );
    expect(diff).toEqual([
      { kind: "same", text: "# Deploys" },
      { kind: "remove", text: "On Tuesdays." },
      { kind: "add", text: "On Thursdays." },
      { kind: "same", text: "Ask Kim." },
    ]);
    expect(diffStats(diff)).toEqual({ added: 1, removed: 1 });
  });

  test("lines added and removed in the middle keep the common ones", () => {
    const diff = lineDiff("a\nb\nc\nd", "a\nc\nx\nd");
    expect(diff.filter((l) => l.kind === "same").map((l) => l.text)).toEqual([
      "a",
      "c",
      "d",
    ]);
    expect(diffStats(diff)).toEqual({ added: 1, removed: 1 });
  });

  test("from nothing, every line is added", () => {
    const diff = lineDiff("", "one\ntwo");
    expect(diffStats(diff)).toEqual({ added: 2, removed: 1 });
    expect(diff.filter((l) => l.kind === "add").map((l) => l.text)).toEqual([
      "one",
      "two",
    ]);
  });

  test("past the size limit it still answers, removing then adding", () => {
    const before = Array.from({ length: 2500 }, (_, i) => `old ${i}`).join(
      "\n",
    );
    const after = Array.from({ length: 2500 }, (_, i) => `new ${i}`).join("\n");
    const diff = lineDiff(before, after);
    expect(diffStats(diff)).toEqual({ added: 2500, removed: 2500 });
    expect(diff[0].kind).toBe("remove");
    expect(diff[diff.length - 1].kind).toBe("add");
  });
});

describe("decay on hover", () => {
  test("says how fresh and the half-life", () => {
    expect(decayTitle(0.734, 30, false)).toBe(
      "73% fresh — unused, it loses half its weight every 30 days",
    );
    expect(decayTitle(1, 1, false)).toContain("every 1 day");
  });

  test("a pinned memory says it never fades", () => {
    expect(decayTitle(1, 180, true)).toBe(
      "100% fresh — pinned, so it never fades",
    );
  });

  test("clamps out-of-range factors", () => {
    expect(decayTitle(1.4, 30, false)).toStartWith("100%");
    expect(decayTitle(-0.2, 30, false)).toStartWith("0%");
  });

  test("the half-life follows the scope", () => {
    const halfLives = { channel: 30, project: 180 };
    expect(halfLifeOf("channel", halfLives)).toBe(30);
    expect(halfLifeOf("project", halfLives)).toBe(180);
  });
});

describe("addresses", () => {
  test("the explorer and a document, for the project and a channel", () => {
    expect(explorerHref(project)).toBe("/memory");
    expect(explorerHref(channel)).toBe("/memory/channels/9");
    expect(documentHref(project, "facts/a b.md")).toBe(
      "/memory/document?path=facts%2Fa+b.md",
    );
    expect(documentHref(channel, "people/kim.md", 1700000000000)).toBe(
      "/memory/channels/9/document?path=people%2Fkim.md&version=1700000000000",
    );
  });

  test("the API routes name the scope and the channel", () => {
    expect(memoryListPath(7, project, {})).toBe(
      "/project/7/memory?scope=project&limit=25",
    );
    expect(
      memoryListPath(7, channel, {
        page: 2,
        pathPrefix: "facts/",
        includeForgotten: true,
      }),
    ).toBe(
      "/project/7/memory?scope=channel&channelId=9&limit=25&page=2&pathPrefix=facts%2F&includeForgotten=true",
    );
    expect(memorySearchPath(7, project, "deploy day")).toBe(
      "/project/7/memory/search?scope=project&query=deploy+day&limit=20",
    );
    // A channel's search reaches into project memory only when asked.
    expect(memorySearchPath(7, channel, "kim", true)).toContain("scope=both");
    expect(memorySearchPath(7, channel, "kim")).toContain("scope=channel");
    expect(memoryDocumentPath(7, channel, "a.md", { versions: true })).toBe(
      "/project/7/memory/document/versions?scope=channel&channelId=9&path=a.md&limit=50",
    );
    expect(memoryDocumentPath(7, project, "a.md", { versionId: 5 })).toBe(
      "/project/7/memory/document?scope=project&path=a.md&versionId=5",
    );
  });

  test("a write's body names the channel only for channel memory", () => {
    expect(whereBody(project)).toEqual({ scope: "project" });
    expect(whereBody(channel)).toEqual({
      scope: "channel",
      channelId: 9,
    });
  });

  test("a transcript link carries the entries a memory came from", () => {
    expect(transcriptHref(12)).toBe("/conversations/12");
    expect(transcriptHref(12, [])).toBe("/conversations/12");
    expect(transcriptHref(12, [3, 5])).toBe("/conversations/12?seqs=3,5");
    expect([...parseSeqs("3,5")]).toEqual([3, 5]);
    expect([...parseSeqs(null)]).toEqual([]);
    expect([...parseSeqs("x,-1,0,4.5, 7")]).toEqual([7]);
  });
});

describe("writing", () => {
  test("a path the server would refuse is caught before the round trip", () => {
    expect(pathProblem("facts/deploy-process.md")).toBeNull();
    expect(pathProblem("/facts/x.md")).toBeNull();
    expect(pathProblem("")).toContain("needs a path");
    expect(pathProblem("../x.md")).toContain("climb");
    expect(pathProblem("facts/two words.md")).toContain("slash-separated");
    expect(pathProblem(`${"a".repeat(201)}`)).toContain("200");
  });

  test("a stale base is told apart from other refusals", () => {
    expect(
      STALE_BASE.test(
        "This document changed since version 1; the current version is 2. Reload it and make your change again.",
      ),
    ).toBe(true);
    expect(STALE_BASE.test("Memory document not found")).toBe(false);
  });

  test("every source has words, and an unknown one is shown as it is", () => {
    for (const source of [
      "agent",
      "person",
      "consolidation",
      "promotion",
      "decay",
    ]) {
      expect(sourceLabel(source)).not.toBe(source);
    }
    expect(sourceLabel("other")).toBe("other");
  });
});

describe("a bot's memory settings", () => {
  test("a half-life is a whole number of days from 1 to 3650", () => {
    expect(parseHalfLife("30")).toBe(30);
    expect(parseHalfLife(" 1 ")).toBe(1);
    expect(parseHalfLife(String(MAX_HALF_LIFE_DAYS))).toBe(3650);
    for (const bad of ["", "0", "3651", "2.5", "-3", "month"]) {
      expect(parseHalfLife(bad), bad).toBeNull();
    }
  });
});

describe("the embedding model name", () => {
  test("only the name embedding is of kind embedding", () => {
    expect(EMBEDDING_ALIAS).toBe("embedding");
    expect(aliasKindFor("embedding")).toBe("embedding");
    expect(aliasKindFor(" embedding ")).toBe("embedding");
    expect(aliasKindFor("default")).toBe("language");
    expect(aliasKindFor("embeddings")).toBe("language");
  });
});

describe("a channel's memory is shared by the bots working there", () => {
  const withBots = (...names: string[]) => ({
    id: 3,
    projectId: 1,
    type: "webhook",
    name: "general",
    botId: null,
    externalId: "acme/C-general",
    isPrivate: false,
    createdAt: 0,
    documents: 2,
    bots: names.map((name, i) => ({ id: i + 1, name, slug: name })),
    canWrite: false,
  });

  test("the bots are named in a sentence", () => {
    expect(botsSentence(withBots())).toBe("No bot works here yet");
    expect(botsSentence(withBots("Ada"))).toBe("Ada");
    expect(botsSentence(withBots("Ada", "Kamek", "Toad"))).toBe(
      "Ada, Kamek and Toad",
    );
  });

  test("a refused write says whose access it takes", () => {
    expect(channelWriteDenied(withBots("Ada", "Kamek"))).toContain(
      "write access to a bot working in it (Ada, Kamek)",
    );
    expect(channelWriteDenied(withBots())).toContain("none works here yet");
  });
});
