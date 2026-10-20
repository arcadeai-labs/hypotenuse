import { describe, expect, test } from "bun:test";
import { availableCommands, COMMANDS } from "../commands/registry";
import type { Permissions } from "../context/AuthContext";
import { can, type ProjectStanding } from "../utils/permissions";

const ADMIN: ProjectStanding = { isMember: true, isAdmin: true };
const MEMBER: ProjectStanding = { isMember: true, isAdmin: false };
const OUTSIDER: ProjectStanding = { isMember: false, isAdmin: false };

/** The `actions:permissions` map, as far as these tests care about it. */
const PERMISSIONS = {
  status: { type: "none" },
  "project:view": { type: "member" },
  "invite:create": { type: "admin" },
  "audit:list": { type: "admin" },
} as unknown as Permissions;

describe("can()", () => {
  test("follows the backend's requirement for each level", () => {
    for (const standing of [ADMIN, MEMBER, OUTSIDER]) {
      expect(can(PERMISSIONS, "status", standing)).toBe(true);
      expect(can(PERMISSIONS, "project:view", standing)).toBe(
        standing.isMember,
      );
      expect(can(PERMISSIONS, "audit:list", standing)).toBe(standing.isAdmin);
    }
  });

  test("an unloaded map or an unknown action is gated, even for an admin", () => {
    // Showing a control that 403s is worse than briefly hiding one.
    expect(can(null, "status", ADMIN)).toBe(false);
    expect(can(PERMISSIONS, "no:such-action", ADMIN)).toBe(false);
  });

  test("an unrecognised level is gated rather than granted", () => {
    const odd = { "x:y": { type: "owner" } } as unknown as Permissions;
    expect(can(odd, "x:y", ADMIN)).toBe(false);
  });
});

describe("gated palette commands", () => {
  /**
   * The ids the palette offers for a standing.
   * @param standing - The caller's standing, or `null` while unknown.
   * @returns Command ids, sorted.
   */
  function offered(standing: ProjectStanding | null): string[] {
    return availableCommands(COMMANDS, {
      navigate: () => {},
      setTheme: () => {},
      toggleSidebar: () => {},
      showShortcuts: () => {},
      focusSearch: () => {},
      may: (action) => standing !== null && can(PERMISSIONS, action, standing),
    }).map((command) => command.id);
  }

  test("an admin is offered invite and audit", () => {
    expect(offered(ADMIN)).toEqual(
      expect.arrayContaining(["invite-member", "open-audit-log"]),
    );
  });

  test("a member, and anyone whose standing is still unknown, is not", () => {
    for (const standing of [MEMBER, null]) {
      expect(offered(standing)).not.toContain("invite-member");
      expect(offered(standing)).not.toContain("open-audit-log");
    }
  });
});
