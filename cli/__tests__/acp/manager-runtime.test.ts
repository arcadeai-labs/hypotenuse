import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toolsForRole } from "../../../protocol/src/index";
import { agentForTurn } from "../../src/acp/agent-choice";
import { DEFAULT_TEMPLATES } from "../../src/acp/prompt";
import { assignment, fakeConfig, TestTurn } from "./harness";

/**
 * The manager's runtime is read-only: under its default policy the agent's
 * requests to edit or run something are refused without asking anyone, its
 * own tools stay allowed, and a file write through the daemon fails.
 */

/**
 * A runner whose manager role runs the fake agent with the default policy.
 * @returns The config.
 */
function managerConfig() {
  return fakeConfig(
    mkdtempSync(join(tmpdir(), "hyp-manager-")),
    '[roles.manager]\nagent = "fake"',
  );
}

describe("manager runtime", () => {
  test("edit and execute are rejected without an elicitation; a tool call is allowed; a write fails read-only", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "hyp-manager-state-"));
    const turn = new TestTurn(managerConfig(), "read-only", {
      assignment: assignment({ role: "manager" }),
      stateDir,
    });
    expect((await turn.result).outcome).toBe("completed");
    expect(turn.events.some((e) => e.type === "elicitation")).toBe(false);
    const response = turn.visible().at(-1);
    expect(response).toEqual({
      type: "response",
      body: "Edit rejected. Run rejected. Tool allowed. Write failed: this session is read-only",
    });
    const cwd = join(stateDir, "workspaces", "42");
    expect(existsSync(join(cwd, "notes.md"))).toBe(false);
  }, 20_000);

  test("a worker's default policy still writes", async () => {
    const turn = new TestTurn(managerConfig(), "read-only");
    expect((await turn.result).outcome).toBe("completed");
    expect(turn.visible().at(-1)).toMatchObject({
      type: "response",
      body: expect.stringContaining("Wrote $CWD/notes.md."),
    });
  }, 20_000);

  test("the default manager prompt names every manager tool", () => {
    const names = toolsForRole("manager").map((t) => t.name);
    expect(names).toContain("hypotenuse_dispatch");
    for (const name of names) expect(DEFAULT_TEMPLATES.manager).toContain(name);
  });

  test("a dispatch's agent preference is used when this runner has it, and said when it does not", () => {
    const config = fakeConfig(
      mkdtempSync(join(tmpdir(), "hyp-pref-")),
      '[agents.other]\ncommand = ["true"]',
    );
    const dispatched = (agentPreference: string | null, mode = "new") =>
      assignment({
        kind: "dispatch",
        dispatch: {
          mode: mode as "new" | "changes",
          reviewRound: 0,
          instructions: null,
          agentPreference,
          parent: {
            agentSessionId: 1,
            issueIdentifier: "ENG-0",
            issueUrl: null,
          },
        },
      });
    expect(agentForTurn(dispatched(null), config)).toEqual({
      agentId: "fake",
      note: null,
    });
    expect(agentForTurn(dispatched("other"), config)).toEqual({
      agentId: "other",
      note: null,
    });
    expect(agentForTurn(dispatched("other", "changes"), config)).toEqual({
      agentId: "fake",
      note: null,
    });
    expect(agentForTurn(dispatched("codex"), config)).toEqual({
      agentId: "fake",
      note: "The planning agent preferred `codex`, which this runner does not have; using fake.",
    });
  });
});
