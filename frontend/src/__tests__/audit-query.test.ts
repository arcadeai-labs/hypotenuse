import { describe, expect, test } from "bun:test";
import {
  auditQuery,
  NO_FILTERS,
  ORGANIZATION_ONLY,
} from "../components/audit/AuditLogView";

describe("auditQuery", () => {
  test("no filters asks for the page and nothing else", () => {
    expect(auditQuery(NO_FILTERS, 3)).toBe("page=3&limit=25");
  });

  test("dates are whole local days, sent as epoch milliseconds", () => {
    const query = new URLSearchParams(
      auditQuery(
        { ...NO_FILTERS, since: "2026-03-01", until: "2026-03-02" },
        1,
      ),
    );
    expect(Number(query.get("since"))).toBe(
      new Date(2026, 2, 1, 0, 0, 0, 0).getTime(),
    );
    expect(Number(query.get("until"))).toBe(
      new Date(2026, 2, 2, 23, 59, 59, 999).getTime(),
    );
  });

  test("each filter is sent only when set", () => {
    const query = new URLSearchParams(
      auditQuery(
        {
          ...NO_FILTERS,
          action: "tag:edit",
          actorType: "participant",
          projectId: "7",
        },
        1,
      ),
    );
    expect(query.get("action")).toBe("tag:edit");
    expect(query.get("actorType")).toBe("participant");
    expect(query.get("projectId")).toBe("7");
    expect(query.has("since")).toBe(false);
  });

  test("organization only asks for the rows of no project, not a project id", () => {
    const query = new URLSearchParams(
      auditQuery({ ...NO_FILTERS, projectId: ORGANIZATION_ONLY }, 1),
    );
    expect(query.get("organizationOnly")).toBe("true");
    expect(query.has("projectId")).toBe(false);
  });
});
