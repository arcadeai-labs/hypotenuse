import { describe, expect, test } from "bun:test";
import { SETTINGS_SECTIONS } from "../components/settings/sections";
import { DESTINATIONS } from "../components/shell/destinations";
import {
  AUTH_MODE_OPTIONS,
  annotationChips,
  approvalStatusLabel,
  approvalsQuery,
  approvalTtlChoices,
  authModeOption,
  cannotDecideReason,
  credentialSummary,
  durationWords,
  expiresInWords,
  headersFromRows,
  mcpServerStatusLabel,
  oauthLanding,
  parsePatterns,
  previewAllowances,
  samePatterns,
  toolCountLabel,
} from "../utils/mcp";

describe("connecting an MCP server", () => {
  test("the form offers each auth mode once, none first, and falls back to it", () => {
    expect(AUTH_MODE_OPTIONS.map((o) => o.mode)).toEqual([
      "none",
      "bearer",
      "headers",
      "oauth",
    ]);
    expect(authModeOption("oauth").label).toBe("OAuth");
    expect(authModeOption("nope").mode).toBe("none");
  });

  test("header rows become headers; blank rows are dropped", () => {
    expect(
      headersFromRows([
        { name: " X-Api-Key ", value: "k1" },
        { name: "", value: "" },
        { name: "X-Team", value: "ops" },
      ]),
    ).toEqual({ headers: { "X-Api-Key": "k1", "X-Team": "ops" } });
  });

  test("a half-filled, malformed, or repeated header is refused in words", () => {
    expect(headersFromRows([{ name: "", value: "v" }])).toEqual({
      problem: "Every header needs a name.",
    });
    expect(headersFromRows([{ name: "X-Key", value: " " }])).toEqual({
      problem: "The X-Key header needs a value.",
    });
    expect(headersFromRows([{ name: "Bad Name", value: "v" }])).toEqual({
      problem: "Bad Name is not a valid header name.",
    });
    expect(
      headersFromRows([
        { name: "X-Key", value: "a" },
        { name: "x-key", value: "b" },
      ]),
    ).toEqual({ problem: "x-key is given twice." });
    expect(headersFromRows([{ name: "", value: "" }])).toEqual({
      problem: "Add at least one header.",
    });
  });

  test("credentials are described without ever holding one", () => {
    const base = { headerNames: null, lastFour: null, signedIn: null };
    expect(credentialSummary({ ...base, authMode: "none" })).toBe(
      "No credentials",
    );
    expect(
      credentialSummary({ ...base, authMode: "bearer", lastFour: "a1f3" }),
    ).toBe("Bearer ••••a1f3");
    expect(
      credentialSummary({
        ...base,
        authMode: "headers",
        headerNames: ["X-Api-Key", "X-Team"],
      }),
    ).toBe("Headers: X-Api-Key, X-Team");
    expect(
      credentialSummary({ ...base, authMode: "oauth", signedIn: false }),
    ).toBe("OAuth, not signed in");
    expect(
      credentialSummary({ ...base, authMode: "oauth", signedIn: true }),
    ).toBe("OAuth, signed in");
  });

  test("a disabled server reads disabled whatever its last probe said", () => {
    expect(mcpServerStatusLabel({ status: "ok", enabled: true })).toBe(
      "Connected",
    );
    expect(mcpServerStatusLabel({ status: "needs_auth", enabled: true })).toBe(
      "Needs sign-in",
    );
    expect(mcpServerStatusLabel({ status: "error", enabled: true })).toBe(
      "Could not connect",
    );
    expect(mcpServerStatusLabel({ status: "ok", enabled: false })).toBe(
      "Disabled",
    );
    expect(toolCountLabel(1)).toBe("1 tool");
    expect(toolCountLabel(0)).toBe("0 tools");
  });
});

describe("the OAuth landing", () => {
  test("a page reached any other way has none", () => {
    expect(oauthLanding(new URLSearchParams(""))).toBeNull();
    expect(oauthLanding(new URLSearchParams("server=4"))).toBeNull();
  });

  test("signedIn=1 names the server it was for", () => {
    expect(oauthLanding(new URLSearchParams("server=4&signedIn=1"))).toEqual({
      serverId: 4,
      signedIn: true,
      error: null,
    });
  });

  test("oauthError carries the server's words, and an empty one still says it failed", () => {
    expect(
      oauthLanding(new URLSearchParams("server=4&oauthError=access_denied")),
    ).toEqual({ serverId: 4, signedIn: false, error: "access_denied" });
    expect(oauthLanding(new URLSearchParams("oauthError="))).toEqual({
      serverId: null,
      signedIn: false,
      error: "The sign-in did not finish.",
    });
  });
});

