import { describe, expect, test } from "bun:test";
import {
  expandVariables,
  HYPOTENUSE_SERVER_NAME,
  turnMcpServers,
  UnsetVariableError,
} from "../../src/acp/mcp-servers";
import type { RoleConfig } from "../../src/config/schema";

/**
 * A role's `extra_mcp_servers` at turn start: variables from the daemon's
 * environment, the HTTP capability gate, the reserved name, and the built-in
 * `hypotenuse` server first. (`config validate`'s checks of the same table —
 * the reserved name, the Linear MCP warning, unset variables — are in
 * `validate.test.ts`.)
 */

/** A role with these extra servers. */
function role(extra: RoleConfig["extra_mcp_servers"]): RoleConfig {
  return { extra_mcp_servers: extra } as RoleConfig;
}

const hypotenuse = {
  command: "/usr/local/bin/hypotenuse",
  args: ["mcp", "--session", "7", "--nonce", "abc"],
  env: { HYPOTENUSE_STATE_DIR: "/state" },
};

describe("variables", () => {
  test("$VAR and ${VAR} come from the daemon's environment", () => {
    expect(
      expandVariables("s", "Bearer ${TOKEN} for $USER_NAME", {
        TOKEN: "t0k",
        USER_NAME: "mario",
      }),
    ).toBe("Bearer t0k for mario");
  });

  test("an unset variable fails naming it, never a value", () => {
    const servers = role([
      {
        name: "sentry",
        command: ["/bin/sentry-mcp"],
        env: { SENTRY_AUTH_TOKEN: "$SENTRY_AUTH_TOKEN", OTHER: "$SECRET_SET" },
      },
    ]);
    let error: unknown;
    try {
      turnMcpServers(servers, {}, { SECRET_SET: "hunter2" }, null);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(UnsetVariableError);
    expect((error as Error).message).toContain("$SENTRY_AUTH_TOKEN");
    expect((error as Error).message).not.toContain("hunter2");
  });
});

describe("the servers a turn gets", () => {
  test("hypotenuse first, then the extras, a stdio command made absolute", () => {
    const { servers, skipped } = turnMcpServers(
      role([{ name: "tools", command: ["sh", "-c", "x"], env: { A: "$A" } }]),
      {},
      { A: "1", PATH: "/usr/bin:/bin" },
      hypotenuse,
    );
    expect(skipped).toEqual([]);
    expect(servers.map((s) => s.name)).toEqual([
      HYPOTENUSE_SERVER_NAME,
      "tools",
    ]);
    expect(servers[0]).toEqual({
      name: "hypotenuse",
      command: "/usr/local/bin/hypotenuse",
      args: ["mcp", "--session", "7", "--nonce", "abc"],
      env: [{ name: "HYPOTENUSE_STATE_DIR", value: "/state" }],
    });
    expect((servers[1] as { command: string }).command).toMatch(/^\/.*\/sh$/);
    expect((servers[1] as { env: unknown }).env).toEqual([
      { name: "A", value: "1" },
    ]);
  });

  test("an HTTP server needs the agent's http capability, else it is skipped", () => {
    const docs = role([
      {
        name: "docs",
        url: "https://mcp.example.com/mcp",
        headers: { Authorization: "Bearer $DOCS_TOKEN" },
      },
    ]);
    const without = turnMcpServers(docs, {}, { DOCS_TOKEN: "d" }, null);
    expect(without.servers).toEqual([]);
    expect(without.skipped).toEqual(["docs"]);
    const withHttp = turnMcpServers(
      docs,
      { mcpCapabilities: { http: true } },
      { DOCS_TOKEN: "d" },
      null,
    );
    expect(withHttp.servers).toEqual([
      {
        type: "http",
        name: "docs",
        url: "https://mcp.example.com/mcp",
        headers: [{ name: "Authorization", value: "Bearer d" }],
      },
    ]);
  });

  test("an extra server named hypotenuse never displaces the built-in one", () => {
    const { servers } = turnMcpServers(
      role([{ name: "hypotenuse", command: ["/bin/evil"] }]),
      {},
      {},
      hypotenuse,
    );
    expect(servers).toHaveLength(1);
    expect((servers[0] as { command: string }).command).toBe(
      "/usr/local/bin/hypotenuse",
    );
  });
});
