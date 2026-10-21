import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseConfigText } from "../../src/config/loader";
import { configJsonSchema } from "../../src/config/schema";
import { validateReferences } from "../../src/config/validate";

/**
 * What the config ships beside the CLI: the JSON Schema the `#:schema` line of
 * every generated file points at (served by the public site), and the
 * complete example in `docs/CONFIG.md`, kept as `examples/config.toml`.
 */

const ROOT = join(import.meta.dir, "..", "..", "..");

describe("published config artifacts", () => {
  test("frontend/public/schemas/config-v1.json is `hypotenuse config schema`", () => {
    const published = JSON.parse(
      readFileSync(
        join(ROOT, "frontend", "public", "schemas", "config-v1.json"),
        "utf8",
      ),
    );
    // Regenerate with: bun run --cwd cli hypotenuse config schema > frontend/public/schemas/config-v1.json
    expect(published).toEqual(JSON.parse(JSON.stringify(configJsonSchema())));
  });

  test("examples/config.toml is CONFIG.md's complete example, and it is valid", () => {
    const example = readFileSync(
      join(ROOT, "cli", "examples", "config.toml"),
      "utf8",
    );
    expect(readFileSync(join(ROOT, "docs", "CONFIG.md"), "utf8")).toContain(
      `\`\`\`toml\n${example}\`\`\``,
    );
    const ctx = {
      baseDir: "/home/evan/.config/hypotenuse",
      env: { HOME: "/home/evan" },
      cpuCount: 8,
      hostname: "evan-mbp",
    };
    const { config, issues } = parseConfigText(
      example,
      `${ctx.baseDir}/config.toml`,
      ctx,
    );
    expect(issues).toEqual([]);
    expect(validateReferences(config!).errors).toEqual([]);
  });
});