describe("annotations", () => {
  test("only hints the server set are drawn, read-only first", () => {
    expect(annotationChips(undefined)).toEqual([]);
    expect(
      annotationChips({ readOnlyHint: false, destructiveHint: false }),
    ).toEqual([]);
    expect(
      annotationChips({
        openWorldHint: true,
        destructiveHint: true,
        readOnlyHint: true,
      }).map((c) => [c.label, c.caution]),
    ).toEqual([
      ["Read-only", false],
      ["Destructive", true],
      ["Open world", false],
    ]);
  });
});

describe("allowlist patterns", () => {
  test("one a line or comma, trimmed, blank ones dropped, each once", () => {
    expect(parsePatterns(" mail/read_inbox \n\nmail/*, mail/*\n")).toEqual([
      "mail/read_inbox",
      "mail/*",
    ]);
    expect(parsePatterns("")).toEqual([]);
  });

  test("order matters to whether two lists are the same", () => {
    expect(samePatterns(["a", "b"], ["a", "b"])).toBe(true);
    expect(samePatterns(["a", "b"], ["b", "a"])).toBe(false);
    expect(samePatterns([], [])).toBe(true);
  });

  test("the preview takes the server's matches, then read-only, else waits", () => {
    const tools = [
      { name: "mail/read_inbox", annotations: { readOnlyHint: true } },
      { name: "mail/send_email", annotations: {} },
      {
        name: "mail/list_calendar_events",
        annotations: { readOnlyHint: true },
      },
    ];
    const matches = [
      { pattern: "mail/read_inbox", tools: ["mail/read_inbox"] },
    ];
    expect(previewAllowances(tools, matches, false)).toEqual([
      {
        name: "mail/read_inbox",
        allowance: { runs: true, via: "pattern", pattern: "mail/read_inbox" },
      },
      { name: "mail/send_email", allowance: { runs: false } },
      { name: "mail/list_calendar_events", allowance: { runs: false } },
    ]);
    expect(
      previewAllowances(tools, matches, true).map((a) => a.allowance),
    ).toEqual([
      { runs: true, via: "pattern", pattern: "mail/read_inbox" },
      { runs: false },
      { runs: true, via: "read-only" },
    ]);
  });
});

describe("approvals", () => {
  test("every status has words", () => {
    expect(approvalStatusLabel("pending")).toBe("Waiting for a decision");
    expect(approvalStatusLabel("consumed")).toBe("Approved and run");
    expect(approvalStatusLabel("expired")).toBe("Expired");
  });

  test("durations use the largest whole unit", () => {
    expect(durationWords(-5)).toBe("0 seconds");
    expect(durationWords(45_000)).toBe("45 seconds");
    expect(durationWords(60_000)).toBe("1 minute");
    expect(durationWords(3 * 3_600_000)).toBe("3 hours");
    expect(durationWords(47 * 3_600_000)).toBe("47 hours");
    expect(durationWords(7 * 86_400_000)).toBe("7 days");
  });

  test("a pending approval says when it expires, and once past that it has", () => {
    const now = 1_000_000;
    expect(expiresInWords(now + 2 * 3_600_000, now)).toBe("Expires in 2 hours");
    expect(expiresInWords(now, now)).toBe("Expired");
  });

  test("the expiry choices keep a value set elsewhere, in order", () => {
    expect(approvalTtlChoices(3600)).toEqual([
      900, 3600, 14400, 86400, 259200, 604800, 2592000,
    ]);
    expect(approvalTtlChoices(7200)).toContain(7200);
    expect(approvalTtlChoices(7200).indexOf(7200)).toBe(2);
  });

  test("the inbox query names its status and page", () => {
    expect(approvalsQuery("pending", 1)).toBe(
      "?status=pending&page=1&limit=25",
    );
    expect(approvalsQuery("", 3)).toBe("?page=3&limit=25");
  });

  test("a refusal to decide says who may", () => {
    expect(cannotDecideReason("Ada")).toBe(
      "Only someone who may change Ada, or who holds its approver tag, can decide this.",
    );
  });
});

describe("where it lives", () => {
  test("Approvals is a live destination with its own shortcut", () => {
    const approvals = DESTINATIONS.find((d) => d.id === "approvals");
    expect(approvals).toMatchObject({
      to: "/approvals",
      shortcut: "g a",
      available: true,
    });
    const shortcuts = DESTINATIONS.flatMap((d) =>
      d.shortcut ? [d.shortcut] : [],
    );
    expect(new Set(shortcuts).size).toBe(shortcuts.length);
  });

  test("MCP servers is a project settings section, after Models", () => {
    const slugs = SETTINGS_SECTIONS.map((s) => s.slug);
    expect(slugs.indexOf("mcp-servers")).toBe(slugs.indexOf("models") + 1);
    expect(SETTINGS_SECTIONS.find((s) => s.slug === "mcp-servers")?.group).toBe(
      "Project",
    );
  });
});
