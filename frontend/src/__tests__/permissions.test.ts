import { describe, expect, test } from "bun:test";
import {
  can,
  denialReason,
  NO_ORGANIZATION_STANDING,
  NO_PROJECT_STANDING,
  type Permissions,
  type Standings,
  verdict,
} from "../utils/permissions";

/** One action per level, as `actions:permissions` reports them. */
const PERMISSIONS: Permissions = {
  "me:view": { type: "none" },
  "tag:list": { type: "member" },
  "tag:create": { type: "admin" },
  "organization:view": { type: "org-member" },
  "project:create": { type: "org-owner" },
};

const MEMBER = { isMember: true, isAdmin: false, viaOrganizationOwner: false };
const ADMIN = { isMember: true, isAdmin: true, viaOrganizationOwner: false };
const OWNER_ADMIN = {
  isMember: true,
  isAdmin: true,
  viaOrganizationOwner: true,
};
const ORG_MEMBER = { isMember: true, isOwner: false };
const ORG_OWNER = { isMember: true, isOwner: true };

/**
 * Both standings, known.
 * @param project - The project standing.
 * @param organization - The organization standing.
 * @returns The pair.
 */
const known = (
  project: Standings["project"],
  organization: Standings["organization"],
): Standings => ({ project, organization });

describe("verdict", () => {
  test("every level, against every standing that answers it", () => {
    const rows: Array<[string, Standings, string]> = [
      [
        "me:view",
        known(NO_PROJECT_STANDING, NO_ORGANIZATION_STANDING),
        "allowed",
      ],
      ["tag:list", known(MEMBER, ORG_MEMBER), "allowed"],
      ["tag:list", known(NO_PROJECT_STANDING, ORG_MEMBER), "denied"],
      ["tag:create", known(MEMBER, ORG_MEMBER), "denied"],
      ["tag:create", known(ADMIN, ORG_MEMBER), "allowed"],
      // An organization owner's admin standing is the server's to report.
      ["tag:create", known(OWNER_ADMIN, ORG_OWNER), "allowed"],
      ["organization:view", known(NO_PROJECT_STANDING, ORG_MEMBER), "allowed"],
      [
        "organization:view",
        known(NO_PROJECT_STANDING, NO_ORGANIZATION_STANDING),
        "denied",
      ],
      ["project:create", known(ADMIN, ORG_MEMBER), "denied"],
      ["project:create", known(NO_PROJECT_STANDING, ORG_OWNER), "allowed"],
    ];
    for (const [action, standings, expected] of rows) {
      expect(verdict(PERMISSIONS, action, standings), action).toBe(
        expected as ReturnType<typeof verdict>,
      );
    }
  });

  test("a level whose standing has not answered is unresolved, never denied", () => {
    const nothingKnown = known(null, null);
    expect(verdict(PERMISSIONS, "tag:list", nothingKnown)).toBe("unresolved");
    expect(verdict(PERMISSIONS, "tag:create", nothingKnown)).toBe("unresolved");
    expect(verdict(PERMISSIONS, "organization:view", nothingKnown)).toBe(
      "unresolved",
    );
    expect(verdict(PERMISSIONS, "project:create", nothingKnown)).toBe(
      "unresolved",
    );
    // `none` needs no standing at all.
    expect(verdict(PERMISSIONS, "me:view", nothingKnown)).toBe("allowed");
    // Only the standing the level reads matters: a known project standing
    // does not resolve an organization-level action.
    expect(verdict(PERMISSIONS, "project:create", known(ADMIN, null))).toBe(
      "unresolved",
    );
    expect(verdict(PERMISSIONS, "tag:create", known(null, ORG_OWNER))).toBe(
      "unresolved",
    );
  });

  test("before the permission map loads, everything is unresolved", () => {
    expect(verdict(null, "tag:create", known(MEMBER, ORG_MEMBER))).toBe(
      "unresolved",
    );
  });

  test("an action the server does not have is denied", () => {
    expect(verdict(PERMISSIONS, "no:such", known(ADMIN, ORG_OWNER))).toBe(
      "denied",
    );
  });
});

describe("can", () => {
  test("offers what is allowed and what is unresolved; withholds only a refusal", () => {
    expect(can(PERMISSIONS, "tag:create", known(ADMIN, ORG_MEMBER))).toBe(true);
    expect(can(PERMISSIONS, "tag:create", known(null, null))).toBe(true);
    expect(can(null, "tag:create", known(null, null))).toBe(true);
    expect(can(PERMISSIONS, "tag:create", known(MEMBER, ORG_MEMBER))).toBe(
      false,
    );
  });
});

describe("denialReason", () => {
  test("names who may, from the action's level", () => {
    expect(denialReason(PERMISSIONS, "tag:list")).toBe(
      "Only members of this project can do this.",
    );
    expect(denialReason(PERMISSIONS, "tag:create")).toBe(
      "Only project admins can do this.",
    );
    expect(denialReason(PERMISSIONS, "organization:view")).toBe(
      "Only members of this organization can do this.",
    );
    expect(denialReason(PERMISSIONS, "project:create")).toBe(
      "Only organization owners can do this.",
    );
    expect(denialReason(PERMISSIONS, "no:such")).toBe("Not available.");
  });

  test("never names a plan or a level by its wire name", () => {
    for (const action of Object.keys(PERMISSIONS)) {
      expect(denialReason(PERMISSIONS, action)).not.toMatch(
        /phase|org-owner|org-member/i,
      );
    }
  });
});
