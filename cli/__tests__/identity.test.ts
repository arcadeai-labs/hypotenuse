import { describe, expect, test } from "bun:test";
import {
  describeIdentities,
  type ExternalIdentity,
  linkedViaText,
} from "../src/commands/identity";

/**
 * An identity with defaults.
 * @param overrides - Fields to set.
 * @returns The identity.
 */
function identity(overrides: Partial<ExternalIdentity>): ExternalIdentity {
  return {
    id: 7,
    type: "linear",
    integrationId: 1,
    userId: 3,
    user: { name: "Mario", email: "mario@mushroom.kingdom" },
    externalUserId: "lin-user-1",
    externalName: "Mario M",
    externalEmail: "mario@mushroom.kingdom",
    linkedVia: "email",
    createdAt: 0,
    ...overrides,
  };
}

describe("identity rendering", () => {
  test("each way a link is made reads in words", () => {
    expect(linkedViaText("email")).toBe("e-mail match");
    expect(linkedViaText("oauth")).toBe("Linear sign-in");
    expect(linkedViaText("admin")).toBe("admin");
  });

  test("the table names the Linear user, the member, and how", () => {
    const text = describeIdentities([
      identity({}),
      identity({
        id: 8,
        externalName: null,
        externalEmail: null,
        externalUserId: "lin-user-2",
        linkedVia: "admin",
        user: null,
        userId: 9,
      }),
    ]);
    expect(text).toContain("Mario M");
    expect(text).toContain("Mario <mario@mushroom.kingdom>");
    expect(text).toContain("e-mail match");
    expect(text).toContain("lin-user-2");
  });
});
