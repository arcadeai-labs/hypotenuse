import { describe, expect, test } from "bun:test";
import {
  connectFinished,
  describeInstallation,
  type LinearInstallation,
} from "../src/commands/linear";

/** An active installation, with overrides. */
function installation(
  over: Partial<LinearInstallation> = {},
): LinearInstallation {
  return {
    id: 1,
    projectId: 7,
    organizationId: "org-1",
    organizationName: "Workspace 1",
    urlKey: "eng",
    appUserId: "app-1",
    appUserName: "Hypotenuse",
    scopes: ["read", "write"],
    status: "active",
    accessTokenLastFour: "abcd",
    accessTokenExpiresAt: null,
    lastRefreshedAt: null,
    refreshError: null,
    teamIds: ["team-1"],
    rateLimit: null,
    updatedAt: 1_000,
    ...over,
  };
}

describe("linear connect's wait", () => {
  test("finishes only when the installation is active and changed since it started", () => {
    expect(connectFinished(null, null)).toBe(false);
    expect(connectFinished(installation(), null)).toBe(true);
    // Unchanged since connect started: the old connection, not the new one.
    expect(connectFinished(installation(), 1_000)).toBe(false);
    expect(connectFinished(installation({ updatedAt: 2_000 }), 1_000)).toBe(
      true,
    );
    // A refused reconnect leaves an errored or revoked row as it was.
    expect(
      connectFinished(
        installation({ status: "error", updatedAt: 2_000 }),
        1_000,
      ),
    ).toBe(false);
    expect(
      connectFinished(
        installation({ status: "revoked", updatedAt: 2_000 }),
        1_000,
      ),
    ).toBe(false);
  });
});

describe("linear status's rendering", () => {
  test("says how to connect, and why it cannot when the server has no Linear app", () => {
    expect(
      describeInstallation({ installation: null, configured: true }),
    ).toContain("hypotenuse linear connect");
    expect(
      describeInstallation({ installation: null, configured: false }),
    ).toContain("no Linear app configured");
    expect(
      describeInstallation({
        installation: installation({ status: "revoked" }),
        configured: true,
      }),
    ).toContain("Not connected");
  });

  test("shows the workspace, the app user, the token's last four, and any refresh error", () => {
    const text = describeInstallation({
      installation: installation({
        status: "error",
        refreshError: "An admin must reconnect Linear.",
        rateLimit: { requestsLimit: 5000, requestsRemaining: 4990 },
      }),
      configured: true,
    });
    expect(text).toContain("Workspace 1 (eng)");
    expect(text).toContain("Hypotenuse (app-1)");
    expect(text).toContain("…abcd");
    expect(text).toContain("4990/5000");
    expect(text).toContain("An admin must reconnect Linear.");
  });
});
