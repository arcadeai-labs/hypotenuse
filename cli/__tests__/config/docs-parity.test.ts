import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { leafKeys } from "../../src/config/introspect";
import { AGENT_PRESETS } from "../../src/config/presets";
import { ConfigSchema } from "../../src/config/schema";
import { PROMPT_VARIABLES } from "../../src/config/validate";

/**
 * `docs/CONFIG.md` is the reference for the config file and the schema is its
 * source of truth: every leaf key in the schema has a row in one of the doc's
 * key tables, and every row names a key the schema has.
 */

const DOC = readFileSync(
  join(import.meta.dir, "..", "..", "..", "docs", "CONFIG.md"),
  "utf8",
);

/** Each key table's section, by the heading (or bold line) above it. */
const SECTIONS: Record<string, string> = {
  "## Top level": "",
  "## `[server]`": "server",
  "## `[runner]`": "runner",
  "## `[subscriptions]`": "subscriptions",
  "## `[agents.<id>]`": "agents.*",
  "## Roles": "roles.*",
  "**`extra_mcp_servers` entries**": "roles.*.extra_mcp_servers[]",
  "## `[[repositories]]`": "repositories[]",
  "## `[sessions]`": "sessions",
  "## `[log]`": "log",
};

/**
 * The keys documented in tables whose header row starts with `| Key |`.
 * @returns Dotted keys, sections joined.
 */
function documentedKeys(): string[] {
  const keys: string[] = [];
  let section: string | undefined;
  let inKeyTable = false;
  for (const line of DOC.split("\n")) {
    const heading = Object.keys(SECTIONS).find((h) => line.trim() === h);
    if (heading !== undefined) {
      section = SECTIONS[heading];
      inKeyTable = false;
      continue;
    }
    if (line.startsWith("## ") || line.startsWith("### ")) {
      section = undefined;
      continue;
    }
    if (!line.startsWith("|")) {
      inKeyTable = false;
      continue;
    }
    if (/^\|\s*Key\s*\|/.test(line)) {
      inKeyTable = section !== undefined;
      continue;
    }
    if (!inKeyTable || /^\|\s*-/.test(line)) continue;
    const key = /^\|\s*`([^`]+)`/.exec(line)?.[1];
    if (key) keys.push(section ? `${section}.${key}` : key);
  }
  return keys;
}

describe("docs/CONFIG.md ⇄ the schema", () => {
  test("the documented keys equal the schema's leaf keys", () => {
    const leaves = leafKeys(ConfigSchema).map((k) =>
      k.replace(/^roles\.(manager|worker)\./, "roles.*."),
    );
    // A table's own array-of-tables key has a row too (`extra_mcp_servers`).
    const nested = leaves.flatMap((k) => /^(.+\..+)\[\]\./.exec(k)?.[1] ?? []);
    const schemaKeys = [...leaves, ...nested];
    expect([...new Set(documentedKeys())].sort()).toEqual(
      [...new Set(schemaKeys)].sort(),
    );
  });

  test("every preset is in the presets table with its command", () => {
    for (const [name, preset] of Object.entries(AGENT_PRESETS)) {
      expect(DOC).toContain(
        `| \`${name}\` | \`${preset.command.join(" ")}\` |`,
      );
    }
  });

  test("every prompt variable is documented", () => {
    for (const variable of PROMPT_VARIABLES)
      expect(DOC).toContain(`\`${variable}\``);
  });
});
