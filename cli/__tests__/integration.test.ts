import { describe, expect, test } from "bun:test";
import {
  connectFinished,
  describeIntegration,
  type Integration,
  parseType,
} from "../src/commands/integration";

/** An active Linear integration, with overrides. */
function integration(over: Partial<Integration> = {}): Integration {
  return {
    id: 1,
    projectId: 7,
    type: "linear",
    externalWorkspaceId: "org-1",
    workspaceName: "Workspace 1",
    workspaceUrlKey: "eng",
    externalAppUserId: "app-1",
    appUserName: "Hypotenuse",
    details: { teamIds: ["team-1"], canAccessAllPublicTeams: false },
    scopes: ["read", "write"],
    status: "active",
    accessTokenLastFour: "abcd",
    accessTokenExpiresAt: null,
    connectedAt: 1_000,
    lastRefreshedAt: null,
    refreshError: null,
    rateLimit: null,
    updatedAt: 1_000,
    ...over,
  };
}

describe("integration connect's wait", () => {
  test("finishes only when the integration is active and an install completed since it started", () => {
    expect(connectFinished(null, null)).toBe(false);
    expect(connectFinished(integration(), null)).toBe(true);
    // Unchanged since connect started: the old connection, not the new one.
    expect(connectFinished(integration(), 1_000)).toBe(false);
    expect(connectFinished(integration({ connectedAt: 2_000 }), 1_000)).toBe(
      true,
    );
    // A token refresh or a rate-limit write moves updatedAt, not connectedAt:
    // the admin may still be on the consent screen.
    expect(
      connectFinished(
        integration({ updatedAt: 5_000, lastRefreshedAt: 5_000 }),
        1_000,
      ),
    ).toBe(false);
    // A refused reconnect leaves an errored or revoked row as it was.
    expect(
      connectFinished(
        integration({ status: "error", connectedAt: 2_000 }),
        1_000,
      ),
    ).toBe(false);
    expect(
      connectFinished(
        integration({ status: "revoked", connectedAt: 2_000 }),
        1_000,
      ),
    ).toBe(false);
  });
});

describe("integration types", () => {
  test("a known type is accepted in any case, an unknown one is refused by name", () => {
    expect(parseType("Linear")).toBe("linear");
    expect(() => parseType("jira")).toThrow(/Unknown integration type: jira/);
  });
});

describe("integration view's rendering", () => {
  test("says how to connect, and why it cannot when the server has no app for the type", () => {
    expect(
      describeIntegration("linear", { integration: null, configured: true }),
    ).toContain("hypotenuse integration connect linear");
    expect(
      describeIntegration("linear", { integration: null, configured: false }),
    ).toContain("no Linear app configured");
    expect(
      describeIntegration("linear", {
        integration: integration({ status: "revoked" }),
        configured: true,
      }),
    ).toContain("Not connected to Linear");
  });

  test("shows the type, the workspace, the app user, the token's last four, and any refresh error", () => {
    const text = describeIntegration("linear", {
      integration: integration({
        status: "error",
        refreshError: "An admin must reconnect Linear.",
        rateLimit: { requestsLimit: 5000, requestsRemaining: 4990 },
      }),
      configured: true,
    });
    expect(text).toContain("Linear: Workspace 1 (eng)");
    expect(text).toContain("Hypotenuse (app-1)");
    expect(text).toContain("teams      1");
    expect(text).toContain("…abcd");
    expect(text).toContain("4990/5000");
    expect(text).toContain("An admin must reconnect Linear.");
  });
});
