import { describe, expect, test } from "bun:test";
import { projectRole } from "../utils/projectRole";

describe("projectRole", () => {
  test("names each standing the server can answer", () => {
    expect(
      projectRole({
        isMember: true,
        isAdmin: false,
        viaOrganizationOwner: false,
      }),
    ).toMatchObject({ label: "Member", admin: false });
    expect(
      projectRole({
        isMember: true,
        isAdmin: true,
        viaOrganizationOwner: false,
      }),
    ).toMatchObject({ label: "Admin", admin: true });
    expect(
      projectRole({
        isMember: true,
        isAdmin: true,
        viaOrganizationOwner: true,
      }),
    ).toMatchObject({ label: "Admin (owner)", admin: true });
  });

  test("an owner's standing says where it comes from", () => {
    expect(
      projectRole({ isMember: true, isAdmin: true, viaOrganizationOwner: true })
        .title,
    ).toContain("own this organization");
  });
});
