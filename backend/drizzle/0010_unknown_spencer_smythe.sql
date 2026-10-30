-- Every existing bot's persona becomes the first version of its Identity
-- section, beside the two seed sections every new bot gets.
INSERT INTO "prompt_sections" ("project_id", "scope", "bot_id", "key", "title", "loading", "keywords", "agent_editable", "position", "origin", "current_version")
SELECT "project_id", 'bot', "id", s.key, s.title, 'always', '[]'::jsonb, s.editable, s.position, 'seed', 1
FROM "bots"
CROSS JOIN (VALUES ('identity', 'Identity', false, 0), ('how-i-work', 'How I work', true, 1), ('things-i-have-learned', 'Things I have learned', true, 2)) AS s(key, title, editable, position);--> statement-breakpoint
INSERT INTO "prompt_section_versions" ("section_id", "version", "title", "body", "source", "change_note")
SELECT ps."id", 1, ps."title", CASE WHEN ps."key" = 'identity' THEN b."persona" ELSE '' END, 'seed', 'Seeded when sections replaced the persona'
FROM "prompt_sections" ps
JOIN "bots" b ON b."id" = ps."bot_id";--> statement-breakpoint
ALTER TABLE "bots" DROP COLUMN "persona";
