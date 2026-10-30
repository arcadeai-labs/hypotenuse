import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import path from "node:path";
import { sql } from "drizzle-orm";
import { api } from "keryx";
import { buildTestUniverse, HOOK_TIMEOUT, type TestUniverse } from "../setup";

/**
 * The migration that replaced `bots.persona` with prompt sections: run its
 * data statements against a bot as it stood before (a persona column, no
 * sections), inside a transaction that is rolled back.
 */
let u: TestUniverse;

beforeAll(async () => {
  u = await buildTestUniverse();
}, HOOK_TIMEOUT);

afterAll(async () => {
  await api.stop();
}, HOOK_TIMEOUT);

/** Thrown to roll the transaction back once the assertions ran. */
class Rollback extends Error {}

describe("persona → seed sections", () => {
  test("an existing bot gets Identity with its persona, and two empty editable sections", async () => {
    const dir = path.join(import.meta.dir, "..", "..", "drizzle");
    const file = [...new Bun.Glob("0010_*.sql").scanSync(dir)][0];
    const statements = (await Bun.file(path.join(dir, file)).text())
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter((s) => s && !/DROP COLUMN "persona"/.test(s));
    expect(statements).toHaveLength(2);

    let rows: Record<string, unknown>[] = [];
    await api.db.db
      .transaction(async (tx) => {
        await tx.execute(sql`ALTER TABLE bots ADD COLUMN persona text`);
        await tx.execute(
          sql`INSERT INTO bots (project_id, name, slug, display_name, persona) VALUES (${u.projectId}, 'Legacy', 'legacy', 'Legacy', 'I predate sections.')`,
        );
        // Only the legacy bot: every other bot already has its sections.
        await tx.execute(
          sql`DELETE FROM prompt_sections WHERE bot_id IN (SELECT id FROM bots WHERE slug <> 'legacy')`,
        );
        for (const statement of statements)
          await tx.execute(sql.raw(statement));
        const result = await tx.execute(sql`
          SELECT ps.key, ps.title, ps.loading, ps.agent_editable, ps.origin, ps.current_version, v.body, v.source
          FROM prompt_sections ps
          JOIN prompt_section_versions v ON v.section_id = ps.id AND v.version = 1
          JOIN bots b ON b.id = ps.bot_id
          WHERE b.slug = 'legacy'
          ORDER BY ps.position`);
        rows = result.rows as Record<string, unknown>[];
        throw new Rollback();
      })
      .catch((error) => {
        if (!(error instanceof Rollback)) throw error;
      });

    expect(rows).toEqual([
      {
        key: "identity",
        title: "Identity",
        loading: "always",
        agent_editable: false,
        origin: "seed",
        current_version: 1,
        body: "I predate sections.",
        source: "seed",
      },
      {
        key: "how-i-work",
        title: "How I work",
        loading: "always",
        agent_editable: true,
        origin: "seed",
        current_version: 1,
        body: "",
        source: "seed",
      },
      {
        key: "things-i-have-learned",
        title: "Things I have learned",
        loading: "always",
        agent_editable: true,
        origin: "seed",
        current_version: 1,
        body: "",
        source: "seed",
      },
    ]);
  });
});
