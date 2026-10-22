import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { HYPOTENUSE_TOOLS, toolByName, toolsForRole } from "../src/tools";

const WORKER = [
  "linear_get_issue",
  "linear_list_comments",
  "linear_comment",
  "linear_set_issue_state",
  "linear_set_plan",
  "linear_ask_user",
  "linear_report_pr",
  "linear_search_issues",
];

describe("the Hypotenuse MCP tools", () => {
  test("a worker gets exactly the eight worker tools", () => {
    expect(toolsForRole("worker").map((t) => t.name)).toEqual(WORKER);
  });

  test("a manager gets all eighteen, the worker's among them", () => {
    const manager = toolsForRole("manager").map((t) => t.name);
    expect(manager).toHaveLength(18);
    for (const name of WORKER) expect(manager).toContain(name);
  });

  test("names, actions, and routes are unique and line up", () => {
    const names = HYPOTENUSE_TOOLS.map((t) => t.name);
    const actions = HYPOTENUSE_TOOLS.map((t) => t.action);
    const routes = HYPOTENUSE_TOOLS.map((t) => t.route);
    expect(new Set(names).size).toBe(18);
    expect(new Set(actions).size).toBe(18);
    expect(new Set(routes).size).toBe(18);
    for (const t of HYPOTENUSE_TOOLS) {
      expect(t.action).toMatch(/^daemon:(linear-[a-z-]+|dispatch)$/);
      expect(t.route.startsWith("/daemon/")).toBe(true);
      expect(toolByName(t.name)).toBe(t as never);
    }
  });

  test("every field is described, and every schema converts to JSON Schema", () => {
    for (const t of HYPOTENUSE_TOOLS) {
      const schema = z.toJSONSchema(t.input) as {
        additionalProperties?: unknown;
        properties: Record<string, { description?: string }>;
      };
      expect(schema.additionalProperties).toBe(false);
      for (const [key, field] of Object.entries(schema.properties)) {
        expect(field.description, `${t.name}.${key}`).toBeTruthy();
      }
    }
  });

  test("a manager cannot name an assignee", () => {
    const update = toolByName("linear_update_issue")!;
    expect(
      update.input.safeParse({ issue: "ENG-1", assigneeId: "u" }).success,
    ).toBe(false);
  });
});
