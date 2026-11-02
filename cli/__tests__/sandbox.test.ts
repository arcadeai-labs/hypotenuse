import { describe, expect, test } from "bun:test";
import { botBody } from "../src/commands/bot";
import {
  connectionConfigFromFlags,
  connectionStatusText,
} from "../src/commands/connection";
import {
  type ProjectSettings,
  projectSettingsBody,
  projectSettingsText,
} from "../src/commands/project";
import {
  eventLine,
  jobStatusText,
  resourcesText,
  SANDBOX_JOB_STATUSES,
  usageText,
} from "../src/commands/sandbox";

describe("projectSettingsBody", () => {
  test("no flags is a view: an empty body", () => {
    expect(projectSettingsBody({})).toEqual({});
  });

  test("sends only the fields given, with durations in milliseconds", () => {
    expect(
      projectSettingsBody({
        sandboxProvider: "docker",
        sandboxImage: "ghcr.io/acme/agent:1",
        sandboxConcurrency: "2",
        sandboxMaxDuration: "30m",
      }),
    ).toEqual({
      sandboxProvider: "docker",
      sandboxImage: "ghcr.io/acme/agent:1",
      sandboxConcurrency: 2,
      sandboxMaxDurationMs: 1_800_000,
    });
  });

  test("each --no-* sends null, the deployment's default", () => {
    expect(
      projectSettingsBody({
        sandboxProvider: false,
        sandboxImage: false,
        sandboxConcurrency: false,
        sandboxMaxDuration: false,
      }),
    ).toEqual({
      sandboxProvider: null,
      sandboxImage: null,
      sandboxConcurrency: null,
      sandboxMaxDurationMs: null,
    });
  });

  test("a bad number or duration is refused, naming the flag", () => {
    expect(() => projectSettingsBody({ sandboxConcurrency: "two" })).toThrow(
      "--sandbox-concurrency",
    );
    expect(() => projectSettingsBody({ sandboxMaxDuration: "soon" })).toThrow(
      "--sandbox-max-duration",
    );
  });
});

describe("sandbox job rendering", () => {
  test("every status reads as words after a glyph", () => {
    for (const status of SANDBOX_JOB_STATUSES) {
      expect(jobStatusText(status)).toEndWith(` ${status.replace("_", " ")}`);
    }
  });

  test("usage counts tokens and requests, and names a budget", () => {
    expect(
      usageText({
        usage: { inputTokens: 1200, outputTokens: 300, requests: 1 },
        budgetTokens: null,
      }),
    ).toBe("1200 in / 300 out over 1 request");
    expect(
      usageText({
        usage: { inputTokens: 0, outputTokens: 0, requests: 4 },
        budgetTokens: 50_000,
      }),
    ).toBe("0 in / 0 out over 4 requests (budget 50000)");
  });

  test("an event is one line: its number, kind, tool, and text flattened", () => {
    const line = eventLine({
      id: 1,
      seq: 7,
      kind: "tool_use",
      toolName: "Bash",
      text: "ls\n  -la",
      occurredAt: Date.UTC(2026, 0, 1),
    });
    expect(line.startsWith("   7  ")).toBe(true);
    expect(line).toEndWith("tool_use Bash ls -la");
  });
});

