import { describe, expect, test } from "bun:test";
import { LIFT_ALLOWLIST_DENIED } from "../components/bots/SandboxSection";
import {
  canHoldAllowlist,
  connectionProbeLabel,
  isLiveSandbox,
  maskedToken,
  memoryFor,
  memoryWords,
  parseConnectionDraft,
  providerFor,
  providerOptionLabel,
  resourceWords,
  type SandboxProviderInfo,
  sandboxStatusLabel,
} from "../utils/sandboxProviders";

/** The providers as `project:settings-view` describes them on a development deployment. */
const PROVIDERS: SandboxProviderInfo[] = [
  {
    kind: "docker",
    label: "Docker (development only)",
    description: "One container per job on this server's Docker daemon.",
    allowedHere: true,
    capabilities: {
      domainEgressAllowlist: false,
      liveEgressUpdate: false,
      reattach: true,
      maxTimeoutMs: 86_400_000,
    },
    connectionKind: null,
    options: { image: true, runtimes: null, vcpus: null },
  },
  {
    kind: "vercel",
    label: "Vercel Sandbox",
    description: "One Vercel Sandbox microVM per job.",
    allowedHere: false,
    capabilities: {
      domainEgressAllowlist: true,
      liveEgressUpdate: true,
      reattach: true,
      maxTimeoutMs: 18_000_000,
    },
    connectionKind: "vercel",
    options: {
      image: false,
      runtimes: { values: ["node24", "node22"], default: "node24" },
      vcpus: { min: 1, max: 8, default: 2, mibPerVcpu: 2048 },
    },
  },
] as SandboxProviderInfo[];

/** The Vercel connection kind. */
const VERCEL_KIND = {
  kind: "vercel",
  label: "Vercel",
  description: "A Vercel team and project.",
  secretLabel: "Access token",
  secretDescription: "A Vercel access token.",
  fields: [
    { key: "teamId", label: "Team id", description: "team_…" },
    { key: "projectId", label: "Project id", description: "prj_…" },
  ],
};

describe("the provider the settings form describes", () => {
  test("is the one chosen in the menu", () => {
    expect(providerFor(PROVIDERS, "vercel", "docker")?.kind).toBe("vercel");
  });

  test("blank is the deployment's default, whatever the project chose before", () => {
    expect(providerFor(PROVIDERS, "", "docker")?.kind).toBe("docker");
    expect(providerFor(PROVIDERS, "", "vercel")?.kind).toBe("vercel");
  });

  test("a provider the server does not describe is not known here", () => {
    expect(providerFor(PROVIDERS, "", null)).toBeNull();
    expect(providerFor(PROVIDERS, "gone", "docker")).toBeNull();
  });

  test("an allowlist needs a provider that can hold one", () => {
    expect(canHoldAllowlist(PROVIDERS[1])).toBe(true);
    expect(canHoldAllowlist(PROVIDERS[0])).toBe(false);
    expect(canHoldAllowlist(null)).toBe(false);
  });

  test("one this deployment refuses says so in the menu", () => {
    expect(providerOptionLabel(PROVIDERS[0])).toBe("Docker (development only)");
    expect(providerOptionLabel(PROVIDERS[1])).toBe(
      "Vercel Sandbox — not on this deployment",
    );
  });
});

describe("a sandbox's size", () => {
  test("memory reads in MiB under a GiB, GiB above", () => {
    expect(memoryWords(512)).toBe("512 MiB");
    expect(memoryWords(2048)).toBe("2 GiB");
    expect(memoryWords(1536)).toBe("1.5 GiB");
  });

  test("memory follows vCPUs where the provider pairs them", () => {
    expect(memoryFor(PROVIDERS[1], 4)).toBe(8192);
    expect(memoryFor(PROVIDERS[0], 4)).toBeNull();
    expect(memoryFor(null, 4)).toBeNull();
  });

  test("what a sandbox was given reads in one line", () => {
    expect(
      resourceWords({
        vcpus: 2,
        memoryMiB: 4096,
        timeoutMs: 45 * 60_000,
        image: "node24",
      }),
    ).toBe("2 vCPUs · 4 GiB · up to 45 min · node24");
    expect(resourceWords({ vcpus: 1, timeoutMs: 90 * 60_000 })).toBe(
      "1 vCPU · up to 1 h 30 min",
    );
    expect(resourceWords({ image: "hypotenuse-sandbox:dev" })).toBe(
      "hypotenuse-sandbox:dev",
    );
    expect(resourceWords({})).toBeNull();
    expect(resourceWords(null)).toBeNull();
  });
});

describe("the sandbox ledger", () => {
  test("a sandbox is live until it is destroyed or failed", () => {
    const statuses = ["creating", "running", "stopped", "destroyed", "failed"];
    expect(statuses.filter(isLiveSandbox)).toEqual([
      "creating",
      "running",
      "stopped",
    ]);
    for (const s of statuses) {
      expect(sandboxStatusLabel(s)).not.toBe(s);
    }
    expect(sandboxStatusLabel("new")).toBe("new");
  });
});

describe("a provider connection", () => {
  const filled = {
    name: "",
    config: { teamId: " team_abc ", projectId: "prj_def" },
    token: " vercel_token_1234 ",
  };

  test("the token shows only its last four", () => {
    expect(maskedToken("1234")).toBe("•••• 1234");
  });

  test("its probe reads in words", () => {
    expect(connectionProbeLabel("ok")).toBe("Works");
    expect(connectionProbeLabel("error")).toBe("Last test failed");
    expect(connectionProbeLabel("unverified")).toBe("Not tested yet");
  });

  test("connecting takes every field and the token", () => {
    expect(parseConnectionDraft(VERCEL_KIND, filled, false)).toEqual({
      config: { teamId: "team_abc", projectId: "prj_def" },
      token: "vercel_token_1234",
    });
    expect(
      parseConnectionDraft(VERCEL_KIND, { ...filled, token: " " }, false),
    ).toBe("Access token is required.");
    expect(
      parseConnectionDraft(
        VERCEL_KIND,
        { ...filled, config: { teamId: "team_abc" } },
        false,
      ),
    ).toBe("Project id is required.");
  });

  test("an edit keeps the stored token when the field is blank", () => {
    expect(
      parseConnectionDraft(
        VERCEL_KIND,
        { ...filled, name: " Vercel (prod) ", token: "" },
        true,
      ),
    ).toEqual({
      name: "Vercel (prod)",
      config: { teamId: "team_abc", projectId: "prj_def" },
    });
  });
});

describe("a bot's egress allowlist", () => {
  test("lifting it is an admin's, and the switch says so", () => {
    expect(LIFT_ALLOWLIST_DENIED).toContain("project admins");
  });
});
