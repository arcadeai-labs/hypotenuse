import { describe, expect, test } from "bun:test";
import { pickActive } from "../utils/activeSelection";
import { validateAuthFields } from "../utils/authForm";
import { inviteState } from "../utils/invites";

describe("pickActive", () => {
  test("keeps a remembered id that is still a choice", () => {
    expect(pickActive(7, [3, 7, 9])).toBe(7);
  });

  test("heals a stale id onto the first choice", () => {
    // Left, deleted, or remembered from another account.
    expect(pickActive(42, [3, 7])).toBe(3);
    expect(pickActive(null, [3, 7])).toBe(3);
  });

  test("no choices, no selection", () => {
    expect(pickActive(7, [])).toBeNull();
    expect(pickActive(null, [])).toBeNull();
  });
});

describe("validateAuthFields", () => {
  test("holds the same limits the server does", () => {
    expect(
      validateAuthFields(
        { email: "a@b.co", password: "12345678", name: "Ada" },
        true,
      ),
    ).toEqual({});
    const errors = validateAuthFields(
      { email: "nope", password: "short", name: "Al" },
      true,
    );
    expect(Object.keys(errors).sort()).toEqual(["email", "name", "password"]);
  });

  test("sign-in asks for no name", () => {
    expect(
      validateAuthFields({ email: "a@b.co", password: "12345678" }),
    ).toEqual({});
  });
});

describe("inviteState", () => {
  const now = 1_000_000;
  test("an answered invite says how it was answered", () => {
    expect(inviteState({ status: "accepted", expiresAt: 0 }, now)).toBe(
      "accepted",
    );
    expect(inviteState({ status: "rejected", expiresAt: 0 }, now)).toBe(
      "rejected",
    );
  });

  test("a pending invite past its expiry is expired", () => {
    expect(inviteState({ status: "pending", expiresAt: now + 1 }, now)).toBe(
      "pending",
    );
    expect(inviteState({ status: "pending", expiresAt: now }, now)).toBe(
      "expired",
    );
  });
});