describe("provider-sized sandbox settings", () => {
  test("runtime, vCPUs, and egress go in the body, and --no-* sends null", () => {
    expect(
      projectSettingsBody({
        sandboxRuntime: "node22",
        sandboxVcpus: "4",
        sandboxEgress: "allowlist",
      }),
    ).toEqual({
      sandboxRuntime: "node22",
      sandboxVcpus: 4,
      sandboxEgressMode: "allowlist",
    });
    expect(
      projectSettingsBody({
        sandboxRuntime: false,
        sandboxVcpus: false,
        sandboxEgress: false,
      }),
    ).toEqual({
      sandboxRuntime: null,
      sandboxVcpus: null,
      sandboxEgressMode: null,
    });
  });

  test("a bad egress mode or vCPU count is refused, naming the flag", () => {
    expect(() => projectSettingsBody({ sandboxEgress: "closed" })).toThrow(
      "--sandbox-egress takes one of open-world, allowlist",
    );
    expect(() => projectSettingsBody({ sandboxVcpus: "many" })).toThrow(
      "--sandbox-vcpus",
    );
  });

  const vercel: ProjectSettings = {
    projectId: 3,
    sandboxProvider: "vercel",
    sandboxConfig: { vcpus: 4, egressMode: "allowlist" },
    sandboxConcurrency: null,
    sandboxMaxDurationMs: null,
    effectiveSandbox: {
      provider: "vercel",
      image: null,
      runtime: "node24",
      vcpus: 4,
      memoryMiB: 8192,
      egressMode: "allowlist",
      concurrency: 3,
      maxDurationMs: 3_600_000,
    },
    updatedAt: 0,
  };

  test("a runtime provider shows its runtime, size, and egress, not an image", () => {
    const text = projectSettingsText(vercel);
    expect(text).toContain("runtime       node24 (default)");
    expect(text).toContain("size          4 vCPUs, 8 GiB memory\n");
    expect(text).toContain("egress        allowlist (deny by default)\n");
    expect(text).not.toContain("image");
  });

  test("an image provider shows its image; warnings and providers follow", () => {
    const text = projectSettingsText(
      {
        ...vercel,
        sandboxProvider: "docker",
        sandboxConfig: {},
        effectiveSandbox: {
          ...vercel.effectiveSandbox,
          provider: "docker",
          runtime: null,
          vcpus: null,
          memoryMiB: null,
          egressMode: "open-world",
        },
      },
      ["Toadsworth requires an egress allowlist."],
      [
        {
          kind: "docker",
          label: "Docker",
          allowedHere: false,
          connectionKind: null,
          options: { image: true, runtimes: null, vcpus: null },
        },
        {
          kind: "vercel",
          label: "Vercel",
          allowedHere: true,
          connectionKind: "vercel",
          options: { image: false, runtimes: null, vcpus: null },
        },
      ],
    );
    expect(text).toContain("image         the provider's own (default)");
    expect(text).not.toContain("size ");
    expect(text).toContain("egress        open-world (default)");
    expect(text).toContain(
      "providers     docker (not allowed here), vercel (needs a vercel connection",
    );
    expect(text).toEndWith("warning: Toadsworth requires an egress allowlist.");
  });

  test("bot edit sends requireEgressAllowlist only when a flag gives it", () => {
    expect(botBody({ requireEgressAllowlist: true })).toEqual({
      requireEgressAllowlist: true,
    });
    expect(botBody({ requireEgressAllowlist: false })).toEqual({
      requireEgressAllowlist: false,
    });
    expect(botBody({})).toEqual({});
  });
});

describe("connections and the ledger", () => {
  test("the Vercel flags fill config with only what was given", () => {
    expect(
      connectionConfigFromFlags({ teamId: "team_a", vercelProjectId: "prj_b" }),
    ).toEqual({ teamId: "team_a", projectId: "prj_b" });
    expect(connectionConfigFromFlags({ teamId: "team_a" })).toEqual({
      teamId: "team_a",
    });
  });

  test("a failed connection reads with its error", () => {
    expect(connectionStatusText({ status: "ok", lastError: null })).toBe("ok");
    expect(
      connectionStatusText({ status: "error", lastError: "token revoked" }),
    ).toBe("error: token revoked");
  });

  test("a ledgered sandbox's resources read as a person would say them", () => {
    expect(
      resourcesText({
        vcpus: 2,
        memoryMiB: 4096,
        timeoutMs: 600_000,
        image: "node24",
      }),
    ).toBe("2 vCPU, 4096 MiB, node24");
    expect(resourcesText(null)).toBe("-");
    expect(resourcesText({})).toBe("-");
  });
});
